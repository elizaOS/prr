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
import { getCheapModelForProvider, LLMClient } from '../prr/llm/client.js';
import { getMaxElizacloudLlmCompleteInputChars } from '../prr/llm/model-context-limits.js';
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

/** Slack under ElizaCloud char preflight so tokenizer skew rarely trips the gateway. */
const ELIZACLOUD_SPLIT_PLAN_INPUT_SLACK_CHARS = 1024;

/** Cap proportional shrink when fence/markup makes user length nonlinear in patch budget. */
const ELIZACLOUD_PATCH_BUDGET_SHRINK_MAX_STEPS = 32;

/**
 * Cap Phase 1 patch budget so user prompt fits {@link getMaxElizacloudLlmCompleteInputChars} for a single model.
 * Returns null when even zero-patch metadata doesn't fit (caller decides whether to try another model or throw).
 */
function tryCapPatchBudgetForModel(
  model: string,
  prInfo: PRInfo,
  commits: Array<{ sha: string; message: string; authoredDate: Date }>,
  codeFiles: FileWithPatch[],
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>,
  cliMaxPatchChars: number
): { patchBudget: number; cappedVsCliRequest: boolean } | null {
  const systemPrompt = getDependenciesOnlySystemPrompt();
  const maxTotal = getMaxElizacloudLlmCompleteInputChars(model);
  const maxUserChars = maxTotal - systemPrompt.length - ELIZACLOUD_SPLIT_PLAN_INPUT_SLACK_CHARS;
  if (maxUserChars < 4096) return null;

  const noPatches = applyPatchBudget(codeFiles, 0);
  const len0 = buildUserPrompt(prInfo, commits, noPatches, openPRs, true).length;
  if (len0 > maxUserChars) return null;

  const sumPatches = codeFiles.reduce((s, f) => s + (f.patch?.length ?? 0), 0);
  const roomEstimate = Math.max(0, maxUserChars - len0);
  let patchBudget = Math.min(cliMaxPatchChars, sumPatches, roomEstimate);

  for (let step = 0; step < ELIZACLOUD_PATCH_BUDGET_SHRINK_MAX_STEPS; step++) {
    const r = applyPatchBudget(codeFiles, patchBudget);
    const len = buildUserPrompt(prInfo, commits, r, openPRs, true).length;
    if (len <= maxUserChars) {
      return {
        patchBudget,
        cappedVsCliRequest: patchBudget < cliMaxPatchChars,
      };
    }
    if (patchBudget <= 0) return null;
    const scaled = Math.floor(patchBudget * (maxUserChars / len));
    patchBudget = scaled >= patchBudget ? patchBudget - 1 : scaled;
  }
  return null;
}

/**
 * Resolve model + patch budget for ElizaCloud Phase 1.
 * WHY fallback: The cheap model (gpt-4o-mini, ~94k) can't hold metadata for very large PRs.
 * When SPLIT_PLAN_LLM_MODEL is set, we use that (throw if it doesn't fit).
 * Otherwise try cheap, then PRR_LLM_MODEL; warn when falling back.
 */
