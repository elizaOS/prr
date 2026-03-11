/**
 * Story runner: fetch PR or branch data, build prompt, call LLM, return narrative + changelog.
 *
 * Three flows: PR (getPRInfo + getPRCommits + getPRFiles), single branch (getBranchCommitHistory only),
 * two branches (getBranchComparisonEitherDirection). WHY single-branch has no files: branch may be behind
 * default; we use List Commits so we always have a story without picking a base.
 */
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import type { Config } from '../../shared/config.js';
import type { StoryOptions } from './cli.js';
import { GitHubAPI } from '../prr/github/api.js';
import { parsePRUrl, parseBranchSpec, parseRepoUrl, normalizeCompareBranch } from '../prr/github/types.js';
import { LLMClient } from '../prr/llm/client.js';
import { debug, formatNumber } from '../../shared/logger.js';

/** WHY 500: Long multi-line commit messages blow prompt size; first line plus date is enough for narrative. */
const MAX_COMMIT_MESSAGE_LENGTH = 500;

function truncateMessage(msg: string): string {
  const firstLine = msg.split('\n')[0] ?? '';
  if (firstLine.length <= MAX_COMMIT_MESSAGE_LENGTH) return firstLine;
  return firstLine.slice(0, MAX_COMMIT_MESSAGE_LENGTH) + '…';
}

/**
 * Build commit summary for the LLM: first N, "… X more …", last M.
 * WHEN total <= maxCommits: show all (no first/last split). WHEN total > maxCommits: half = min(maxCommits/2, total/2)
 * so first and last don't overlap. WHY: Previously half = maxCommits/2 with total < maxCommits produced overlapping
 * first/last and duplicated ~50 commits in the prompt.
 */
function buildCommitSummary(
  commits: Array<{ message: string; authoredDate: Date }>,
  maxCommits: number
): { text: string; total: number } {
  const total = commits.length;
  if (total === 0) return { text: '(no commits)', total: 0 };
  if (total <= maxCommits) {
    const lines = commits.map(c => `- ${truncateMessage(c.message)} (${c.authoredDate.toISOString().slice(0, 10)})`);
    return { text: lines.join('\n'), total };
  }
  const half = Math.min(Math.floor(maxCommits / 2), Math.floor(total / 2));
  const first = commits.slice(0, half).map(c => `- ${truncateMessage(c.message)} (${c.authoredDate.toISOString().slice(0, 10)})`);
  const last = commits.slice(-half).map(c => `- ${truncateMessage(c.message)} (${c.authoredDate.toISOString().slice(0, 10)})`);
  const middleCount = total - half * 2;
  const parts: string[] = [...first, `… (${formatNumber(middleCount)} more commits) …`, ...last];
  return { text: parts.join('\n'), total };
}

/**
 * Build file list summary for the LLM: path, status, +/- lines; omit after maxFiles with "... and N more files".
 * WHY formatNumber for counts: Per workspace rule, user-visible numbers use locale formatting (e.g. 1,234).
 */
function buildFileSummary(
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>,
  maxFiles: number
): { text: string; total: number; totalAdditions: number; totalDeletions: number } {
  const total = files.length;
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const show = files.slice(0, maxFiles);
  const lines = show.map(f => `  ${f.status.padEnd(8)} ${f.filename} (+${f.additions}/-${f.deletions})`);
  const omitted = total - show.length;
  if (omitted > 0) {
    lines.push(`  … and ${formatNumber(omitted)} more files`);
  }
  return {
    text: lines.join('\n'),
    total,
    totalAdditions,
    totalDeletions,
  };
}

const SYSTEM_PROMPT = `You are a technical writer. Given raw data about a GitHub pull request (title, description, commit history, and list of changed files), you will produce three outputs in a single response.

Use this exact structure. Do not add extra sections or change the headings.

## Narrative
Write 2–4 short paragraphs that tell the story of the PR: what changed and why. Focus on intent and outcome, not every commit. For large PRs, summarize themes and phases (e.g. "initial feature work", "refactors", "tests and docs") rather than listing every change.

## Features / changes
A bullet list that catalogs the main features or change areas. Each item should be one line. Group related items if helpful. Aim for clarity and scannability (e.g. "Add SIWE auth for programmatic agents", "Refactor session store", "Tests for X").

## Changelog
A proper changelog in this format:

### Added
- …

### Changed
- …

### Fixed
- …

### Removed
- …

(Only include sections that apply; omit empty sections.)

Use the PR title and body, commit messages, and file paths to infer what was added/changed/fixed/removed. Be concise and user-facing.`;

