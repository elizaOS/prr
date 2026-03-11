/**
 * Parse a .split-plan.md file into structured data for execution.
 * WHY forgiving parser: Humans and LLMs edit the plan; we accept variations in formatting
 * (e.g. "Route to: PR #42" vs "**Route to:** PR #42 (title)") and extract what we need.
 */
import { readFileSync } from 'fs';
import { parsePRUrl } from '../prr/github/types.js';

export interface ParsedPlan {
  sourcePrUrl: string;
  owner: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  splits: ParsedSplit[];
}

export interface ParsedSplit {
  index: number;
  title: string;
  /** Optional PR/commit title that matches repo style (e.g. conventional commit). Used for commit message and GitHub PR title. */
  prTitle: string | null;
  /** When set, route commits to this existing PR number. */
  routeToPrNumber: number | null;
  /** When set, create a new branch and open a new PR with this branch name. */
  newBranch: string | null;
  /** File paths for this split. When non-empty, we apply these files from source branch (new commit) instead of cherry-picking. */
  files: string[];
  /** Commit SHAs (short or full); used only when files is empty (cherry-pick mode). */
  commits: string[];
  /** Raw lines for the commits section (for diagnostics when commits.length === 0). */
  rawCommitLines: string[];
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n/;
/** Second frontmatter block (e.g. duplicate from LLM); skip so body starts at real content. */
const SECOND_FRONTMATTER_REGEX = /^\s*\n?---\s*\n[\s\S]*?\n---\s*\n/;
const SPLIT_HEADER_REGEX = /^###\s+(\d+)\.\s+(.+)$/;
const ROUTE_TO_REGEX = /\*\*Route to:\*\*\s*PR\s*#(\d+)/i;
const NEW_PR_REGEX = /\*\*New PR:\*\*\s*`([^`]+)`/i;
/** **PR title:** `feat: add workflow` or **Title:** chore: add workflow — use for commit and PR title to match repo style */
const PR_TITLE_REGEX = /\*\*(?:PR title|Title):\*\*\s*(?:`([^`]+)`|(.+?))$/i;
/** Inline: **Commits:** sha1, sha2 */
const COMMITS_LINE_REGEX = /\*\*Commits:\*\*\s*(.+?)(?:\n|$)/i;
/** Bullet line with backtick-wrapped SHA: - `12d870a` (optional note) or * `90eeab4` */
const COMMIT_BULLET_REGEX = /^\s*[-*]\s+`([a-fA-F0-9]{7,40})`/;
/** **Files:** section header */
const FILES_LINE_REGEX = /\*\*Files:\*\*/i;
/** Bullet with backtick-wrapped path; we only treat as file if it looks like a path (has / or .ext), not a commit SHA. */
const FILE_BULLET_REGEX = /^\s*[-*]\s+`([^`]+)`/;
function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (/^[a-fA-F0-9]{7,40}$/.test(t)) return false;
  return t.includes('/') || t.startsWith('.') || /\.(yml|yaml|tsx?|jsx?|md|json|ts|js|mjs|cjs|css|html)$/.test(t);
}

/**
 * Parse YAML-like frontmatter for the four keys we need.
 * WHY simple: Full YAML is overkill; we only need source_pr, source_branch, target_branch (generated_at optional).
 */
function parseFrontmatter(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Commit SHA format (short 7 or full 40 hex chars). Used to fail fast on typos in the plan. */
const COMMIT_SHA_REGEX = /^[0-9a-f]{7,40}$/i;

function isValidCommitSha(sha: string): boolean {
  return COMMIT_SHA_REGEX.test(sha);
}

/**
 * Extract commit SHAs from a "**Commits:** abc1234, def5678" line.
 * WHY flexible: Plan may use short (7) or full SHAs; we accept comma- or space-separated.
 */
function parseCommitsLine(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

/** Validate all commit SHAs in parsed splits; throw with clear message on first invalid SHA. */
function validateCommitShas(splits: ParsedSplit[]): void {
  for (const split of splits) {
    for (const sha of split.commits) {
      if (!isValidCommitSha(sha)) {
        throw new Error(`Invalid plan: commit "${sha}" in split ${split.index} ("${split.title}") is not a valid SHA (expected 7–40 hex chars).`);
      }
    }
  }
}

/**
 * Parse the plan file and return structured data for execution.
 * WHY throw on invalid: Caller should not run with a broken plan; we validate required fields.
 */
export function parsePlanFile(planPath: string): ParsedPlan {
  const raw = readFileSync(planPath, 'utf-8');
  const frontMatch = raw.match(FRONTMATTER_REGEX);
  if (!frontMatch) {
    throw new Error(`Invalid plan: no YAML frontmatter (--- ... ---) in ${planPath}`);
  }
  const frontmatter = parseFrontmatter(frontMatch[1]);
  const sourcePrUrl = frontmatter.source_pr;
  const sourceBranch = frontmatter.source_branch;
  const targetBranch = frontmatter.target_branch;
  if (!sourcePrUrl || !sourceBranch || !targetBranch) {
    throw new Error(
      `Invalid plan: frontmatter must have source_pr, source_branch, target_branch (got ${Object.keys(frontmatter).join(', ')})`
    );
  }
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parsePRUrl(sourcePrUrl));
  } catch {
    const m = sourcePrUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (m) {
      owner = m[1];
      repo = m[2].replace(/\.git$/, '');
    } else {
      throw new Error(`Invalid plan: source_pr is not a valid PR URL: ${sourcePrUrl}`);
    }
  }

  let body = raw.slice(frontMatch[0].length);
  // WHY strip second frontmatter: LLMs sometimes emit duplicate --- blocks; skip so body starts at real content.
  const secondFront = body.match(SECOND_FRONTMATTER_REGEX);
  if (secondFront) body = body.slice(secondFront[0].length);
  const splits = parseSplits(body);
  validateCommitShas(splits);

  return {
    sourcePrUrl,
    owner,
    repo,
    sourceBranch,
    targetBranch,
    splits,
  };
}

/**
 * Parse ## Split section into an ordered array of splits.
 * WHY line-by-line: Plan format is "### N. Title" then key-value lines; we scan for ### and then collect until next ### or ##.
 */
function parseSplits(body: string): ParsedSplit[] {
  const splits: ParsedSplit[] = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const headerMatch = lines[i].match(SPLIT_HEADER_REGEX);
    if (!headerMatch) {
      i++;
      continue;
    }
    const index = parseInt(headerMatch[1], 10);
    const title = headerMatch[2].trim();
    let prTitle: string | null = null;
    let routeToPrNumber: number | null = null;
    let newBranch: string | null = null;
    let files: string[] = [];
    let commits: string[] = [];
    const rawCommitLines: string[] = [];
    let inFilesSection = false;
    i++;
    while (i < lines.length && !lines[i].match(/^###\s+\d+\./) && !lines[i].startsWith('## ')) {
      const line = lines[i];
      if (line.match(/\*\*\w+:\*\*/)) {
        if (line.match(FILES_LINE_REGEX)) inFilesSection = true;
        else inFilesSection = false;
      } else if (inFilesSection) {
        const fileMatch = line.match(FILE_BULLET_REGEX);
        if (fileMatch && looksLikePath(fileMatch[1])) files.push(fileMatch[1].trim());
      }
      const prTitleMatch = line.match(PR_TITLE_REGEX);
      if (prTitleMatch) prTitle = (prTitleMatch[1] ?? prTitleMatch[2] ?? '').trim() || null;
      const routeMatch = line.match(ROUTE_TO_REGEX);
      if (routeMatch) routeToPrNumber = parseInt(routeMatch[1], 10);
      const newMatch = line.match(NEW_PR_REGEX);
      if (newMatch) newBranch = newMatch[1].trim();
      const commitsMatch = line.match(COMMITS_LINE_REGEX);
      if (commitsMatch) {
        inFilesSection = false;
        const inline = parseCommitsLine(commitsMatch[1]);
        if (inline.length > 0) commits.push(...inline);
        rawCommitLines.push(line);
      } else {
        const bulletMatch = line.match(COMMIT_BULLET_REGEX);
        if (bulletMatch) {
          commits.push(bulletMatch[1]);
          rawCommitLines.push(line);
        }
      }
      i++;
    }
    if (routeToPrNumber == null && newBranch == null) {
      continue;
    }
    splits.push({
      index,
      title,
      prTitle,
      routeToPrNumber: routeToPrNumber ?? null,
      newBranch: newBranch ?? null,
      files,
      commits,
      rawCommitLines,
    });
  }
  return splits;
}
