/**
 * Iteration cleanup workflow functions
 * Handles post-verification tasks: tracking, summaries, incremental commits
 */

import type { UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { Runner } from '../runners/types.js';
import type { CLIOptions } from '../cli.js';

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
  stateManager: StateManager,
  lessonsManager: LessonsManager,
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
  const chalk = require('chalk');
  const { debug } = require('../logger.js');
  const { startTimer, endTimer, formatNumber, formatDuration } = require('../ui/reporter.js');
  const { commitIteration, pushWithRetry } = require('../git/commit.js');
  const ora = require('ora');
  const spinner = ora();
  
  const lessonsAfterVerify = lessonsManager.getTotalCount();
  const newLessons = lessonsAfterVerify - lessonsBeforeFix;
  
  // Track model performance for this iteration
  // WHY: Know which models work well for this project
  // Note: currentModel already defined at start of iteration
  let progressMade = 0;
  if (verifiedCount > 0) {
    stateManager.recordModelFix(runner.name, currentModel || 'unknown', verifiedCount);
    // Track progress for bail-out cycle detection
    progressMade = verifiedCount;
  }
  if (failedCount > 0) {
    stateManager.recordModelFailure(runner.name, currentModel || 'unknown', failedCount);
  }
  
  // Record per-issue attempts for LLM model recommendation context
  // WHY: LLM needs to know what's been tried on each issue to recommend different models
  for (const issue of changedIssues) {
    const wasFixed = verifiedThisSession.has(issue.comment.id);
    stateManager.recordIssueAttempt(
      issue.comment.id,
      runner.name,
      currentModel || 'unknown',
      wasFixed ? 'fixed' : 'failed',
      undefined,  // lessonLearned - could extract from lessonsManager later
      undefined   // rejectionCount - could track in future
    );
  }
  for (const issue of unchangedIssues) {
    stateManager.recordIssueAttempt(
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
  await stateManager.save();
  await lessonsManager.save();
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
            await pushWithRetry(git, prBranch, { githubToken });
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
