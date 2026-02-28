/**
 * Git conflict checking
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

export interface ConflictStatus {
  hasConflicts: boolean;
  conflictedFiles: string[];
  behindBy: number;
  aheadBy: number;
}


export async function checkForConflicts(git: SimpleGit, branch: string): Promise<ConflictStatus> {
  debug('Checking for conflicts', { branch });
  
  // Fetch latest from remote
  await git.fetch('origin', branch);
  
  const status = await git.status();
  
  // Check if there are merge conflicts
  const conflictedFiles = status.conflicted || [];
  
  // Check how far behind/ahead we are
  const behind = status.behind || 0;
  const ahead = status.ahead || 0;
  
  debug('Conflict check result', { conflicted: conflictedFiles.length, behind, ahead });
  
  return {
    hasConflicts: conflictedFiles.length > 0,
    conflictedFiles,
    behindBy: behind,
    aheadBy: ahead,
  };
}

/**
 * Quick check if remote has new commits without full conflict detection.
 * 
 * WHY: During fix iterations, we want to detect if someone pushed to the PR
 * so we can pull and re-verify instead of wasting cycles on stale code.
 * 
 * @returns Number of commits we're behind, or 0 if up-to-date
 */
export async function checkRemoteAhead(git: SimpleGit, branch: string): Promise<{ behind: number; ahead: number }> {
  debug('Quick check for remote commits', { branch });
  
  // Fetch latest refs (lightweight operation)
  await git.fetch('origin', branch);
  
  const status = await git.status();
  
  return {
    behind: status.behind || 0,
    ahead: status.ahead || 0,
  };
}

/**
 * Pull latest changes from remote, handling divergent branches and local changes.
 * 
 * WHY rebase: Keeps history clean. prr's commits should go on top of remote changes.
 * WHY auto-stash: Interrupted runs leave uncommitted changes that block pulls.
 * 
 * Flow:
 * 1. Stash any uncommitted changes
 * 2. Fetch latest from remote
 * 3. If branches diverged, rebase local commits on top of remote
 * 4. Pop stash and handle any conflicts
 */