function resolveElizaCloudModelAndPatchBudget(
  prInfo: PRInfo,
  commits: Array<{ sha: string; message: string; authoredDate: Date }>,
  codeFiles: FileWithPatch[],
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>,
  cliMaxPatchChars: number,
  config: Config
): { model: string; patchBudget: number; cappedVsCliRequest: boolean } {
  const cheapModel = getCheapModelForProvider(config.llmProvider);
  const preferredModel = config.splitPlanModel ?? cheapModel ?? config.llmModel;

  const result = tryCapPatchBudgetForModel(
    preferredModel,
    prInfo,
    commits,
    codeFiles,
    openPRs,
    cliMaxPatchChars
  );
  if (result) return { model: preferredModel, ...result };

  // Preferred model can't fit. If there's a distinct fallback (PRR_LLM_MODEL), try it.
  if (!config.splitPlanModel && config.llmModel && config.llmModel !== preferredModel) {
    const fallbackResult = tryCapPatchBudgetForModel(
      config.llmModel,
      prInfo,
      commits,
      codeFiles,
      openPRs,
      cliMaxPatchChars
    );
    if (fallbackResult) {
      debug('split-plan: cheap model too small for metadata', {
        cheapModel: preferredModel,
        cheapCap: getMaxElizacloudLlmCompleteInputChars(preferredModel),
        fallbackModel: config.llmModel,
        fallbackCap: getMaxElizacloudLlmCompleteInputChars(config.llmModel),
      });
      return { model: config.llmModel, ...fallbackResult };
    }
  }

  // Nothing fits — build a helpful error.
  const noPatches = applyPatchBudget(codeFiles, 0);
  const len0 = buildUserPrompt(prInfo, commits, noPatches, openPRs, true).length;
  const sysLen = getDependenciesOnlySystemPrompt().length;
  const bestModel = config.llmModel ?? preferredModel;
  const cap = getMaxElizacloudLlmCompleteInputChars(bestModel);
  throw new Error(
    `split-plan: Phase 1 prompt is ${formatNumber(len0 + sysLen)} chars (no patches); ${bestModel} allows ${formatNumber(cap)}. Set SPLIT_PLAN_LLM_MODEL to a larger-context model, shorten the PR body, or reduce files/commits.`
  );
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
  spinner.succeed(`${formatNumber(openPRs.length)} open PRs on ${prInfo.baseBranch}`);

  // Fetch recent PR titles to infer repo title style so the plan suggests **PR title:** in that vibe.
  spinner.start('Fetching recent PR titles (for style)...');
  const recentTitles = await github.getRecentPRTitles(owner, repo, 30);
  let titleStyleSummary: string | null = null;
  const llm = new LLMClient(config);
  if (recentTitles.length > 0) {
    titleStyleSummary = await inferPRTitleStyle(recentTitles, llm, config);
  }
  if (titleStyleSummary) spinner.succeed('PR title style inferred');
  else spinner.succeed(recentTitles.length > 0 ? 'Skipped style (no summary)' : 'No recent PRs for style');

  // WHY separate code vs low-signal: Code files get patch budget; low-signal files still appear in the prompt as metadata (omitted list) so the LLM knows they changed but we don't spend patch budget on them.
  const codeFiles = filesWithPatches.filter(f => !isLowSignalFile(f.filename));
  const lowSignalFiles = filesWithPatches.filter(f => isLowSignalFile(f.filename));

  let patchBudget = options.maxPatchChars;
  let splitPlanModel =
    config.splitPlanModel ?? getCheapModelForProvider(config.llmProvider) ?? config.llmModel;
  if (config.llmProvider === 'elizacloud') {
    const resolved = resolveElizaCloudModelAndPatchBudget(
      prInfo,
      commits,
      codeFiles,
      openPRs,
      options.maxPatchChars,
      config
    );
    patchBudget = resolved.patchBudget;
    splitPlanModel = resolved.model;
    if (options.verbose || resolved.cappedVsCliRequest) {
      debug('split-plan ElizaCloud Phase 1', {
        model: splitPlanModel,
        patchBudget,
        requestedMaxPatchChars: options.maxPatchChars,
      });
    }
  }

  const filesWithBudget = applyPatchBudget(codeFiles, patchBudget);
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

  const planContent = await buildPlanContent(
    prInfo,
    commits,
    filesWithBudget,
    prFileList,
    openPRs,
    llm,
    config,
    titleStyleSummary,
    splitPlanModel
  );
  return planContent;
}

/**
 * Ask the LLM to summarize PR title style from a list of recent titles.
 * WHY: So the main plan prompt can say "match this style" and the model outputs **PR title:** in repo vibe.
 */
