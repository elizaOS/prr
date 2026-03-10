/**
 * split-plan runner: fetch PR data, build prompt, call LLM, return plan content.
 * WHY separate from index: Same pattern as story; index handles CLI and I/O, run handles GitHub + LLM + plan formatting.
 */
import ora from 'ora';
import type { Config } from '../../shared/config.js';
import type { SplitPlanOptions } from './cli.js';
import type { PRInfo } from '../prr/github/types.js';
import { GitHubAPI } from '../prr/github/api.js';
import { parsePRUrl } from '../prr/github/types.js';
import { LLMClient } from '../prr/llm/client.js';
import { debug, formatNumber } from '../../shared/logger.js';

/**
 * Files that eat patch budget without helping reason about concerns.
 * WHY hardcoded: YAGNI; we don't need a config option for this. Lockfiles and minified assets are universal low-signal.
 */
const LOW_SIGNAL_FILES = [
  'package-lock.json',
  'bun.lock',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.min.js',
  '.min.css',
];

/** WHY .endsWith('.lock'): Catches any lockfile not in the list (e.g. Cargo.lock, poetry.lock). */
function isLowSignalFile(filename: string): boolean {
  if (LOW_SIGNAL_FILES.some(name => filename === name || filename.endsWith(name))) return true;
  if (filename.endsWith('.lock')) return true;
  return false;
}

export interface FileWithPatch {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | undefined;
}

export interface PatchBudgetResult {
  included: Array<FileWithPatch & { patchIncluded: boolean }>;
  omitted: Array<FileWithPatch>;
  totalPatchChars: number;
}

/**
 * Apply patch budget: sort by change size, include patches until budget exhausted.
 * WHY sort by additions+deletions: Change magnitude matters for which files need patch content; patch may be missing for binary files so we can't sort by patch.length. Files without a patch are still "included" with patchIncluded: false so they appear in the prompt as metadata.
 */
export function applyPatchBudget(
  files: FileWithPatch[],
  maxPatchChars: number
): PatchBudgetResult {
  const sorted = [...files].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
  const included: Array<FileWithPatch & { patchIncluded: boolean }> = [];
  const omitted: Array<FileWithPatch> = [];
  let totalPatchChars = 0;
  for (const f of sorted) {
    const patchLen = f.patch?.length ?? 0;
    const withinBudget = totalPatchChars + patchLen <= maxPatchChars;
    if (withinBudget && f.patch) {
      included.push({ ...f, patchIncluded: true });
      totalPatchChars += patchLen;
    } else if (withinBudget && !f.patch) {
      included.push({ ...f, patchIncluded: false });
    } else {
      omitted.push(f);
    }
  }
  return { included, omitted, totalPatchChars };
}

