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

