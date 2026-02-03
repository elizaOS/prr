/**
 * Git operations for cloning, fetching, and handling conflicts.
 * 
 * WHY simple-git: Type-safe wrapper around git CLI, handles async operations
 * and error parsing. More reliable than exec('git ...').
 * 
 * WHY preserveChanges option: Interrupted runs leave uncommitted changes.
 * Without this, restart would wipe them via hard reset.
 * 
 * WHY auto-stashing: User interrupts prr with Ctrl+C. Changes exist but aren't
 * committed. Next run does `git pull` which fails "local changes would be
 * overwritten". Auto-stash makes this seamless.
 * 
 * NOTE: Token is embedded in remote URL for HTTPS auth. This is stored in
 * .git/config but workdirs are local-only and not committed anywhere.
 */
import { simpleGit, SimpleGit } from 'simple-git';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { debug } from '../logger.js';

export interface GitOperations {
  git: SimpleGit;
  workdir: string;
}


export interface ConflictStatus {
  hasConflicts: boolean;
  conflictedFiles: string[];
  behindBy: number;
  aheadBy: number;
}

export interface CloneOptions {
  preserveChanges?: boolean;  // If true, don't reset - keep existing uncommitted changes
}

export async function cloneOrUpdate(
  cloneUrl: string,
  branch: string,
  workdir: string,
  githubToken?: string,
  options?: CloneOptions
): Promise<GitOperations> {
  // Inject token into clone URL for authentication
  let authUrl = cloneUrl;
  if (githubToken && cloneUrl.startsWith('https://')) {
    authUrl = cloneUrl.replace('https://', `https://${githubToken}@`);
  }

  const gitDir = join(workdir, '.git');
  const isExistingRepo = existsSync(gitDir);

  let git: SimpleGit;

  if (isExistingRepo) {
    git = simpleGit(workdir);
    
    // Ensure token is in remote URL for authentication
    // WHY: Old versions stripped the token, or workdir may have been created
    // before we embedded tokens. Re-inject to ensure push works.
    if (githubToken) {
      await git.raw(['remote', 'set-url', 'origin', authUrl]);
      debug('Ensured token is in remote URL', { 
        hasToken: true, 
        tokenLength: githubToken.length,
        urlContainsAt: authUrl.includes('@'),
      });
    } else {
      debug('No GitHub token provided - push may require manual auth');
      // Get current remote URL to check if it has a token
      try {
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        const hasTokenInUrl = origin?.refs?.push?.includes('@') || false;
        debug('Remote URL status', { hasTokenInUrl });
      } catch {
        // Ignore errors checking remote
      }
    }
    
    if (options?.preserveChanges) {
      // Preserve existing changes - just make sure we're on the right branch
      console.log('Existing workdir found, preserving local changes...');
      const status = await git.status();
      const hasChanges = status.modified.length > 0 || status.created.length > 0 || status.staged.length > 0;
      if (hasChanges) {
        console.log(`  Keeping ${status.modified.length + status.created.length} modified files`);
      }
      // Just ensure we're on the right branch, don't reset
      try {
        await git.checkout(branch);
      } catch {
        // Already on branch or changes prevent checkout - that's fine
      }
    } else {
      // Clean start - reset everything
      console.log('Existing workdir found, cleaning up and fetching latest...');
      
      // Clean up any leftover merge/rebase state from previous runs
      await cleanupGitState(git);
      
      await git.fetch('origin', branch);
      await git.checkout(branch);
      await git.reset(['--hard', `origin/${branch}`]);
      
      console.log(`Updated to latest ${branch}`);
    }
    
  } else {
    // Fresh clone
    git = simpleGit();
    
    console.log(`Cloning repository to ${workdir}...`);
    await git.clone(authUrl, workdir, ['--branch', branch, '--single-branch']);
    
    git = simpleGit(workdir);
    
    console.log(`Cloned ${branch} successfully`);
  }

  return { git, workdir };
}

export async function getChangedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];
}

export async function getDiff(git: SimpleGit, file?: string): Promise<string> {
  if (file) {
    return git.diff(['--', file]);
  }
  return git.diff();
}

export async function getDiffForFile(git: SimpleGit, file: string): Promise<string> {
  try {
    return await git.diff(['HEAD', '--', file]);
  } catch {
    // File might be new (untracked), try --no-index diff
    try {
      return await git.diff(['--no-index', '/dev/null', file]);
    } catch (err) {
      // Log error but return empty - file may not exist or have permission issues
      debug('Failed to get diff for file', { file, error: err instanceof Error ? err.message : String(err) });
      return '';
    }
  }
}

