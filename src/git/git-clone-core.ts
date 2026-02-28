/**
 * Git clone and update operations
 */
import { simpleGit, type SimpleGit } from 'simple-git';
import { existsSync } from 'fs';
import { join } from 'path';
import { debug } from '../logger.js';
import { cleanupGitState } from './git-merge.js';
import type { ConflictStatus } from './git-conflicts.js';

export interface GitOperations {
  git: SimpleGit;
  workdir: string;
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
    
    // Note: We no longer persist tokens in the remote URL to avoid credential leakage.
    // Network operations (push/fetch) should use ephemeral auth (extraheader/credential helper).
    if (githubToken) {
      // Ensure remote URL is clean (no embedded token) - strip any existing token
      const cleanUrl = cloneUrl.replace(/https:\/\/[^@]+@/, 'https://');
      await git.raw(['remote', 'set-url', 'origin', cleanUrl]);
      debug('Ensured remote URL is clean (no persisted token)', { 
        hasToken: true, 
        tokenLength: githubToken.length,
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
      
      // Abort any stuck rebase/merge/cherry-pick from a previous failed run.
      // Without this, a prior crash mid-rebase leaves the workdir in an
      // unusable state and every subsequent run fails at the same point.
      const { existsSync: fsExists } = await import('fs');
      const rebaseMerge = join(workdir, '.git', 'rebase-merge');
      const rebaseApply = join(workdir, '.git', 'rebase-apply');
      const mergeHead = join(workdir, '.git', 'MERGE_HEAD');
      const cherryPickHead = join(workdir, '.git', 'CHERRY_PICK_HEAD');
      if (fsExists(rebaseMerge) || fsExists(rebaseApply) || fsExists(mergeHead) || fsExists(cherryPickHead)) {
        console.log('  ⚠ Detected stuck rebase/merge from previous run, aborting...');
        try { await git.rebase(['--abort']); } catch { /* no rebase */ }
        try { await git.merge(['--abort']); } catch { /* no merge */ }
        try { await git.raw(['cherry-pick', '--abort']); } catch { /* no cherry-pick */ }
        debug('Aborted stuck git operation in preserveChanges path');
      }
      
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