export async function runSplitPlan(
  prUrl: string,
  config: Config,
  options: SplitPlanOptions
): Promise<string> {
  const github = new GitHubAPI(config.githubToken);
  const spinner = ora();

  const { owner, repo, number } = parsePRUrl(prUrl);

  // WHY Promise.all: Three independent API calls; parallel fetch reduces latency.
  spinner.start('Fetching PR info...');
  const [prInfo, commits, filesWithPatches] = await Promise.all([
    github.getPRInfo(owner, repo, number),
    github.getPRCommits(owner, repo, number),
    github.getPRFilesWithPatches(owner, repo, number),
  ]);
  spinner.succeed(`PR: ${prInfo.title}`);

  // WHY baseBranch: Only PRs targeting the same base are valid "buckets"; branch topology (v2 vs v3) matters.
  spinner.start('Fetching open PRs...');
  let openPRs = await github.getOpenPRs(owner, repo, prInfo.baseBranch, number);
  openPRs = openPRs.slice(0, 20).map(p => ({
    ...p,
    body: p.body.slice(0, 500) + (p.body.length > 500 ? '…' : ''),
  }));
  // WHY formatNumber: Workspace rule — user-visible counts use locale formatting (e.g. 1,234).
  spinner.succeed(`${formatNumber(openPRs.length)} open PRs on ${prInfo.baseBranch}`);

  // WHY separate code vs low-signal: Code files get patch budget; low-signal files still appear in the prompt as metadata (omitted list) so the LLM knows they changed but we don't spend patch budget on them.
  const codeFiles = filesWithPatches.filter(f => !isLowSignalFile(f.filename));
  const lowSignalFiles = filesWithPatches.filter(f => isLowSignalFile(f.filename));
  const filesWithBudget = applyPatchBudget(codeFiles, options.maxPatchChars);
  for (const f of lowSignalFiles) {
    filesWithBudget.omitted.push(f);
  }
  const prFileList = filesWithPatches.map(f => f.filename);

  if (options.verbose) {
    debug('split-plan data', {
      commits: commits.length,
      filesTotal: filesWithPatches.length,
      filesIncluded: filesWithBudget.included.length,
      filesOmitted: filesWithBudget.omitted.length,
      totalPatchChars: filesWithBudget.totalPatchChars,
      openPRs: openPRs.length,
    });
  }

  const llm = new LLMClient(config);
  const planContent = await buildPlanContent(prInfo, commits, filesWithBudget, prFileList, openPRs, llm, config);
  return planContent;
}

async function buildPlanContent(
  prInfo: PRInfo,
  commits: Array<{ sha: string; message: string; authoredDate: Date }>,
  filesWithBudget: PatchBudgetResult,
  prFileList: string[],
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>,
  llm: LLMClient,
  config: Config
): Promise<string> {
  const userPrompt = buildUserPrompt(prInfo, commits, filesWithBudget, openPRs);
  const systemPrompt = getSystemPrompt();

  const spinner = ora();
  spinner.start('Building split plan...');
  const response = await llm.complete(userPrompt, systemPrompt, { model: config.llmModel });
  spinner.succeed('Done');

  const raw = response.content.trim();
  // WHY postProcessPlan: LLM may output bad frontmatter or hallucinate file paths; we validate/repair and append a Validation section for unknown paths.
  return postProcessPlan(raw, prInfo, prFileList);
}

/** WHY two-phase in system prompt: If we only ask "split this PR," the model groups by file proximity and ignores dependencies. Forcing Phase 1 (dependencies) before Phase 2 (grouping) makes dependency order a hard constraint. */
function getSystemPrompt(): string {
  return `You are a senior engineer decomposing a large pull request into smaller, focused PRs. You will perform TWO phases of analysis:

PHASE 1 — DEPENDENCY ANALYSIS
Before proposing any split, identify which changes depend on which other changes. A depends on B if:
- B introduces a function/type/variable that A calls/uses
- B modifies an interface/schema that A implements/queries
- B restructures code (moves, renames) that A builds on
- B and A modify the same function/block (interleaved changes)

Output dependencies as: "file:change -> depends on -> file:change"

Dependencies CONSTRAIN the split: dependent changes must either be in the same PR, or in a PR that merges BEFORE the dependent PR.

PHASE 2 — SPLIT PLAN
Group changes into PRs where each PR is a complete working unit. Rules:
- Each PR does ONE thing (one concern, not one file)
- Tests belong WITH the feature they test, not in a separate "tests" PR
- Pure refactors that enable a feature = separate PR, merge first
- Config/infra that multiple features need = separate foundational PR
- Don't split to reduce size. Split to reduce cognitive load.
- If an existing open PR covers the same concern, route changes there
- Record source and target branches for each proposed split

Output the plan in the EXACT markdown format shown below (with YAML frontmatter). The human will edit this file, so make it clear and readable.

Use this structure:

---
source_pr: <url of the PR>
source_branch: <head branch name>
target_branch: <base branch name>
generated_at: <ISO8601>
---

# Split Plan for PR #<number>: <title>

## Dependencies

- \`fileA\` (change description) <- \`fileB\` (why it depends)
- or: No cross-file dependencies identified.

## Split

### 1. <Short title>
- **Route to:** PR #N (title) — rationale
  OR **New PR:** \`branch-name\`
- **Source branch:** ...
- **Target branch:** ...
- **Depends on:** ... or nothing
- **Files:**
  - path/to/file1
  - path/to/file2
- **Commits:** sha1, sha2
- **Why one unit:** ...

### 2. ...

## Merge order

1. Split 1 — ...
2. ...
`;
}

