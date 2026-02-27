/**
 * Repository workflow functions
 * Handles cloning, updating, state recovery, and conflict resolution
 */

import type { SimpleGit } from 'simple-git';
import type { Ora } from 'ora';
import type { PRInfo } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import * as Rotation from '../state/state-rotation.js';
import type { Runner } from '../runners/types.js';
import chalk from 'chalk';
import { debug, debugStep, startTimer, endTimer } from '../logger.js';
import { formatNumber } from '../ui/reporter.js';
import { cloneOrUpdate, checkForConflicts, pullLatest, abortMerge, completeMerge, cleanupGitState } from '../git/git-clone-index.js';
import { scanCommittedFixes } from '../git/git-commit-index.js';

/**
 * Restore runner and model rotation state from previous session
 */
export function restoreRunnerRotationState(
  stateContext: StateContext,
  runners: Runner[],
  modelIndices: Map<string, number>,
  getCurrentModel: () => string | null | undefined
): {
  runner: Runner | null;
  runnerIndex: number;
} {
  const savedRunnerIndex = Rotation.getCurrentRunnerIndex(stateContext);
  const savedModelIndices = Rotation.getModelIndices(stateContext);
  
  let runner: Runner | null = null;
  let runnerIndex = 0;
  
  if (savedRunnerIndex > 0 && savedRunnerIndex < runners.length) {
    runnerIndex = savedRunnerIndex;
    runner = runners[savedRunnerIndex];
    console.log(chalk.gray(`  Resuming at tool: ${runner.displayName} (from previous session)`));
  }
  
  if (Object.keys(savedModelIndices).length > 0) {
    for (const [runnerName, index] of Object.entries(savedModelIndices)) {
      modelIndices.set(runnerName, index);
    }
    const currentModel = getCurrentModel();
    if (currentModel) {
      console.log(chalk.gray(`  Resuming at model: ${currentModel} (from previous session)`));
    }
  }
  
  return { runner, runnerIndex };
}

/**
 * Clone or update repository
 */
export async function cloneOrUpdateRepository(
  prInfo: PRInfo,
  workdir: string,
  githubToken: string,
  hasVerifiedFixes: boolean,
  spinner: Ora
): Promise<SimpleGit> {
  debugStep('CLONING/UPDATING REPOSITORY');
  spinner.start('Setting up repository...');
  const { git } = await cloneOrUpdate(
    prInfo.cloneUrl,
    prInfo.branch,
    workdir,
    githubToken,
    { preserveChanges: hasVerifiedFixes }
  );
  spinner.succeed('Repository ready');
  debug('Repository cloned/updated at', workdir);
  
  return git;
}

/**
 * Recover verification state from git commit messages
 */
export async function recoverVerificationState(
  git: SimpleGit,
  branch: string,
  stateContext: StateContext
): Promise<void> {
  debugStep('RECOVERING STATE FROM GIT');
  const committedFixes = await scanCommittedFixes(git, branch);
  if (committedFixes.length > 0) {
    console.log(chalk.cyan(`Recovered ${formatNumber(committedFixes.length)} previously committed fix(es) from git history`));
    for (const commentId of committedFixes) {
      Verification.markVerified(stateContext, commentId);
    }
    await State.saveState(stateContext);
    debug('Recovered verifications from git', { count: committedFixes.length });
  }
}

/**
 * Check for conflicts and sync with remote, auto-resolving if possible
 */
