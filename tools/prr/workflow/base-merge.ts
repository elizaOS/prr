/**
 * Base branch merge workflow functions
 * Handles merging the PR's base branch (e.g., main/master) into the PR branch
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import type { Ora } from 'ora';
import type { PRInfo } from '../github/types.js';
import type { CLIOptions } from '../cli.js';
import type { GitHubAPI } from '../github/api.js';
import { debug, debugStep, startTimer, endTimer, formatNumber } from '../../../shared/logger.js';
import { mergeBaseBranch, startMergeForConflictResolution, abortMerge, completeMerge, markConflictsResolved, isLockFile } from '../../../shared/git/git-clone-index.js';
import { push } from '../../../shared/git/git-push.js';

/**
 * Check and merge base branch into PR branch
 * WHY: Always try to merge base branch when --merge-base is enabled (default).
 * This ensures we're working with up-to-date code even if GitHub says "mergeable"
 */
export async function checkAndMergeBaseBranch(
  git: SimpleGit,
  prInfo: PRInfo,
  options: CLIOptions,
  spinner: Ora,
  resolveConflicts: (git: SimpleGit, files: string[], source: string) => Promise<{success: boolean; remainingConflicts: string[]}>,
  githubToken?: string,
  github?: GitHubAPI
): Promise<{
  success: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  debugStep('CHECKING PR MERGE STATUS');
  
  const githubSaysConflicts = prInfo.mergeable === false || prInfo.mergeableState === 'dirty';
  const githubStillCalculating = prInfo.mergeable === null;
  
  if (githubSaysConflicts) {
    console.log(chalk.yellow(`⚠ PR has conflicts with ${prInfo.baseBranch}`));
  } else if (githubStillCalculating) {
    console.log(chalk.gray(`  GitHub is still calculating merge status - will try local merge...`));
  }
  
  // Always try to merge base branch when --merge-base is enabled (default)
  if (options.mergeBase) {
    startTimer('Merge base branch');
    console.log(chalk.cyan(`  Syncing with origin/${prInfo.baseBranch}...`));

    // Stash uncommitted changes so merge can run (e.g. .gitignore modified by ensureStateFileIgnored)
    const status = await git.status();
    const hadLocalChanges = !status.isClean();
    let didStash = false;
    if (hadLocalChanges) {
      debug('Stashing local changes before base merge', {
        modified: status.modified.length,
        created: status.created.length,
        deleted: status.deleted.length,
      });
      try {
        await git.stash(['push', '-u', '-m', 'prr-auto-stash-before-base-merge']);
        didStash = true;
        console.log(chalk.gray(`  Stashed ${status.modified.length + status.created.length + status.deleted.length} local change(s) before merge`));
      } catch (stashErr) {
        debug('Failed to stash before base merge', { error: stashErr });
      }
    }

    const restoreStash = async (): Promise<void> => {
      if (!didStash) return;
      try {
        await git.stash(['pop']);
        console.log(chalk.gray('  Restored stashed changes'));
      } catch {
        const postStatus = await git.status();
        const conflicted = postStatus.conflicted || [];
        if (conflicted.length > 0) {
          console.log(chalk.yellow('  ⚠ Stash pop had conflicts in: ' + conflicted.join(', ') + ' — left in working tree'));
        } else {
          console.log(chalk.yellow('  ⚠ Changes still in stash (use `git stash pop` to restore)'));
        }
      }
    };

    try {
    // Fetch latest base branch and PR branch first
    await git.fetch('origin', prInfo.baseBranch);
    await git.fetch('origin', prInfo.branch);

    // When the PR branch is behind the base (locally or per GitHub), merge with --no-ff and push so the branch is up to date. Use local state after fetch so we don't rely only on GitHub's mergeableState (which can be stale or missing). WHY: User expects PRR to "update the branch, pull target into source, and push" so the PR is not "out of date with base branch".
    const headSha = (await git.revparse(['HEAD'])).trim();
    const baseSha = (await git.revparse([`origin/${prInfo.baseBranch}`])).trim();
    const mergeBaseSha = (await git.raw(['merge-base', 'HEAD', `origin/${prInfo.baseBranch}`])).trim();
    const isBehindLocally = baseSha !== mergeBaseSha;
    const forceMerge = isBehindLocally || prInfo.mergeableState?.toLowerCase() === 'behind';
    debug('Base merge decision', {
      headSha: headSha.slice(0, 10),
      baseSha: baseSha.slice(0, 10),
      mergeBaseSha: mergeBaseSha.slice(0, 10),
      isBehindLocally,
      githubMergeableState: prInfo.mergeableState,
      forceMerge,
    });
    const mergeResult = await mergeBaseBranch(git, prInfo.baseBranch, { forceMerge, noFastForward: forceMerge });
    debug('Base merge result', { success: mergeResult.success, alreadyUpToDate: mergeResult.alreadyUpToDate, error: mergeResult.error });

    if (!mergeResult.success) {
      // Merge failed - use LLM tool to resolve conflicts
      console.log(chalk.yellow('  Merge has conflicts, resolving...'));
      
      // Start the merge to get conflict markers in files
      const { conflictedFiles, error } = await startMergeForConflictResolution(
        git,
        prInfo.baseBranch,
        `Merge branch '${prInfo.baseBranch}' into ${prInfo.branch}`
      );
      
      if (error && conflictedFiles.length === 0) {
        console.log(chalk.red(`✗ Failed to start merge: ${error}`));
        await restoreStash();
        endTimer('Merge base branch');
        return { success: false, exitReason: 'error', exitDetails: error };
      }
      
      if (conflictedFiles.length === 0) {
        console.log(chalk.green(`✓ Already up-to-date with ${prInfo.baseBranch}`));
        await restoreStash();
        endTimer('Merge base branch');
        return { success: true };
      } else {
        // Use the shared conflict resolution method
        const resolution = await resolveConflicts(
          git,
          conflictedFiles,
          prInfo.baseBranch
        );
        
        if (!resolution.success) {
          console.log(chalk.red('\n✗ Could not resolve all merge conflicts automatically'));
          console.log(chalk.red('  Remaining conflicts:'));
          for (const file of resolution.remainingConflicts) {
            console.log(chalk.red(`    - ${file}`));
          }
          console.log(chalk.yellow('\n  These conflicts must be resolved before prr can continue.'));
          console.log(chalk.gray('\n  To resolve manually:'));
          console.log(chalk.gray(`    1. Checkout the branch: git checkout ${prInfo.branch}`));
          console.log(chalk.gray(`    2. Merge base branch: git merge ${prInfo.baseBranch}`));
          console.log(chalk.gray(`    3. Resolve conflicts in your editor`));
          console.log(chalk.gray(`    4. Commit: git commit`));
          console.log(chalk.gray(`    5. Re-run prr`));
          console.log(chalk.gray('\n  Alternative:'));
          console.log(chalk.gray('    Use --no-merge-base to skip base branch merge (not recommended)'));
          
          // Abort merge and reset to clean state
          await abortMerge(git);
          await git.fetch('origin', prInfo.branch);
          await git.reset(['--hard', 'FETCH_HEAD']);
          await git.raw(['clean', '-fd']);
          await restoreStash();
          endTimer('Merge base branch');
          return {
            success: false,
            exitReason: 'merge_conflicts',
            exitDetails: `Could not auto-resolve ${resolution.remainingConflicts.length.toLocaleString()} conflict(s) with ${prInfo.baseBranch}`
          };
        } else {
          // All conflicts resolved - stage files and complete the merge
          const codeFiles = conflictedFiles.filter((f: string) => !isLockFile(f));
          const lockFiles = conflictedFiles.filter((f: string) => isLockFile(f));

          // Lock files should be regenerated — accept theirs to unblock the merge
          if (lockFiles.length > 0) {
            await git.checkout(['--theirs', '--', ...lockFiles]);
            await git.add(lockFiles);
            console.log(chalk.gray(`  ℹ ${formatNumber(lockFiles.length)} lock file(s) accepted from ${prInfo.baseBranch} — consider regenerating`));
          }

          await markConflictsResolved(git, codeFiles);
          const commitResult = await completeMerge(git, `Merge branch '${prInfo.baseBranch}' into ${prInfo.branch}`);
          
          if (!commitResult.success) {
            console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
            await restoreStash();
            endTimer('Merge base branch');
            return { success: false, exitReason: 'error', exitDetails: commitResult.error };
          }
          console.log(chalk.green(`✓ Conflicts resolved and merged ${prInfo.baseBranch}`));
          if (!options.noPush && !options.noCommit) {
            spinner.start('Pushing merge commit...');
            const pushResult = await push(git, prInfo.branch, false, githubToken);
            if (pushResult.success) {
              spinner.succeed('Pushed merge commit');
            } else {
              spinner.fail('Failed to push merge commit');
              console.log(chalk.yellow(`  Push failed: ${pushResult.error ?? 'Unknown'}. Merge commit remains local; PR will stay "out of date with base".`));
              console.log(chalk.gray(`  To update the PR, push from the workdir: git push origin ${prInfo.branch}`));
            }
          } else {
            console.log(chalk.yellow('  Merge commit created locally (--no-push or --no-commit). PR will stay "out of date with base" until you push:'));
            console.log(chalk.gray(`     git push origin ${prInfo.branch}`));
          }
          await restoreStash();
          endTimer('Merge base branch');
          return { success: true };
        }
      }
    }
    
    const githubSaysBehind = prInfo.mergeableState?.toLowerCase() === 'behind';

    const tryApiUpdateBranch = async (): Promise<void> => {
      if (!github || !githubSaysBehind || options.noPush || options.noCommit) return;
      debug('Local merge was no-op but GitHub says behind — falling back to GitHub API updateBranch', {
        mergeableState: prInfo.mergeableState,
      });
      spinner.start(`Updating ${prInfo.branch} via GitHub API...`);
      const ok = await github.updatePRBranch(prInfo.owner, prInfo.repo, prInfo.number);
      if (ok) {
        spinner.succeed(`Branch update accepted by GitHub API — fetching updated branch`);
        await git.fetch('origin', prInfo.branch);
        const newHead = (await git.revparse([`origin/${prInfo.branch}`])).trim();
        await git.reset(['--hard', `origin/${prInfo.branch}`]);
        debug('Local branch reset to API-updated remote', { newHead: newHead.slice(0, 10) });
      } else {
        spinner.warn('GitHub API branch update failed — branch may already be current or token lacks permission');
      }
    };

    if (mergeResult.alreadyUpToDate) {
      console.log(chalk.green(`✓ Already up-to-date with ${prInfo.baseBranch}`));
      if (githubSaysBehind) {
        console.log(chalk.gray(`  (GitHub says "behind" but git merge-base confirms all ${prInfo.baseBranch} commits are in ${prInfo.branch} — GitHub state may be stale)`));
      }
      if (!options.noPush && !options.noCommit) {
        const status = await git.status();
        if (status.ahead > 0) {
          debug('Local branch is ahead after merge (unpushed commits from previous run)', { ahead: status.ahead });
          spinner.start(`Pushing ${status.ahead} unpushed commit(s)...`);
          const pushResult = await push(git, prInfo.branch, false, githubToken);
          if (pushResult.success && !pushResult.nothingToPush) {
            spinner.succeed(`Pushed ${status.ahead} unpushed commit(s)`);
          } else if (pushResult.success) {
            spinner.info('Push reports nothing to push (remote already has these commits)');
          } else {
            spinner.warn(`Push of unpushed commits failed: ${pushResult.error ?? 'Unknown'}`);
          }
        }
      }
      await tryApiUpdateBranch();
      await restoreStash();
    } else if (mergeResult.success) {
      console.log(chalk.green(`✓ Merged latest ${prInfo.baseBranch} into ${prInfo.branch}`));
      if (!options.noPush && !options.noCommit) {
        spinner.start('Pushing merge commit...');
        const pushResult = await push(git, prInfo.branch, false, githubToken);
        if (pushResult.success) {
          if (pushResult.nothingToPush) {
            spinner.succeed('Branch already up-to-date with remote (merge brought in no new commits to push)');
            await tryApiUpdateBranch();
          } else {
            spinner.succeed('Pushed merge commit');
          }
        } else {
          spinner.fail('Failed to push merge commit');
          console.log(chalk.yellow(`  Push failed: ${pushResult.error ?? 'Unknown'}. Merge commit remains local; PR will stay "out of date with base".`));
          console.log(chalk.gray(`  To update the PR, push from the workdir: git push origin ${prInfo.branch}`));
        }
      } else {
        console.log(chalk.yellow('  Merge commit created locally (--no-push or --no-commit). PR will stay "out of date with base" until you push:'));
        console.log(chalk.gray(`     git push origin ${prInfo.branch}`));
      }
      await restoreStash();
    }
    } catch (unexpectedErr) {
      await restoreStash();
      throw unexpectedErr;
    }
    endTimer('Merge base branch');
  } else {
    // --no-merge-base was explicitly set
    if (githubSaysConflicts) {
      console.log(chalk.gray(`  Skipping base branch merge (--no-merge-base set)`));
      console.log(chalk.gray('  Continuing to fix review comments on current branch state...'));
    } else {
      console.log(chalk.green(`✓ PR is mergeable with ${prInfo.baseBranch}`));
    }
  }
  
  return { success: true };
}
