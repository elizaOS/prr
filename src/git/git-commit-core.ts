/**
 * Core commit operations - basic staging and committing
 * 
 * WHY this module exists:
 * Extracted from git/commit.ts to separate fundamental commit operations
 * from more complex push/retry logic and message formatting.
 * 
 * WHY these functions are together:
 * Both functions deal with the basic git commit workflow: stage changes,
 * then commit them. They are the building blocks used by other modules.
 * 
 * DESIGN: Simple, focused functions that wrap simple-git with clear
 * return types. No complex retry logic or timeout handling here.
 */
import type { SimpleGit } from 'simple-git';

export interface CommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

/**
 * Stage all changes in the repository
 * 
 * WHY use git add -A instead of git add .:
 * -A stages all changes including deletions and renames, not just modifications.
 * This ensures we capture the complete state of the working directory.
 */
export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

/**
 * Create a commit with all current changes
 * 
 * WHY "squash" in the name:
 * This function stages and commits all outstanding changes in one operation,
 * effectively "squashing" the working directory state into a single commit.
 * The name distinguishes it from more granular commit operations.
 * 
 * WHY separate title and body:
 * Follows git best practices - first line is the summary (shows in git log),
 * body provides additional context (shows in git show). This makes commits
 * more readable in both compact and detailed views.
 * 
 * @param git - SimpleGit instance for the repository
 * @param message - Commit title/summary (first line)
 * @param body - Optional detailed description
 * @returns Commit hash, message, and number of files changed
 */
export async function squashCommit(
  git: SimpleGit,
  message: string,
  body?: string
): Promise<CommitResult> {
  // Stage all changes
  await stageAll(git);

  // Build commit message (title + optional body separated by blank line)
  const fullMessage = body ? `${message}\n\n${body}` : message;

  // Commit
  const result = await git.commit(fullMessage);

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
  };
}