async function inferPRTitleStyle(
  titles: string[],
  llm: LLMClient,
  config: Config
): Promise<string | null> {
  const list = titles.slice(0, 25).map(t => `- ${t}`).join('\n');
  const userPrompt = `These are recent PR titles from the repo:\n\n${list}\n\nIn 2-4 short sentences, describe the style: e.g. conventional commits (type/scope), length, ticket numbers, tone. Prose only, no bullet list.`;
  const systemPrompt = 'You are a technical writer. Be concise. Describe only the observable style.';
  try {
    const response = await llm.complete(userPrompt, systemPrompt, { model: config.llmModel });
    const summary = response.content.trim();
    return summary.length > 10 ? summary : null;
  } catch (err) {
    debug('split-plan: PR title style inference failed', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** WHY two-phase LLM: Single large prompt often hits gateway 504. Phase 1 (dependencies only) and Phase 2 (full plan from deps + file list without patches) keep each request smaller and faster. */
async function buildPlanContent(
  prInfo: PRInfo,
  commits: Array<{ sha: string; message: string; authoredDate: Date }>,
  filesWithBudget: PatchBudgetResult,
  prFileList: string[],
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>,
  llm: LLMClient,
  config: Config,
  titleStyleSummary: string | null,
  /** Resolved in runSplitPlan; on ElizaCloud may differ from cheap default when metadata exceeds cheap model's cap. */
  model: string
): Promise<string> {
  const spinner = ora();

  // Phase 1: Dependencies only (full prompt with patches; output is small).
  spinner.start('Phase 1: Dependencies...');
  const userPrompt1 = buildUserPrompt(prInfo, commits, filesWithBudget, openPRs, true);
  const systemPrompt1 = getDependenciesOnlySystemPrompt();
  const response1 = await llm.complete(userPrompt1, systemPrompt1, {
    model,
    max504Retries: 3,
  });
  spinner.succeed('Phase 1: Dependencies done');
  const depsText = extractDependenciesFromResponse(response1.content.trim());

  // Phase 2: Full plan from dependencies + file list (no patches) so prompt stays small.
  spinner.start('Phase 2: Split plan...');
  const userPrompt2 = buildUserPromptPhase2(prInfo, commits, filesWithBudget, openPRs, depsText);
  const systemPrompt2 = getSystemPrompt(titleStyleSummary);
  if (config.llmProvider === 'elizacloud') {
    const maxTotal = getMaxElizacloudLlmCompleteInputChars(model);
    const phase2Total = userPrompt2.length + systemPrompt2.length + ELIZACLOUD_SPLIT_PLAN_INPUT_SLACK_CHARS;
    if (phase2Total > maxTotal) {
      throw new Error(
        `split-plan: Phase 2 prompt (${formatNumber(phase2Total)} chars) exceeds ElizaCloud input budget (${formatNumber(maxTotal)} chars) for ${model}. Use SPLIT_PLAN_LLM_MODEL with a larger context or reduce PR size.`
      );
    }
  }
  const response2 = await llm.complete(userPrompt2, systemPrompt2, {
    model,
    max504Retries: 3,
  });
  spinner.succeed('Done');

  const raw = response2.content.trim();
  return postProcessPlan(raw, prInfo, prFileList);
}

/** Extract the ## Dependencies section from Phase 1 response for use in Phase 2. */
function extractDependenciesFromResponse(content: string): string {
  const match = content.match(/#+\s*Dependencies\s*\n([\s\S]*?)(?=\n#+\s|\n---\s*$|$)/i);
  if (match) return match[1].trim();
  return content.trim();
}

function getDependenciesOnlySystemPrompt(): string {
  return `You are a senior engineer analyzing dependencies in a large pull request.
Output ONLY the "## Dependencies" section: a bullet list of dependencies in the form:
- \`fileA\` (brief change) <- \`fileB\` (why it depends)
Notation: A <- B means "A depends on B" (B provides something A needs; B should merge first or be in the same PR).
or "No cross-file dependencies identified."
Do NOT output YAML frontmatter, ## Split, ## Merge order, or any other section.`;
}

/** WHY two-phase in system prompt: If we only ask "split this PR," the model groups by file proximity and ignores dependencies. Forcing Phase 1 (dependencies) before Phase 2 (grouping) makes dependency order a hard constraint. */
function getSystemPrompt(titleStyleSummary: string | null): string {
  const titleStyleBlock = titleStyleSummary
    ? `\nPR TITLE STYLE (match this repo's vibe):\n${titleStyleSummary}\n\nFor each split you must include a line **PR title:** \`<title in that style>\` so the created PRs match the repo. Use the same style for the ### N. heading if you like, but **PR title:** is what will be used as the GitHub PR title and commit message.\n`
    : '';

  return `You are a senior engineer decomposing a large pull request into smaller, focused PRs. You will perform TWO phases of analysis:
${titleStyleBlock}
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
- Do NOT create a split whose **Files:** list contains only documentation (e.g. only CHANGELOG.md, DESIGN.md, README.md, ROADMAP.md, docs/*). Put each doc file in the split that implements the feature it documents (e.g. DESIGN section on logging → logging split). Never output a "chore: Update documentation" or "feat: Document..." split that has only doc files.
- **Depends on:** Only list another split's branch name if that split provides code or types that this split's files actually import or call. Do not list a dependency based on thematic similarity or "same area"; only real import/call edges.
- Pure refactors that enable a feature = separate PR, merge first
- Config/infra that multiple features need = separate foundational PR
- Don't split to reduce size. Split to reduce cognitive load.
- If an existing open PR covers the same concern, route changes there
- Record source and target branches for each proposed split
- Include **PR title:** for each split (in the repo's style) so split-exec creates PRs that match the repo

Output the plan in the EXACT markdown format shown below (with YAML frontmatter). The human will edit this file, so make it clear and readable.

Use this structure (source_pr will be filled automatically; you may omit it or use a placeholder):

---
source_branch: <head branch name>
target_branch: <base branch name>
---

# Split Plan for PR #<number>: <title>

## Dependencies

- \`fileA\` (change description) <- \`fileB\` (why it depends)
- or: No cross-file dependencies identified.

## Split

### 1. <Short title>
- **New PR:** \`branch-name\`
- **PR title:** \`<title in repo style, e.g. conventional commit or short imperative>\`
- **Source branch:** ...
- **Target branch:** ...
- **Depends on:** ... or nothing
- **Files:**
  - \`path/to/file1\`
  - \`path/to/file2\`
- **Commits:**
  - \`sha1\` (optional note)
  - \`sha2\`
- **Why one unit:** ...

(Alternatively **Route to:** PR #N instead of New PR when routing to an existing open PR.)

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
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>,
  phase1Only: boolean
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

  const openPRLines = openPRs.length > 0
    ? openPRs.map(p =>
      `  #${p.number}: "${p.title}" (branch: ${p.branch}, by @${p.author})\n    Description: ${p.body}`
    ).join('\n\n')
    : '  (none)';

  const patchNote = phase1Only
    ? `Files changed (${totalFiles} total; +${totalAdditions}/-${totalDeletions}). Patches included for dependency analysis.`
    : `Files changed (${totalFiles} total; +${totalAdditions}/-${totalDeletions}). Patches included for ${filesWithBudget.included.filter(f => f.patchIncluded).length} files; ${filesWithBudget.omitted.length} omitted (budget exceeded).`;

  const ending = phase1Only
    ? 'Produce ONLY the ## Dependencies section now (bullet list; no other sections).'
    : 'Produce the split plan now. Phase 1 (dependencies) first, then Phase 2 (split plan).';

  return `Target PR: #${prInfo.number} "${prInfo.title}"
Branch: ${prInfo.branch} -> ${prInfo.baseBranch}
Description:
${prInfo.body || '(no description)'}

Commits (${commits.length} total, chronological):
${commitLines.join('\n')}

${patchNote}
${fileLines.join('\n')}

Open PRs targeting ${prInfo.baseBranch} (available buckets; showing up to 20):
${openPRLines}

${ending}`;
}

/** Phase 2 user prompt: same metadata + dependencies text + file list WITHOUT patches to keep prompt small and avoid 504. */
function buildUserPromptPhase2(
  prInfo: PRInfo,
  commits: Array<{ sha: string; message: string; authoredDate: Date }>,
  filesWithBudget: PatchBudgetResult,
  openPRs: Array<{ number: number; title: string; body: string; branch: string; author: string }>,
  depsText: string
): string {
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
  const fileLines = [
    ...filesWithBudget.included.map(f => `  ${f.status.padEnd(8)} ${f.filename} (+${f.additions}/-${f.deletions})`),
    ...filesWithBudget.omitted.map(f => {
      const reason = isLowSignalFile(f.filename) ? 'lockfile/generated' : 'budget exceeded';
      return `  ${f.status.padEnd(8)} ${f.filename} (+${f.additions}/-${f.deletions}) [omitted — ${reason}]`;
    }),
  ];
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

## Dependencies (from Phase 1 — use these to constrain the split)
${depsText}

Files changed (${totalFiles} total; +${totalAdditions}/-${totalDeletions}). No patches in this phase; use dependencies and file names to group.
${fileLines.join('\n')}

Open PRs targeting ${prInfo.baseBranch} (available buckets; showing up to 20):
${openPRLines}

Produce the full split plan now: YAML frontmatter (source_branch, target_branch), ## Dependencies (copy from above), ## Split, ## Merge order.
There are exactly ${totalFiles} files in this PR. You MUST assign every file to exactly one split's **Files:** list — no file may be omitted. Do not create a docs-only split; attach each doc file to the split that implements the feature it documents.`;
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

  // WHY strip trailing fence: LLM sometimes ends the markdown with a stray ```; remove so the file is valid.
  body = body.replace(/\n*```\s*$/, '').trimEnd();

  // WHY validate paths: LLM can hallucinate file names; we warn but don't strip so human-added paths aren't removed.
  const extractedPaths = extractFilePathsFromPlanBody(body);
  const planPathSet = new Set(extractedPaths);
  const unknownPaths = extractedPaths.filter(p => !prFileSet.has(p));
  const unassignedFiles = prFileList.filter(p => !planPathSet.has(p));
  let validationSection = '';
  if (unknownPaths.length > 0) {
    validationSection += `\nWarning: these paths were not in the PR: ${unknownPaths.join(', ')}`;
  }
  if (unassignedFiles.length > 0) {
    validationSection += `${validationSection ? '\n\n' : '\n'}These files were in the PR but not assigned to any split: ${unassignedFiles.join(', ')}`;
  }
  if (validationSection) {
    validationSection = `\n## Validation\n\n${validationSection.trim()}\n`;
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

/** WHY always source_pr from prInfo: LLM often outputs placeholders (e.g. your_repo); we never trust it for the PR URL. */
function buildFrontmatter(prInfo: PRInfo, generatedAt: string, parsed: Record<string, string> | null): string {
  const sourcePr = `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;
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
 * bullet-pointed path (contains a slash or a dot). Paths may be wrapped in backticks.
 */
function extractFilePathsFromPlanBody(body: string): string[] {
  const paths: string[] = [];
  // Optional backticks: LLM often outputs "  - `path/to/file`"; without `?` the regex never matches.
  const pathLine = /^\s*-\s+`?([a-zA-Z0-9_.@/-][a-zA-Z0-9_.@/-]*(?:\/[a-zA-Z0-9_.@/-]+)*)`?/;
  let inFiles = false;
  for (const line of body.split('\n')) {
    if (/\*\*Files:\*\*/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const m = line.match(pathLine);
      if (m) {
        let candidate = m[1].replace(/\s*\(.*$/, '').trim();
        if (candidate.endsWith('`')) candidate = candidate.slice(0, -1);
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
