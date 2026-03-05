import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

export interface CommitResult {
  hash: string;
  message: string;
  filesChanged: number;
  stagedFiles: string[];
}

export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

export async function squashCommit(
  git: SimpleGit,
  message: string,
  body?: string
): Promise<CommitResult> {
  // Stage all changes
  await stageAll(git);

  const staged = await git.diff(['--cached', '--name-only']);
  const stagedFiles = staged ? staged.trim().split('\n').filter(Boolean) : [];

  // Build commit message
  const fullMessage = body ? `${message}\n\n${body}` : message;

  // Commit
  const result = await git.commit(fullMessage);

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
    stagedFiles,
  };
}

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
 * 
 * WHY: Git commits are durable. On restart, we can recover which fixes were
 * already verified by scanning the commit history for our markers.
 * 
 * Scope to branch commits (Trap 1): Only search commits that are on this branch
 * since it diverged from main, avoiding false positives from merged commits.
 */
export async function scanCommittedFixes(git: SimpleGit, branch: string): Promise<string[]> {
  try {
    // Find the base branch - try common names
    const baseBranches = ['origin/main', 'origin/master', 'origin/develop'];
    let baseBranch: string | null = null;
    
    for (const candidate of baseBranches) {
      try {
        await git.raw(['rev-parse', '--verify', candidate]);
        baseBranch = candidate;
        break;
      } catch {
        // Branch doesn't exist, try next
      }
    }
    
    // If no common base branch found, fall back to searching recent history
    // This is less precise but won't fail
    const logOptions = baseBranch
      ? { from: baseBranch, to: branch, format: { body: '%B' }, multiLine: true }
      : { maxCount: 100, format: { body: '%B' }, multiLine: true };
    
    debug('scanCommittedFixes', { baseBranch, branch, logOptions });
    const log = await git.log(logOptions as any);
    
    const commentIds: string[] = [];
    
    // Parse all prr-fix:ID markers from commit messages
    for (const entry of log.all) {
      const body = (entry as any).body || '';
      if (!body) continue;
      const matches = body.matchAll(/prr-fix:(\S+)/gi);
      for (const match of matches) {
        commentIds.push(match[1].toLowerCase());
      }
    }
    
    // Dedupe in case the same fix was committed multiple times
    return [...new Set(commentIds)];
  } catch (error) {
    debug('scanCommittedFixes error', { error: String(error) });
    return []; // No commits or error - safe to continue
  }
// Review: deduplicates commit IDs to ensure unique fixes are processed correctly
}

export { buildCommitMessage, stripMarkdownForCommit } from './git-commit-message.js';
