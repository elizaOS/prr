/**
 * Git merge operations
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

/**
 * Continue an in-progress rebase without opening an editor.
 * Sets GIT_EDITOR=true then runs git.rebase(['--continue']).
 * WHY: git rebase --continue invokes the configured editor (e.g. nano) to edit the
 * commit message. In non-interactive environments (prr workdir, CI) there is no TTY,
 * so the editor fails with "Standard input is not a terminal" or "problem with the
 * editor 'editor'. Please supply the message using -m or -F". GIT_EDITOR=true is a
 * no-op that exits 0, so git keeps the default (replayed) message. One helper for
 * all rebase --continue call sites keeps behavior consistent.
 */
export async function continueRebase(git: SimpleGit): Promise<void> {
  process.env.GIT_EDITOR = 'true';
  await git.rebase(['--continue']);
}

export async function getConflictedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return status.conflicted || [];
}

export async function abortMerge(git: SimpleGit): Promise<void> {
  try {
    await git.merge(['--abort']);
  } catch {
    // May fail if no merge in progress, ignore
  }
}

export async function cleanupGitState(git: SimpleGit): Promise<void> {
  debug('Cleaning up git state');
  
  // Abort any in-progress merge
  try {
    await git.merge(['--abort']);
    debug('Aborted in-progress merge');
  } catch {
    // No merge in progress, ignore
  }
  
  // Abort any in-progress rebase
  try {
    await git.rebase(['--abort']);
    debug('Aborted in-progress rebase');
  } catch {
    // No rebase in progress, ignore
  }
  
  // Abort any in-progress cherry-pick
  try {
    await git.raw(['cherry-pick', '--abort']);
    debug('Aborted in-progress cherry-pick');
  } catch {
    // No cherry-pick in progress, ignore
  }
  
  // Reset any staged changes and restore working directory
  try {
    await git.reset(['--hard', 'HEAD']);
    debug('Reset to HEAD');
  } catch {
    // May fail if HEAD doesn't exist, ignore
  }
  
  // Clean untracked files (but keep ignored files)
  try {
    await git.clean('f', ['-d']);
    debug('Cleaned untracked files');
  } catch {
    // Ignore cleanup errors
  }
}

export interface MergeBaseResult {
  success: boolean;
  alreadyUpToDate?: boolean;
  conflictedFiles?: string[];
  error?: string;
}

