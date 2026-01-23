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
    // File might be new (untracked)
    return await git.diff(['--no-index', '/dev/null', file]).catch(() => '');
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

export async function pullLatest(git: SimpleGit, branch: string): Promise<{ success: boolean; error?: string; stashConflicts?: string[] }> {
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
      await git.stash(['push', '-m', 'prr-auto-stash-before-pull']);
      didStash = true;
      console.log(`  Stashed ${status.modified.length + status.created.length + status.deleted.length} local changes`);
    } catch (stashError) {
      debug('Failed to stash', { error: stashError });
      // Continue anyway - pull might still work
    }
  }
  
  try {
    await git.pull('origin', branch);
    
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
          return { success: true, stashConflicts: postPopStatus.conflicted };
        }
        
        // If pop failed but no conflicts, the stash is still there
        // Keep it so users can recover their changes
        console.warn('  ⚠ Could not restore stashed changes - kept in stash list');
        console.warn('    Use `git stash list` and `git stash pop` to recover (message: prr-auto-stash-before-pull)');
      }
    }
    
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    // If pull failed and we stashed, restore the stash
    if (didStash) {
      debug('Pull failed, restoring stash');
      try {
        await git.stash(['pop']);
        console.log('  Restored stashed changes (pull failed)');
      } catch {
        // Stash restore failed too - leave it in stash list
        console.log('  ⚠ Changes still in stash (use `git stash pop` to restore)');
      }
    }
    
    // Check if it's a merge conflict
    if (message.includes('CONFLICT') || message.includes('conflict')) {
      return { success: false, error: 'Merge conflicts detected' };
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
    
    // Try to merge
    debug('Attempting merge');
    await git.merge([`origin/${baseBranch}`, '--no-edit']);
    
    debug('Merge successful');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('Merge failed', { error: message });
    
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
  baseBranch: string
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
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
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

export async function findFilesWithConflictMarkers(workdir: string, files: string[]): Promise<string[]> {
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