function buildUserPrompt(
  prInfo: PRInfo,
  commits: Array<{ sha: string; message: string; authoredDate: Date }>,
  filesWithBudget: PatchBudgetResult,
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>
): string {
  // WHY 500: Long multi-line commit messages blow prompt size; first line plus date is enough for the LLM to infer intent (same as story).
  const MAX_COMMIT_MSG = 500;
  const commitLines = commits.map(c => {
    const firstLine = c.message.split('\n')[0] ?? '';
    const msg = firstLine.length <= MAX_COMMIT_MSG ? firstLine : firstLine.slice(0, MAX_COMMIT_MSG) + '…';
    return `- ${c.sha.slice(0, 7)} (${c.authoredDate.toISOString().slice(0, 10)}): ${msg}`;
  });

  const totalAdditions = filesWithBudget.included.reduce((s, f) => s + f.additions, 0) +
    filesWithBudget.omitted.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = filesWithBudget.included.reduce((s, f) => s + f.deletions, 0) +
    filesWithBudget.omitted.reduce((s, f) => s + f.deletions, 0);
  const totalFiles = filesWithBudget.included.length + filesWithBudget.omitted.length;

  const fileLines: string[] = [];
  for (const f of filesWithBudget.included) {
    fileLines.push(`  ${f.status.padEnd(8)} ${f.filename} (+${f.additions}/-${f.deletions})`);
    if (f.patchIncluded && f.patch) {
      fileLines.push('```diff');
      fileLines.push(f.patch);
      fileLines.push('```');
    } else if (!f.patch) {
      fileLines.push('  [patch omitted — no patch from API]');
    }
  }
  for (const f of filesWithBudget.omitted) {
    const reason = isLowSignalFile(f.filename) ? 'lockfile/generated' : 'budget exceeded';
    fileLines.push(`  ${f.status.padEnd(8)} ${f.filename} (+${f.additions}/-${f.deletions}) [patch omitted — ${reason}]`);
  }

  // WHY (none) when empty: So the LLM explicitly sees there are no buckets to route to, instead of a blank section.
  const openPRLines = openPRs.length > 0
    ? openPRs.map(p =>
      `  #${p.number}: "${p.title}" (branch: ${p.branch}, by @${p.author})\n    Description: ${p.body}`
    ).join('\n\n')
    : '  (none)';

  return `Target PR: #${prInfo.number} "${prInfo.title}"
Branch: ${prInfo.branch} -> ${prInfo.baseBranch}
Description:
${prInfo.body || '(no description)'}

Commits (${commits.length} total, chronological):
${commitLines.join('\n')}

Files changed (${totalFiles} total; +${totalAdditions}/-${totalDeletions}). Patches included for ${filesWithBudget.included.filter(f => f.patchIncluded).length} files; ${filesWithBudget.omitted.length} omitted (budget exceeded).
${fileLines.join('\n')}

Open PRs targeting ${prInfo.baseBranch} (available buckets; showing up to 20):
${openPRLines}

Produce the split plan now. Phase 1 (dependencies) first, then Phase 2 (split plan).`;
}

/**
 * Extract frontmatter and body, validate/repair frontmatter, run file validation, return final plan string.
 * WHY we always set generated_at in code: Don't rely on the LLM to output valid ISO8601; we own the timestamp.
 */
