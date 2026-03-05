/**
 * Git pull operations.
 * WHY fetchOriginBranch + options: pull's internal fetch must use the same one-shot token auth as conflict
 * check so we don't prompt for password when remote has no credentials (see git-conflicts.ts).
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';
import { abortMerge } from './git-merge.js';
import { fetchOriginBranch, type FetchOptions } from './git-conflicts.js';

export async function pullLatest(
  git: SimpleGit,
  branch: string,
  options?: FetchOptions
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
    // First, fetch to see what we're dealing with (use fetchOriginBranch so token auth works)
    await fetchOriginBranch(git, branch, options);

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
          // Don't abort - leave conflicts for programmatic resolution
          // WHY: If we abort, git status shows no conflicts and we can't resolve them
          debug('Rebase has conflicts - leaving in conflicted state for resolution');
          await restoreStashOnFailure();
          return { success: false, error: `Rebase conflicts detected` };
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