const SYSTEM_PROMPT_BRANCH = `You are a technical writer. Given the commit history of a GitHub branch (oldest to newest), with no PR description and no file list, you will produce three outputs in a single response.

Use this exact structure. Do not add extra sections or change the headings.

## Narrative
Write 2–4 short paragraphs that tell the story of this branch: what changed and why. Infer intent from commit messages only. For long histories, summarize themes and phases rather than listing every commit.

## Features / changes
A bullet list that catalogs the main features or change areas. Each item should be one line. Infer from commit messages. Be concise and scannable.

## Changelog
A proper changelog in this format:

### Added
- …

### Changed
- …

### Fixed
- …

### Removed
- …

(Only include sections that apply; omit empty sections.)

Infer what was added/changed/fixed/removed from commit messages only. Be concise and user-facing.`;

const SYSTEM_PROMPT_TWO_BRANCHES = `You are a technical writer. Given two branches and the commit history from the older branch to the newer (oldest to newest), plus the list of files changed, you will produce three outputs in a single response.

Use this exact structure. Do not add extra sections or change the headings.

## Narrative
Write 2–4 short paragraphs that tell the story from the older branch to the newer: what changed and why. Infer intent from commit messages and file paths. Summarize themes and phases rather than listing every commit.

## Features / changes
A bullet list that catalogs the main features or change areas. Each item should be one line. Infer from commits and file paths. Be concise and scannable.

## Changelog
A proper changelog in this format:

### Added
- …

### Changed
- …

### Fixed
- …

### Removed
- …

(Only include sections that apply; omit empty sections.)

Infer what was added/changed/fixed/removed from commit messages and file paths. Be concise and user-facing.`;

/** WHY try PR first: PR URL and branch spec can both be valid; PR takes precedence so owner/repo#123 is a PR. */
function isPRInput(input: string): boolean {
  try {
    parsePRUrl(input);
    return true;
  } catch {
    return false;
  }
}