function postProcessPlan(
  raw: string,
  prInfo: PRInfo,
  prFileList: string[]
): string {
  const prFileSet = new Set(prFileList);
  let body: string;
  let frontmatter: string;
  const firstDash = raw.indexOf('---');
  const secondDash = firstDash >= 0 ? raw.indexOf('---', firstDash + 3) : -1;
  const generatedAt = new Date().toISOString();
  if (firstDash >= 0 && secondDash > firstDash) {
    const yaml = raw.slice(firstDash + 3, secondDash).trim();
    body = raw.slice(secondDash + 3).trim();
    try {
      const parsed = parseSimpleFrontmatter(yaml);
      frontmatter = buildFrontmatter(prInfo, generatedAt, parsed);
    } catch {
      // WHY fallback: LLM may output unescaped colons or invalid YAML; discard and use safe frontmatter from prInfo.
      frontmatter = buildFrontmatter(prInfo, generatedAt, null);
      debug('split-plan: frontmatter parse failed, using safe frontmatter');
    }
  } else {
    body = raw;
    frontmatter = buildFrontmatter(prInfo, generatedAt, null);
    debug('split-plan: no valid --- delimiters, using safe frontmatter');
  }

  // WHY validate paths: LLM can hallucinate file names; we warn but don't strip so human-added paths aren't removed.
  const extractedPaths = extractFilePathsFromPlanBody(body);
  const unknownPaths = extractedPaths.filter(p => !prFileSet.has(p));
  let validationSection = '';
  if (unknownPaths.length > 0) {
    validationSection = `\n## Validation\n\nWarning: these paths were not in the PR: ${unknownPaths.join(', ')}\n`;
  }

  return `${frontmatter}\n\n${body}${validationSection}`;
}

/** WHY simple regex parser: We only need four keys (source_pr, source_branch, target_branch, generated_at). Full YAML would require a dependency; on parse failure we fall back to safe frontmatter from prInfo anyway. */
function parseSimpleFrontmatter(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (match) out[match[1].trim()] = match[2].trim();
  }
  return out;
}

/** WHY fallback to prInfo: When parsed is null (parse failed or no delimiters) we use known-good values so the plan file is always valid. */
function buildFrontmatter(prInfo: PRInfo, generatedAt: string, parsed: Record<string, string> | null): string {
  const sourcePr = parsed?.source_pr ?? `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;
  const sourceBranch = parsed?.source_branch ?? prInfo.branch;
  const targetBranch = parsed?.target_branch ?? prInfo.baseBranch;
  return `---
source_pr: ${sourcePr}
source_branch: ${sourceBranch}
target_branch: ${targetBranch}
generated_at: ${generatedAt}
---`;
}

/**
 * Extract file paths from the plan body under "**Files:**" sections.
 * WHY broad regex: LLM output may reference files with any extension or no extension
 * (Dockerfile, .gitignore, Makefile, etc.). We match any line that looks like a
 * bullet-pointed path (contains a slash or a dot) without spaces in the path portion.
 */
function extractFilePathsFromPlanBody(body: string): string[] {
  const paths: string[] = [];
  const pathLine = /^\s*-\s+([a-zA-Z0-9_.@/-][a-zA-Z0-9_.@/-]*(?:\/[a-zA-Z0-9_.@/-]+)*)/;
  let inFiles = false;
  for (const line of body.split('\n')) {
    if (/\*\*Files:\*\*/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const m = line.match(pathLine);
      if (m) {
        const candidate = m[1].replace(/\s*\(.*$/, '').trim();
        if (candidate.includes('/') || candidate.includes('.')) {
          paths.push(candidate);
        }
      }
      if (/^\s*-\s+\*\*/.test(line) && !/\*\*Files:\*\*/.test(line)) inFiles = false;
      if (line.startsWith('### ') || line.startsWith('## ')) inFiles = false;
    }
  }
  return [...new Set(paths)];
}