export async function mergeBaseBranch(
  git: SimpleGit, 
  baseBranch: string
): Promise<MergeBaseResult> {
  debug('Merging base branch into PR branch', { baseBranch });
  
  try {
    // Fetch all refs including the base branch
    debug('Fetching origin with all refs');
    await git.fetch(['origin', '--prune']);
    
    // Verify the ref exists
    try {
      await git.raw(['rev-parse', '--verify', `origin/${baseBranch}`]);
    } catch {
      debug('Base branch ref not found, trying explicit fetch');
      await git.fetch(['origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`]);
    }
    
    // Check if we're already up-to-date before trying merge
    const headSha = await git.revparse(['HEAD']);
    const baseSha = await git.revparse([`origin/${baseBranch}`]);
    const mergeBase = await git.raw(['merge-base', 'HEAD', `origin/${baseBranch}`]).then(s => s.trim());
    
    if (baseSha.trim() === mergeBase) {
      debug('Already up-to-date with base branch');
      return { success: true, alreadyUpToDate: true };
    }
    
    // Try to merge
    debug('Attempting merge');
    const result = await git.merge([`origin/${baseBranch}`, '--no-edit']);
    
    // Check if merge result indicates already up-to-date
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    if (resultStr.includes('Already up to date') || resultStr.includes('Already up-to-date')) {
      debug('Merge says already up-to-date');
      return { success: true, alreadyUpToDate: true };
    }
    
    debug('Merge successful');
    return { success: true, alreadyUpToDate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('Merge failed', { error: message });
    
    // "Already up to date" can come as an error in some git versions
    if (message.includes('Already up to date') || message.includes('Already up-to-date')) {
      return { success: true, alreadyUpToDate: true };
    }
    
    // Check for conflicts
    const status = await git.status();
    if (status.conflicted && status.conflicted.length > 0) {
      await abortMerge(git);
      return { 
        success: false, 
        conflictedFiles: status.conflicted,
        error: 'Merge conflicts detected'
      };
    }
    
    await abortMerge(git);
    return { success: false, error: message };
  }
}

export async function startMergeForConflictResolution(
  git: SimpleGit,
  baseBranch: string,
  mergeMessage: string
): Promise<{ conflictedFiles: string[]; error?: string }> {
  debug('Starting merge for conflict resolution', { baseBranch });
  
  try {
    // Fetch all refs
    await git.fetch(['origin', '--prune']);
    
    // Try explicit fetch of base branch
    try {
      await git.fetch(['origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`]);
    } catch {
      // May already exist, ignore
    }
    
    // Start the merge (will fail with conflicts, that's expected)
    let mergeError: unknown = null;
    try {
      await git.merge([`origin/${baseBranch}`, '--no-commit']);
    } catch (error) {
      mergeError = error;
    }
    
    // Get conflicted files
    const status = await git.status();
    const conflictedFiles = status.conflicted || [];
    
    // If merge failed but no conflicts, it's a real error (auth/ref/history failure)
    if (mergeError && conflictedFiles.length === 0) {
      const message = mergeError instanceof Error ? mergeError.message : String(mergeError);
      return { conflictedFiles: [], error: message };
    }
    
    if (conflictedFiles.length === 0) {
      // No conflicts - either complete the merge or abort if nothing to merge
      if (!status.isClean()) {
        // Staged changes exist from merge - commit them
        const commitResult = await completeMerge(git, mergeMessage);
        if (!commitResult.success) {
          await abortMerge(git);
          return { conflictedFiles: [], error: commitResult.error || 'Failed to complete merge' };
        }
      } else {
        // No changes and no conflicts - merge was a no-op, abort merge state
        await abortMerge(git);
      }
    }

    debug('Merge started, conflicts', { conflictedFiles });
    return { conflictedFiles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { conflictedFiles: [], error: message };
  }
}

export async function markConflictsResolved(git: SimpleGit, files: string[]): Promise<void> {
  debug('Marking conflicts as resolved', { files });
  for (const file of files) {
    await git.add(file);
  }
}

/**
 * Complete an in-progress merge or rebase after conflicts were resolved.
 * WHY this exists: After resolveConflicts() we've staged the resolution; we must either
 * `rebase --continue` (rebase) or `commit` (merge). Using the wrong one leaves .git/rebase-merge
 * behind and breaks the next push retry.
 */
export async function completeMerge(git: SimpleGit, message: string): Promise<{ success: boolean; error?: string }> {
  debug('Completing merge commit');
  try {
    // WHY absolute path: revparse --git-dir returns ".git" (relative). existsSync(join(".git", "rebase-merge"))
    // is resolved against process.cwd(), not the workdir (e.g. ~/.prr/work/<hash>). We'd never see
    // rebase-merge, run commit() during a rebase, and leave rebase-merge behind.
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const root = await git.revparse(['--show-toplevel']).catch(() => null);
    const gitDir = root ? join(root.trim(), '.git') : (await git.revparse(['--git-dir'])).trim();
    const inRebase = existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));

    if (inRebase) {
      debug('In rebase - continuing rebase');
      await continueRebase(git);
    } else {
      debug('In merge - committing');
      await git.commit(message);
    }
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

// Lock files that can be safely deleted and regenerated
export const LOCK_FILES: Record<string, { deletePattern: string; regenerateCmd: string }> = {
  'bun.lock': { deletePattern: 'bun.lock', regenerateCmd: 'bun install' },
  'bun.lockb': { deletePattern: 'bun.lockb', regenerateCmd: 'bun install' },
  'package-lock.json': { deletePattern: 'package-lock.json', regenerateCmd: 'npm install' },
  'yarn.lock': { deletePattern: 'yarn.lock', regenerateCmd: 'yarn install' },
  'pnpm-lock.yaml': { deletePattern: 'pnpm-lock.yaml', regenerateCmd: 'pnpm install' },
  'Cargo.lock': { deletePattern: 'Cargo.lock', regenerateCmd: 'cargo generate-lockfile' },
  'Gemfile.lock': { deletePattern: 'Gemfile.lock', regenerateCmd: 'bundle install' },
  'poetry.lock': { deletePattern: 'poetry.lock', regenerateCmd: 'poetry lock' },
  'composer.lock': { deletePattern: 'composer.lock', regenerateCmd: 'composer install' },
};