export async function hasChanges(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
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
export async function pullLatest(
  git: SimpleGit,
  branch: string
): Promise<{ success: boolean; error?: string; stashConflicts?: string[]; stashLeft?: boolean; rebased?: boolean }> {
  debug('Pulling latest changes', { branch });
  
  // Check for uncommitted changes and stash them
  // WHY: Interrupted runs may leave uncommitted changes that block pulls
  const status = await git.status();
  const hasLocalChanges = !status.isClean();
  let didStash = false;
  
  if (hasLocalChanges) {
    debug('Stashing local changes before pull', { 
      modified: status.modified.length,
      created: status.created.length,
      deleted: status.deleted.length,
    });
    try {
      await git.stash(['push', '-u', '-m', 'prr-auto-stash-before-pull']);
      didStash = true;
      console.log(`  Stashed ${status.modified.length + status.created.length + status.deleted.length} local changes`);
    } catch (stashError) {
      debug('Failed to stash', { error: stashError });
      // Continue anyway - pull might still work
    }
  }
  
  // Helper to restore stash on failure
  const restoreStashOnFailure = async () => {
    if (didStash) {
      debug('Restoring stash after failure');
      try {
        await git.stash(['pop']);
        console.log('  Restored stashed changes');
      } catch {
        console.log('  ⚠ Changes still in stash (use `git stash pop` to restore)');
      }
    }
  };
  
  try {
    // First, fetch to see what we're dealing with
    await git.fetch('origin', branch);
    
    // Check if branches have diverged
    const postFetchStatus = await git.status();
    const ahead = postFetchStatus.ahead || 0;
    const behind = postFetchStatus.behind || 0;
    
    debug('Post-fetch status', { ahead, behind });
    
    let rebased = false;
    
    if (ahead > 0 && behind > 0) {
      // Branches have diverged - need to rebase our commits on top of remote
      debug('Branches diverged, rebasing local commits on remote');
      console.log(`  Rebasing ${ahead} local commit(s) onto ${behind} remote commit(s)...`);
      
      try {
        await git.rebase([`origin/${branch}`]);
        rebased = true;
        console.log('  Rebase successful');
      } catch (rebaseError) {
        const rebaseMsg = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);
        debug('Rebase failed', { error: rebaseMsg });
        
        // Check for rebase conflicts
        if (rebaseMsg.includes('CONFLICT') || rebaseMsg.includes('conflict')) {
          // Abort the rebase and restore state
          try {
            await git.rebase(['--abort']);
            debug('Aborted failed rebase');
          } catch {
            // Ignore abort errors
          }
          await restoreStashOnFailure();
          return { success: false, error: `Rebase conflicts detected. Manual resolution needed.` };
        }
        
        // Other rebase failure - abort and fall back to merge
        try {
          await git.rebase(['--abort']);
        } catch {
          // Ignore
        }
        
        debug('Rebase failed, falling back to merge');
        console.log('  Rebase failed, trying merge...');
        
        try {
          await git.merge([`origin/${branch}`]);
          console.log('  Merged remote changes');
        } catch (mergeError) {
          const mergeMsg = mergeError instanceof Error ? mergeError.message : String(mergeError);
          await abortMerge(git);
          await restoreStashOnFailure();
          return { success: false, error: `Failed to sync with remote: ${mergeMsg}` };
        }
      }
    } else if (behind > 0) {
      // Just behind - simple fast-forward pull
      debug('Fast-forward pull');
      await git.pull('origin', branch, { '--ff-only': null });
    }
    // If only ahead (or equal), nothing to pull
    
    // If we stashed, try to restore
    if (didStash) {
      debug('Restoring stashed changes');
      try {
        await git.stash(['pop']);
        console.log('  Restored stashed changes');
      } catch (popError) {
        const popMessage = popError instanceof Error ? popError.message : String(popError);
        debug('Stash pop failed', { error: popMessage });
        
        // Check if there are conflicts from stash pop
        const postPopStatus = await git.status();
        if (postPopStatus.conflicted && postPopStatus.conflicted.length > 0) {
          console.log(`  ⚠ Stash conflicts in: ${postPopStatus.conflicted.join(', ')}`);
          // Keep the stash conflicts - user's changes need to be reconciled
          return { success: true, stashConflicts: postPopStatus.conflicted, rebased };
        }
        
        // If pop failed but no conflicts, the stash is still there
        // Keep it so users can recover their changes
        console.warn('  ⚠ Could not restore stashed changes - kept in stash list');
        console.warn('    Use `git stash list` and `git stash pop` to recover (message: prr-auto-stash-before-pull)');
        return { success: true, stashLeft: true, rebased };
      }
    }
    
    return { success: true, rebased };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('Pull/sync failed', { error: message });
    
    await restoreStashOnFailure();
    
    // Check if it's a merge conflict
    if (message.includes('CONFLICT') || message.includes('conflict')) {
      return { success: false, error: 'Merge conflicts detected' };
    }
    
    // Check for divergent branches error (shouldn't happen now but just in case)
    if (message.includes('divergent branches') || message.includes('Need to specify how to reconcile')) {
      return { success: false, error: 'Branches have diverged. This should have been handled automatically - please report this bug.' };
    }
    
    return { success: false, error: message };
  }
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
    try {
      await git.merge([`origin/${baseBranch}`, '--no-commit']);
    } catch {
      // Expected to fail with conflicts
    }
    
    // Get conflicted files
    const status = await git.status();
    const conflictedFiles = status.conflicted || [];
    
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

export async function completeMerge(git: SimpleGit, message: string): Promise<{ success: boolean; error?: string }> {
  debug('Completing merge commit');
  try {
    await git.commit(message);
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

export function isLockFile(filepath: string): boolean {
  const filename = filepath.split('/').pop() || filepath;
  return Object.keys(LOCK_FILES).includes(filename);
}

export function getLockFileInfo(filepath: string): { deletePattern: string; regenerateCmd: string } | null {
  const filename = filepath.split('/').pop() || filepath;
  return LOCK_FILES[filename] || null;
}

export function hasConflictMarkers(content: string): boolean {
  return content.includes('<<<<<<<') || 
         content.includes('=======') || 
         content.includes('>>>>>>>');
}

export function findFilesWithConflictMarkers(workdir: string, files: string[]): string[] {
  const conflicted: string[] = [];
  
  for (const file of files) {
    const fullPath = join(workdir, file);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        if (hasConflictMarkers(content)) {
          conflicted.push(file);
        }
      } catch {
        // Can't read file, skip
      }
    }
  }
  
  return conflicted;
}
