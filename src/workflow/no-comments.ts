/**
 * No comments workflow functions
 * Handles the case when no review comments are found
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import type { PRInfo } from '../github/types.js';
import type { CLIOptions } from '../cli.js';
import type { Config } from '../config.js';
import { startTimer, endTimer } from '../logger.js';
import { mergeBaseBranch, startMergeForConflictResolution, abortMerge, completeMerge } from '../git/git-clone-index.js';
import { pushWithRetry } from '../git/git-commit-index.js';

/**
 * Handle the "no comments" case - may need to resolve conflicts
 * Returns exit info if the run should terminate
 */
export async function handleNoComments(
  git: SimpleGit,
  prInfo: PRInfo,
  options: CLIOptions,
  config: Config,
  resolveConflicts: (git: SimpleGit, files: string[], source: string) => Promise<{success: boolean; remainingConflicts: string[]}>
): Promise<{
  shouldExit: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  // Check if there are unresolved conflicts
  const hasConflicts = prInfo.mergeable === false || prInfo.mergeableState === 'dirty';
  
  if (hasConflicts && !options.mergeBase) {
    // No comments but conflicts exist - auto-resolve since there's nothing else to do
    console.log(chalk.yellow('\nNo review comments found, but PR has merge conflicts.'));
    console.log(chalk.cyan(`  Auto-resolving conflicts with ${prInfo.baseBranch}...`));
    
    startTimer('Auto-resolve conflicts');
    // Ensure base branch ref is up-to-date before merging
    await git.fetch('origin', prInfo.baseBranch);
    const mergeResult = await mergeBaseBranch(git, prInfo.baseBranch);
    
    if (!mergeResult.success) {
      // Need LLM to resolve
      console.log(chalk.yellow('  Fast-forward merge failed, resolving conflicts with LLM...'));
      
      const { conflictedFiles, error } = await startMergeForConflictResolution(
        git,
        prInfo.baseBranch,
        `Merge branch '${prInfo.baseBranch}' into ${prInfo.branch}`
      );
      
      if (error && conflictedFiles.length === 0) {
        console.log(chalk.red(`✗ Failed to start merge: ${error}`));
        endTimer('Auto-resolve conflicts');
        return {
          shouldExit: true,
          exitReason: 'error',
          exitDetails: `Failed to merge ${prInfo.baseBranch}: ${error}`
        };
      }
      
      if (conflictedFiles.length > 0) {
        const resolution = await resolveConflicts(git, conflictedFiles, prInfo.baseBranch);
        
        if (!resolution.success) {
          console.log(chalk.red('\n✗ Could not resolve all merge conflicts automatically'));
          for (const file of resolution.remainingConflicts) {
            console.log(chalk.red(`    - ${file}`));
          }
          await abortMerge(git);
          return {
            shouldExit: true,
            exitReason: 'error',
            exitDetails: 'Could not auto-resolve merge conflicts'
          };
        }
        
        // Complete the merge
        const commitResult = await completeMerge(git, `Merge branch '${prInfo.baseBranch}' into ${prInfo.branch}`);
        if (!commitResult.success) {
          console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
          return {
            shouldExit: true,
            exitReason: 'error',
            exitDetails: `Failed to complete merge: ${commitResult.error}`
          };
        }
      }
    }
    
    console.log(chalk.green('  ✓ Conflicts resolved'));
    endTimer('Auto-resolve conflicts');
    
    // Push the merge commit
    if (!options.noPush && !options.noCommit) {
      console.log(chalk.gray(`  Pushing merge commit...`));
      try {
        await pushWithRetry(git, prInfo.branch, { githubToken: config.githubToken });
        console.log(chalk.green(`  ✓ Pushed to origin/${prInfo.branch}`));
      } catch (err) {
        console.error(chalk.red(`  ✗ Failed to push ${prInfo.branch}: ${err instanceof Error ? err.message : String(err)}`));
        return {
          shouldExit: true,
          exitReason: 'error',
          exitDetails: `Failed to push to ${prInfo.branch}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    
    return {
      shouldExit: true,
      exitReason: 'no_comments',
      exitDetails: `No review comments, but conflicts with ${prInfo.baseBranch} were resolved`
    };
  } else if (hasConflicts && options.mergeBase) {
    // Conflicts should have been resolved above
    console.log(chalk.green('\nNo review comments found. Conflicts were resolved above.'));
    return {
      shouldExit: true,
      exitReason: 'no_comments',
      exitDetails: 'No review comments on the PR (conflicts resolved)'
    };
  } else {
    console.log(chalk.green('\nNo review comments found. Nothing to do!'));
    return {
      shouldExit: true,
      exitReason: 'no_comments',
      exitDetails: 'No review comments found on the PR'
    };
  }
}
