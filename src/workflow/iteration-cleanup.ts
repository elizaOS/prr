/**
 * Iteration cleanup workflow functions
 * Handles post-verification tasks: tracking, summaries, incremental commits
 */

import chalk from 'chalk';
import ora from 'ora';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { Runner } from '../runners/types.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, startTimer, endTimer, formatDuration } from '../logger.js';
import { formatNumber } from '../ui/reporter.js';
import { commitIteration, pushWithRetry } from '../git/git-commit-index.js';

/**
 * Handle post-verification iteration cleanup
 * Tracks model performance, records attempts, shows summary, commits incrementally
 */
export async function handleIterationCleanup(
  verifiedCount: number,
  failedCount: number,
  totalIssues: number,
  changedIssues: UnresolvedIssue[],
  unchangedIssues: UnresolvedIssue[],
  runner: Runner,
  currentModel: string | null | undefined,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  verifiedThisSession: Set<string>,
  alreadyCommitted: Set<string>,
  lessonsBeforeFix: number,
  fixIteration: number,
  git: SimpleGit,
  prBranch: string,
  githubToken: string | null | undefined,
  options: CLIOptions,
  calculateExpectedBotResponseTime: (pushTime: Date) => Date | null
): Promise<{
  progressMade: number;
  expectedBotResponseTime?: Date | null;
}> {
  const spinner = ora();
  
  // Use session-new count (monotonically increasing) to get lessons added THIS iteration.
  // getTotalCount would give a negative delta when fix-attempt lessons are cleaned up.
  const newLessonsNow = LessonsAPI.Retrieve.getNewLessonsCount(lessonsContext);
  const newLessons = newLessonsNow - lessonsBeforeFix;
  const lessonsAfterVerify = LessonsAPI.Retrieve.getTotalCount(lessonsContext);
  
  // Track model performance for this iteration
  // WHY: Know which models work well for this project
  // Note: currentModel already defined at start of iteration
  let progressMade = 0;
  if (verifiedCount > 0) {
    Performance.recordModelFix(stateContext, runner.name, currentModel || 'unknown', verifiedCount);
    // Track progress for bail-out cycle detection
    progressMade = verifiedCount;
  }
  if (failedCount > 0) {
    Performance.recordModelFailure(stateContext, runner.name, currentModel || 'unknown', failedCount);
  }
  
  // Record per-issue attempts for LLM model recommendation context
  // WHY: LLM needs to know what's been tried on each issue to recommend different models
  for (const issue of changedIssues) {
    const wasFixed = verifiedThisSession.has(issue.comment.id);
    Performance.recordIssueAttempt(stateContext, 
      issue.comment.id,
      runner.name,
      currentModel || 'unknown',
      wasFixed ? 'fixed' : 'failed',
      undefined,  // lessonLearned - could extract from lessonsContext later
      undefined   // rejectionCount - could track in future
    );
  }
  for (const issue of unchangedIssues) {
    Performance.recordIssueAttempt(stateContext, 
      issue.comment.id,
      runner.name,
      currentModel || 'unknown',
      'no-changes'
    );
  }
  
  const progressPct = Math.round((verifiedCount / totalIssues) * 100);
  spinner.succeed(`Verified: ${formatNumber(verifiedCount)}/${formatNumber(totalIssues)} fixed (${progressPct}%), ${formatNumber(failedCount)} remaining`);
  
  // Show iteration summary
  console.log(chalk.gray(`\n  Iteration ${fixIteration} summary:`));
  console.log(chalk.gray(`    • Fixed: ${formatNumber(verifiedCount)} issues`));
  console.log(chalk.gray(`    • Failed: ${formatNumber(failedCount)} issues`));
  if (newLessons > 0) {
    console.log(chalk.yellow(`    • New lessons: +${newLessons} (total: ${lessonsAfterVerify})`));
  } else {
    console.log(chalk.gray(`    • Lessons: ${lessonsAfterVerify} (no new)`));
  }
  
  debug('Verification summary', { verifiedCount, failedCount, totalIssues, newLessons, totalLessons: lessonsAfterVerify });
  await State.saveState(stateContext);
  await LessonsAPI.Save.save(lessonsContext);
  debug('State and lessons saved');

  let newExpectedBotResponseTime: Date | null | undefined = undefined;

  // Commit this iteration's verified fixes (Phase 1)
  // Only commit NEW fixes - filter out already-committed ones (Trap 3)
  if (verifiedCount > 0 && options.incrementalCommits) {
    const newlyVerified = Array.from(verifiedThisSession).filter(id => !alreadyCommitted.has(id));
    
    if (newlyVerified.length > 0) {
      // Get issue details for meaningful commit messages
      // WHY: "fix(prr): address 6 review comment(s)" is garbage - describe WHAT changed
      const fixedIssueDetails = changedIssues
        .filter(issue => newlyVerified.includes(issue.comment.id))
        .map(issue => ({ filePath: issue.comment.path, comment: issue.comment.body }));
      
      const commitResult = await commitIteration(git, newlyVerified, fixIteration, fixedIssueDetails);
      if (commitResult) {
        // Mark these as committed so we don't try again
        for (const id of newlyVerified) {
          alreadyCommitted.add(id);
        }
        console.log(chalk.green(`  Committed ${newlyVerified.length} fix(es) [${commitResult.hash.slice(0, 7)}]`));
        
        // Push immediately if auto-push enabled (Phase 3)
        if (options.autoPush && !options.noPush) {
          try {
            startTimer('Push iteration fixes');
            await pushWithRetry(git, prBranch, { githubToken: githubToken || undefined });
            const pushTime = endTimer('Push iteration fixes');
            console.log(chalk.green(`  Pushed to origin/${prBranch} (${formatDuration(pushTime)})`));
            
            // Update expected bot response time for the new commit
            // WHY: After pushing, bots will review - schedule when to check for new issues
            const pushTime_now = new Date();
            newExpectedBotResponseTime = calculateExpectedBotResponseTime(pushTime_now);
            if (newExpectedBotResponseTime) {
              const msUntil = newExpectedBotResponseTime.getTime() - Date.now();
              debug('Updated expected bot response time after push', { 
                expectedIn: formatDuration(msUntil) 
              });
            }
          } catch (err) {
            const pushError = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow(`  Push failed (will retry): ${pushError}`));
            debug('Push error', { error: pushError });
          }
        }
      }
    }
  }
  
  return { 
    progressMade,
    expectedBotResponseTime: newExpectedBotResponseTime 
  };
}
