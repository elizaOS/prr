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
  /** Fetch these branches after clone/update so refs exist (e.g. split-exec needs origin/targetBranch). */
  additionalBranches?: string[];
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

    // WHY set remote to auth URL when we have a token: otherwise every fetch/pull/push prompts for
    // password (bad DX when token is already in .env). Setting origin once here means no prompts
    // for the rest of the run. We redact the URL in all log/error output; workdir is ephemeral.
    if (githubToken && cloneUrl.startsWith('https://')) {
      await git.raw(['remote', 'set-url', 'origin', authUrl]);
      debug('Set origin remote URL with token so fetch/pull/push do not prompt', {
        tokenLength: githubToken.length,
      });
    } else if (!githubToken) {
      debug('No GitHub token provided - fetch/push may prompt for credentials');
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
      
      // Clean up any leftover merge/rebase state from previous runs (includes git clean -fd)
      await cleanupGitState(git);
      
      await git.fetch('origin', branch);
      await git.checkout(branch);
      await git.reset(['--hard', `origin/${branch}`]);
      if (options?.additionalBranches?.length) {
        for (const b of options.additionalBranches) {
          if (b && b !== branch) {
            try {
              await git.raw(['remote', 'set-branches', '--add', 'origin', b]);
              await git.fetch('origin', b);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              debug(`Failed to fetch origin/${b}`, { err: msg });
              const isBranchMissing = /couldn't find|does not exist|not found|invalid refspec/i.test(msg);
              if (isBranchMissing) {
                console.warn(`  ⚠ Branch ${b} does not exist on remote; ref origin/${b} will be missing.`);
              } else {
                console.warn(`  ⚠ Failed to fetch origin/${b}: ${msg.slice(0, 80)}${msg.length > 80 ? '…' : ''}`);
              }
            }
          }
        }
      }
      console.log(`Updated to latest ${branch}`);
    }
    
  } else {
    // Fresh clone
    git = simpleGit();
    
    console.log(`Cloning repository to ${workdir}...`);
    console.log('  (Large repos may take a few minutes.)');
    await git.clone(authUrl, workdir, ['--branch', branch, '--single-branch']);
    
    git = simpleGit(workdir);
    if (options?.additionalBranches?.length) {
      for (const b of options.additionalBranches) {
        if (b && b !== branch) {
          try {
            // --single-branch restricts the fetch refspec to the cloned branch only.
            // Without adding the refspec, `git fetch origin <b>` downloads objects but
            // does NOT create the tracking ref `origin/<b>`, so checkout fails later.
            await git.raw(['remote', 'set-branches', '--add', 'origin', b]);
            await git.fetch('origin', b);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            debug(`Failed to fetch origin/${b}`, { err: msg });
            const isBranchMissing = /couldn't find|does not exist|not found|invalid refspec/i.test(msg);
            if (isBranchMissing) {
              console.warn(`  ⚠ Branch ${b} does not exist on remote; ref origin/${b} will be missing.`);
            } else {
              console.warn(`  ⚠ Failed to fetch origin/${b}: ${msg.slice(0, 80)}${msg.length > 80 ? '…' : ''}`);
            }
          }
        }
      }
    }
    console.log(`Cloned ${branch} successfully`);
  }

  return { git, workdir };
}

