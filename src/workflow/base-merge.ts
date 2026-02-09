/**
 * Base branch merge workflow functions
 * Handles merging the PR's base branch (e.g., main/master) into the PR branch
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import type { Ora } from 'ora';
import type { PRInfo } from '../github/types.js';
import type { CLIOptions } from '../cli.js';
import { debugStep, startTimer, endTimer } from '../logger.js';
import { mergeBaseBranch, startMergeForConflictResolution, abortMerge, completeMerge, markConflictsResolved } from '../git/git-clone-index.js';
import { isLockFile } from '../git/git-lock-files.js';

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
  resolveConflicts: (git: SimpleGit, files: string[], source: string) => Promise<{success: boolean; remainingConflicts: string[]}>
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
    
    // Fetch latest base branch first
    await git.fetch('origin', prInfo.baseBranch);
    
    const mergeResult = await mergeBaseBranch(git, prInfo.baseBranch);
    
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
        return { success: false, exitReason: 'error', exitDetails: error };
      }
      
      if (conflictedFiles.length === 0) {
        console.log(chalk.green(`✓ Already up-to-date with ${prInfo.baseBranch}`));
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
          await git.reset(['--hard', `origin/${prInfo.branch}`]);
          await git.clean('f', ['-d']);
          
          endTimer('Merge base branch');
          
          // Exit instead of continuing - don't work on unmerged code
          return {
            success: false,
            exitReason: 'merge_conflicts',
            exitDetails: `Could not auto-resolve ${resolution.remainingConflicts.length} conflict(s) with ${prInfo.baseBranch}`
          };
        } else {
          // All conflicts resolved - stage files and complete the merge
          const codeFiles = conflictedFiles.filter((f: string) => !isLockFile(f));
           const lockFiles = conflictedFiles.filter((f: string) => isLockFile(f));

           // Lock files should be regenerated — accept theirs to unblock the merge
           if (lockFiles.length > 0) {
             await git.checkout(['--theirs', '--', ...lockFiles]);
             await git.add(lockFiles);
             console.log(chalk.gray(`  ℹ ${lockFiles.length} lock file(s) accepted from ${prInfo.baseBranch} — consider regenerating`));
           }

           await markConflictsResolved(git, codeFiles);
          const commitResult = await completeMerge(git, `Merge branch '${prInfo.baseBranch}' into ${prInfo.branch}`);
          
          if (!commitResult.success) {
            console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
            return { success: false, exitReason: 'error', exitDetails: commitResult.error };
          }
          
          console.log(chalk.green(`✓ Conflicts resolved and merged ${prInfo.baseBranch}`));
          
          // Push the resolved merge commit
          if (!options.noPush && !options.noCommit) {
            try {
              spinner.start('Pushing merge commit...');
              await git.push('origin', prInfo.branch);
              spinner.succeed('Pushed merge commit');
            } catch (pushErr) {
              spinner.fail('Failed to push merge commit');
              console.log(chalk.yellow(`  Push failed: ${pushErr}. Merge commit remains local.`));
            }
          }
        }
      }
    }
    
    if (mergeResult.alreadyUpToDate) {
      console.log(chalk.green(`✓ Already up-to-date with ${prInfo.baseBranch}`));
    } else if (mergeResult.success) {
      console.log(chalk.green(`✓ Merged latest ${prInfo.baseBranch} into ${prInfo.branch}`));
      if (!options.noPush && !options.noCommit) {
        try {
          spinner.start('Pushing merge commit...');
          await git.push('origin', prInfo.branch);
          spinner.succeed('Pushed merge commit');
        } catch (pushErr) {
          spinner.fail('Failed to push merge commit');
          console.log(chalk.yellow(`  Push failed: ${pushErr}. Merge commit remains local.`));
        }
      } else {
        console.log(chalk.yellow('  Merge commit created locally. Use --push to push it.'));
      }
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
