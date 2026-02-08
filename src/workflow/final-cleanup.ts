/**
 * Final cleanup and reporting workflow
 * 
 * Handles end-of-run tasks:
 * 1. Export final lessons
 * 2. Clean up created sync targets (CLAUDE.md)
 * 3. Clean up or preserve workdir
 * 4. Print timing and performance summaries
 * 5. Print handoff prompt and after action report
 * 6. Print final summary
 * 7. Ring completion bell
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { SimpleGit } from 'simple-git';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';

/**
 * Execute final cleanup and reporting after fix loop completes
 * 
 * CLEANUP:
 * - Export any remaining lessons to repo
 * - Remove CLAUDE.md if it was created by prr
 * - Clean up workdir (or preserve with instructions)
 * 
 * REPORTING:
 * - Print timing summary
 * - Print token usage summary
 * - Print model performance stats
 * - Print handoff prompt (if issues remain)
 * - Print after action report (if issues remain)
 * - Print final results summary
 * - Ring terminal bell for completion notification
 */
export async function executeFinalCleanup(
  git: SimpleGit,
  workdir: string,
  lessonsContext: LessonsContext,
  stateContext: StateContext,
  options: CLIOptions,
  spinner: Ora,
  finalUnresolvedIssues: UnresolvedIssue[],
  finalComments: ReviewComment[],
  exitReason: string,
  exitDetails: string,
  cleanupCreatedSyncTargets: (git: SimpleGit) => Promise<void>,
  cleanupWorkdir: (workdir: string) => Promise<void>,
  printModelPerformance: () => void,
  printHandoffPrompt: (issues: UnresolvedIssue[]) => void,
  printAfterActionReport: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>,
  printFinalSummary: () => void,
  ringBell: (times: number) => void
): Promise<void> {
  const { endTimer, printTimingSummary, printTokenSummary } = await import('../logger.js');

  // Final lessons export (catches any lessons from last iteration not yet committed)
  // WHY: Lessons are also exported before each commit, but this catches edge cases
  if (LessonsAPI.Retrieve.hasNewLessonsForRepo(lessonsContext)) {
    spinner.start('Exporting final lessons...');
    const saved = await LessonsAPI.Save.saveToRepo(lessonsContext);
    if (saved) {
      spinner.succeed('Lessons exported (run git add/commit to include)');
    } else {
      spinner.warn('Could not export lessons to repo');
    }
  }

  // Clean up CLAUDE.md if we created it (wasn't in the original PR)
  // WHY: Don't pollute the PR with files that weren't originally there
  await cleanupCreatedSyncTargets(git);

  // Cleanup workdir
  if (!options.keepWorkdir && !options.dryRun) {
    spinner.start('Cleaning up workdir...');
    await cleanupWorkdir(workdir);
    spinner.succeed('Workdir cleaned up');
  } else {
    console.log(chalk.gray(`\nWorkdir preserved: ${workdir}`));
    console.log(chalk.gray(`  To clean up: rm -rf ${workdir}`));
    console.log(chalk.gray(`  To clean all: rm -rf ~/.prr/work`));
  }

  // Print timing and performance summaries
  endTimer('Total');
  printTimingSummary();
  printTokenSummary();
  printModelPerformance();
  
  // Developer handoff prompt and after action report (if there are remaining issues)
  if (finalUnresolvedIssues.length > 0) {
    printHandoffPrompt(finalUnresolvedIssues);
    await printAfterActionReport(finalUnresolvedIssues, finalComments);
  }
  
  // Final results summary - AFTER profiling so it's visible
  printFinalSummary();
  
  // Ring terminal bell to notify user completion
  // WHY: Long-running processes need audio notification when done
  if (!options.noBell) {
    ringBell(3);
  }
  
  console.log(chalk.green('\nDone!'));
}

/**
 * Execute error handling cleanup and reporting
 * 
 * Similar to successful completion but:
 * - Prints error indicator
 * - Attempts workdir cleanup (ignoring errors)
 * - Still shows performance data and final summary
 * - Still rings bell to notify user
 */
export async function executeErrorCleanup(
  workdir: string,
  options: CLIOptions,
  spinner: Ora,
  finalUnresolvedIssues: UnresolvedIssue[],
  finalComments: ReviewComment[],
  cleanupWorkdir: (workdir: string) => Promise<void>,
  printModelPerformance: () => void,
  printHandoffPrompt: (issues: UnresolvedIssue[]) => void,
  printAfterActionReport: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>,
  printFinalSummary: () => void,
  ringBell: (times: number) => void
): Promise<void> {
  const { endTimer, printTimingSummary, printTokenSummary } = await import('../logger.js');

  endTimer('Total');
  printTimingSummary();
  printTokenSummary();
  printModelPerformance();
  
  // Developer handoff prompt and after action report on error too
  if (finalUnresolvedIssues.length > 0) {
    printHandoffPrompt(finalUnresolvedIssues);
    await printAfterActionReport(finalUnresolvedIssues, finalComments);
  }
  
  printFinalSummary();  // Show results even on error
  spinner.fail('Error');
  
  // Clean up workdir on error if not keeping it
  if (!options.keepWorkdir && workdir) {
    try {
      await cleanupWorkdir(workdir);
    } catch {
      // Ignore cleanup errors to avoid masking the original error
    }
  }
  
  // Ring terminal bell on error too - user needs to know
  if (!options.noBell) {
    ringBell(3);
  }
}
