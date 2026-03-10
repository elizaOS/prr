import type { SimpleGit } from 'simple-git';

export type { CommitResult } from './git-commit-core.js';

export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

/**
 * Squash and commit staged changes with pre-commit safety (tool artifacts, empty test files).
 * Re-exported from git-commit-core so callers that import from commit.ts get the same behavior.
 */
export { squashCommit } from './git-commit-core.js';

/**
 * Push logic lives in git-push.ts; we re-export for callers that import from commit.ts.
 * WHY: Single source of truth avoids duplicate/broken implementations and parse errors.
 */
export type { PushResult } from './git-push.js';

/**
 * @deprecated Use push from git-push.ts (git-commit-index re-exports it).
 */
export { push, pushWithRetry } from './git-push.js';
export type { PushWithRetryResult } from './git-push.js';

export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const result = await git.branch();
  return result.current;
}

export async function getLastCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || '';
}

/**
 * Commit verified fixes from an iteration with prr-fix markers for recovery.
 * 
 * WHY markers: On restart, we scan git log for these markers to recover which
 * fixes were verified, even if the state file is lost or corrupted.
 * 
 * WHY check status first: Prevents "nothing to commit" errors. Also handles
 * case where changes were already committed or the fixer made no changes.
 * 
 * Returns null if no changes to commit.
 * @deprecated Use commitIteration from git-commit-iteration.js (includes pre-commit checks).
 */
export { commitIteration } from './git-commit-iteration.js';

/**
 * Scan git log for prr-fix markers to recover verification state.
 * Re-exported from git-commit-scan.ts (canonical implementation with raw() and proper casing).
 * WHY: commit.ts had a duplicate using simple-git's log() with different behavior; single source avoids inconsistent recovery (pill-output.md #4).
 */
export { scanCommittedFixes } from './git-commit-scan.js';

export { buildCommitMessage, stripMarkdownForCommit } from './git-commit-message.js';