export async function runStory(
  input: string,
  config: Config,
  options: StoryOptions
): Promise<string> {
  const github = new GitHubAPI(config.githubToken);
  const llm = new LLMClient(config);
  const spinner = ora();

  let commitSummary: { text: string; total: number };
  let fileSummary: { text: string; total: number; totalAdditions: number; totalDeletions: number };
  let userPrompt: string;
  let systemPrompt: string;

  if (isPRInput(input)) {
    const { owner, repo, number } = parsePRUrl(input);
    spinner.start('Fetching PR info...');
    const prInfo = await github.getPRInfo(owner, repo, number);
    spinner.succeed(`PR: ${prInfo.title}`);

    spinner.start('Fetching commits...');
    const commits = await github.getPRCommits(owner, repo, number);
    spinner.succeed(`${formatNumber(commits.length)} commits`);

    spinner.start('Fetching changed files...');
    const files = await github.getPRFiles(owner, repo, number);
    spinner.succeed(`${formatNumber(files.length)} files changed`);

    commitSummary = buildCommitSummary(
      commits.map(c => ({ message: c.message, authoredDate: c.authoredDate })),
      options.maxCommits
    );
    fileSummary = buildFileSummary(files, options.maxFiles);

    systemPrompt = SYSTEM_PROMPT;
    userPrompt = `Analyze this pull request and produce the three sections (Narrative, Features/changes, Changelog).

Repository: ${owner}/${repo}
PR #${number}
Branch: ${prInfo.branch} → ${prInfo.baseBranch}

Title: ${prInfo.title}

Description:
${prInfo.body || '(no description)'}

Commits (${formatNumber(commitSummary.total)} total):
${commitSummary.text}

Files changed (${formatNumber(fileSummary.total)} total; +${formatNumber(fileSummary.totalAdditions)}/-${formatNumber(fileSummary.totalDeletions)}):
${fileSummary.text}

Output your response with the exact headings: ## Narrative, ## Features / changes, ## Changelog.`;
  } else {
    let branchSpec = parseBranchSpec(input);
    let owner: string;
    let repo: string;
    let branch: string;
    if (branchSpec) {
      owner = branchSpec.owner;
      repo = branchSpec.repo;
      branch = branchSpec.branch;
    } else {
      const repoSpec = parseRepoUrl(input);
      if (!repoSpec) {
        throw new Error(
          `Invalid input: "${input}". Use a PR URL (e.g. https://github.com/owner/repo/pull/123 or owner/repo#123), a branch spec (e.g. owner/repo@branch or https://github.com/owner/repo/tree/branch), or a repo URL (e.g. https://github.com/owner/repo or owner/repo for default branch).`
        );
      }
      owner = repoSpec.owner;
      repo = repoSpec.repo;
      spinner.start('Fetching default branch...');
      branch = await github.getDefaultBranch(owner, repo);
      spinner.succeed(`Default branch: ${branch}`);
    }
    const secondBranchRaw = options.compareBranch?.trim();
    const secondBranch = secondBranchRaw
      ? normalizeCompareBranch(secondBranchRaw, owner, repo)
      : undefined;
    /* WHY normalize: --compare may be a tree URL; API expects branch name (e.g. v1-develop) or 404. */

    if (secondBranch) {
      spinner.start(`Comparing ${branch} and ${secondBranch}...`);
      const { commits, files, olderRef, newerRef } = await github.getBranchComparisonEitherDirection(
        owner,
        repo,
        branch,
        secondBranch
      );
      spinner.succeed(
        `${formatNumber(commits.length)} commits (${olderRef} → ${newerRef}), ${formatNumber(files.length)} files changed`
      );

      commitSummary = buildCommitSummary(
        commits.map(c => ({ message: c.message, authoredDate: c.authoredDate })),
        options.maxCommits
      );
      fileSummary = buildFileSummary(files, options.maxFiles);

      systemPrompt = SYSTEM_PROMPT_TWO_BRANCHES;
      userPrompt = `Analyze the changes from the older branch to the newer and produce the three sections (Narrative, Features/changes, Changelog).

Repository: ${owner}/${repo}
Branches: ${olderRef} (older) → ${newerRef} (newer)
Commits below are in chronological order (oldest to newest).

Commits (${formatNumber(commitSummary.total)} total):
${commitSummary.text}

Files changed (${formatNumber(fileSummary.total)} total; +${formatNumber(fileSummary.totalAdditions)}/-${formatNumber(fileSummary.totalDeletions)}):
${fileSummary.text}

Output your response with the exact headings: ## Narrative, ## Features / changes, ## Changelog.`;
    } else {
      spinner.start(`Fetching commit history for ${branch}...`);
      const commits = await github.getBranchCommitHistory(
        owner,
        repo,
        branch,
        options.maxFetchCommits ?? 0
      );
      spinner.succeed(`${formatNumber(commits.length)} commits`);

      commitSummary = buildCommitSummary(
        commits.map(c => ({ message: c.message, authoredDate: c.authoredDate })),
        options.maxCommits
      );
      fileSummary = buildFileSummary([], options.maxFiles);

      systemPrompt = SYSTEM_PROMPT_BRANCH;
      userPrompt = `Analyze this branch’s commit history and produce the three sections (Narrative, Features/changes, Changelog).

Repository: ${owner}/${repo}
Branch: ${branch}
No PR description and no file list — infer everything from the commit messages below (oldest to newest).

Commits (${formatNumber(commitSummary.total)} total):
${commitSummary.text}

Output your response with the exact headings: ## Narrative, ## Features / changes, ## Changelog.`;
    }
  }

  if (options.verbose) {
    debug('Story prompt length', { chars: userPrompt.length });
  }

  spinner.start('Building narrative and changelog...');
  const response = await llm.complete(userPrompt, systemPrompt, {
    model: config.llmModel,
  });
  spinner.succeed('Done');

  const content = response.content.trim();
  return content;
}

export function writeOutput(content: string, outputPath: string): void {
  writeFileSync(outputPath, content, 'utf-8');
  console.log(chalk.gray(`Written to ${outputPath}`));
}