export async function checkAndSyncWithRemote(
  git: SimpleGit,
  branch: string,
  spinner: Ora,
  resolveConflicts: (git: SimpleGit, files: string[], source: string) => Promise<{success: boolean; remainingConflicts: string[]}>
): Promise<{success: boolean; error?: string}> {
  // Check for conflicts and sync with remote
  // WHY CHECK EARLY: Conflict markers in files will cause fixer tools to fail confusingly.
  // Better to detect and resolve conflicts upfront before entering the fix loop.
  debugStep('CHECKING FOR CONFLICTS');
  spinner.start('Checking for conflicts with remote...');
  const conflictStatus = await checkForConflicts(git, branch);
  spinner.stop();

  if (conflictStatus.hasConflicts) {
    // WHY AUTO-RESOLVE: Previously, prr would bail out here with "resolve manually".
    // This was frustrating because the same LLM tools that fix review comments can
    // also resolve merge conflicts. Auto-resolution keeps the workflow seamless.
    console.log(chalk.yellow('⚠ Merge conflicts detected from previous operation'));
    console.log(chalk.cyan('  Attempting to resolve conflicts automatically...'));
    
    startTimer('Resolve remote conflicts');
    const resolution = await resolveConflicts(
      git,
      conflictStatus.conflictedFiles,
      `origin/${branch}`
    );
    
    if (!resolution.success) {
      console.log(chalk.red('\n✗ Could not resolve all merge conflicts automatically'));
      console.log(chalk.red('  Remaining conflicts:'));
      for (const file of resolution.remainingConflicts) {
        console.log(chalk.red(`    - ${file}`));
      }
      console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
      await cleanupGitState(git);
      endTimer('Resolve remote conflicts');
      return { success: false, error: 'Unresolved merge conflicts' };
    }
    
    // All conflicts resolved - complete the merge
    const commitResult = await completeMerge(git, `Merge remote-tracking branch 'origin/${branch}'`);
    
    if (!commitResult.success) {
      console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
      await cleanupGitState(git);
      endTimer('Resolve remote conflicts');
      return { success: false, error: commitResult.error };
    }
    
    console.log(chalk.green('✓ Conflicts resolved and merge completed'));
    endTimer('Resolve remote conflicts');
  }

  if (conflictStatus.behindBy > 0) {
    console.log(chalk.yellow(`⚠ Branch is ${conflictStatus.behindBy} commits behind remote`));
    spinner.start('Pulling latest changes...');
    const pullResult = await pullLatest(git, branch);
    
    if (!pullResult.success) {
      spinner.fail('Failed to pull');
      console.log(chalk.red(`  Error: ${pullResult.error}`));
      
      if (pullResult.error?.includes('conflict')) {
        console.log(chalk.cyan(`  Attempting to resolve pull/rebase conflicts automatically...`));
        startTimer('Resolve pull conflicts');
        
        // Rebase can conflict on multiple commits. Loop: resolve current
        // conflict, continue rebase, handle next conflict if any.
        // Cap iterations to avoid infinite loops on pathological cases.
        const MAX_REBASE_CONFLICT_ROUNDS = 50;
        let resolvedRounds = 0;
        
        for (let round = 0; round < MAX_REBASE_CONFLICT_ROUNDS; round++) {
          const status = await git.status();
          const conflictedFiles = status.conflicted || [];
          
          if (conflictedFiles.length === 0) {
            // No more conflicts — check if rebase is still in progress
            // (it might have auto-continued to completion)
            const { existsSync: fsExists } = await import('fs');
            const { join: pathJoin } = await import('path');
            const gitDir = await git.revparse(['--git-dir']).catch(() => '.git');
            const inRebase = fsExists(pathJoin(gitDir.trim(), 'rebase-merge')) || fsExists(pathJoin(gitDir.trim(), 'rebase-apply'));
            if (!inRebase) break;
            // Rebase in progress but no conflicts — continue it
            try {
              await git.rebase(['--continue']);
            } catch {
              break;
            }
            continue;
          }
          
          debug('Rebase conflict round', { round: round + 1, conflictedFiles: conflictedFiles.length });
          console.log(chalk.cyan(`  Rebase conflict round ${round + 1}: ${conflictedFiles.length} file(s)`));
          
          const resolution = await resolveConflicts(
            git,
            conflictedFiles,
            `origin/${branch}`
          );
          debug('Pull conflict resolution result', { round: round + 1, success: resolution.success, remaining: resolution.remainingConflicts.length });
          
          if (!resolution.success) {
            console.log(chalk.red('\n✗ Could not resolve pull conflicts automatically'));
            console.log(chalk.red('  Remaining conflicts:'));
            for (const file of resolution.remainingConflicts) {
              console.log(chalk.red(`    - ${file}`));
            }
            console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
            await cleanupGitState(git);
            endTimer('Resolve pull conflicts');
            return { success: false, error: 'Unresolved pull conflicts' };
          }
          
          resolvedRounds++;
          
          // Continue the rebase to apply the next commit
          const commitResult = await completeMerge(git, `Merge remote-tracking branch 'origin/${branch}'`);
          
          if (!commitResult.success) {
            // completeMerge failure during rebase often means the next commit
            // also conflicts — the error message will contain "CONFLICT".
            // Loop back to handle it.
            const errMsg = commitResult.error || '';
            if (errMsg.includes('CONFLICT') || errMsg.includes('conflict')) {
              debug('Rebase --continue hit another conflict, looping', { error: errMsg.slice(0, 120) });
              continue;
            }
            console.log(chalk.red(`✗ Failed to complete rebase: ${commitResult.error}`));
            await cleanupGitState(git);
            endTimer('Resolve pull conflicts');
            return { success: false, error: commitResult.error };
          }
        }
        
        if (resolvedRounds > 0) {
          console.log(chalk.green(`✓ Pull conflicts resolved (${resolvedRounds} rebase conflict round${resolvedRounds > 1 ? 's' : ''})`));
        } else {
          console.log(chalk.yellow('  No conflicts found to resolve.'));
          await cleanupGitState(git);
          endTimer('Resolve pull conflicts');
          return { success: false, error: 'Manual conflict resolution required' };
        }
        endTimer('Resolve pull conflicts');
      } else {
        return { success: false, error: pullResult.error };
      }
    }
    
    if (pullResult.stashConflicts && pullResult.stashConflicts.length > 0) {
      spinner.warn('Pulled with stash conflicts');
      console.log(chalk.cyan(`  Stash conflicts in: ${pullResult.stashConflicts.join(', ')}`));
      console.log(chalk.cyan('  Attempting to resolve stash conflicts automatically...'));
      
      startTimer('Resolve stash conflicts');
      const resolution = await resolveConflicts(
        git,
        pullResult.stashConflicts,
        'stashed changes'
      );
      
      if (!resolution.success) {
        console.log(chalk.red('\n✗ Could not resolve stash conflicts automatically'));
        console.log(chalk.red('  Remaining conflicts:'));
        for (const file of resolution.remainingConflicts) {
          console.log(chalk.red(`    - ${file}`));
        }
        console.log(chalk.yellow('\n  Stash conflicts remain - proceeding anyway'));
        // Don't bail out for stash conflicts - they're less critical
      } else {
        console.log(chalk.green('✓ Stash conflicts resolved'));
      }
      endTimer('Resolve stash conflicts');
    } else {
      spinner.succeed('Pulled latest changes');
    }
  }
  
  if (conflictStatus.aheadBy > 0) {
    console.log(chalk.cyan(`  Branch is ${conflictStatus.aheadBy} commits ahead of remote (will push after fixes)`));
  }
  
  return { success: true };
}
