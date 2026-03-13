/**
 * Iteration cleanup workflow functions
 * Handles post-verification tasks: tracking, summaries, incremental commits
 */

import chalk from 'chalk';
import ora from 'ora';
import { getIssuePrimaryPath, type UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateContext } from '../state/state-context.js';
import { setPhase, getState } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { Runner } from '../../../shared/runners/types.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, startTimer, endTimer, formatDuration, formatNumber, pluralize } from '../../../shared/logger.js';
import { commitIteration, commitIterationPerFile, pushWithRetry } from '../../../shared/git/git-commit-index.js';
import { hashFileContent } from '../../../shared/utils/file-hash.js';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import { postThreadReplies } from './thread-replies.js';

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
  workdir: string,
  prBranch: string,
  githubToken: string | null | undefined,
  options: CLIOptions,
  calculateExpectedBotResponseTime: (pushTime: Date) => Date | null,
  /** Cumulative fixes in this fix loop before this iteration (for "N total this fix loop" label) */
  fixedThisCycleBefore: number = 0,
  /** When set and options.replyToThreads, post replies on review threads after push */
  threadReplyContext?: { comments: ReviewComment[]; prInfo: PRInfo; github: GitHubAPI; repliedThreadIds: Set<string> }
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
  
  // Record per-issue attempts (with file hash so chronic check only counts same-version attempts)
  const allIssuesForAttempts = [...changedIssues, ...unchangedIssues];
  const hashes = await Promise.all(
    allIssuesForAttempts.map((i) => hashFileContent(workdir, getIssuePrimaryPath(i)))
  );
  const commentIdToHash = new Map(
    allIssuesForAttempts.map((i, idx) => [i.comment.id, hashes[idx]])
  );
  for (const issue of changedIssues) {
    const wasFixed = verifiedThisSession.has(issue.comment.id);
    Performance.recordIssueAttempt(
      stateContext,
      issue.comment.id,
      runner.name,
      currentModel || 'unknown',
      wasFixed ? 'fixed' : 'failed',
      undefined,
      undefined,
      commentIdToHash.get(issue.comment.id)
    );
  }
  for (const issue of unchangedIssues) {
    Performance.recordIssueAttempt(
      stateContext,
      issue.comment.id,
      runner.name,
      currentModel || 'unknown',
      'no-changes',
      undefined,
      undefined,
      commentIdToHash.get(issue.comment.id)
    );
  }

  // WHY reset here: A verified fix breaks the ALREADY_FIXED streak. Without this, the counter
  // would persist and dismiss the issue on the next run even though it was genuinely fixed.
  if (verifiedThisSession.size > 0) {
    const state = getState(stateContext);
    if (state.consecutiveAlreadyFixedAnyByCommentId) {
      for (const id of verifiedThisSession) {
        delete state.consecutiveAlreadyFixedAnyByCommentId[id];
      }
    }
  }
  
  const progressPct = Math.round((verifiedCount / totalIssues) * 100);
  spinner.succeed(`Verified: ${formatNumber(verifiedCount)}/${formatNumber(totalIssues)} fixed (${progressPct}%), ${formatNumber(failedCount)} remaining`);
  
  // Show iteration summary; when multiple iterations, show cumulative so "Fixed: 1" doesn't hide 3 total
  const totalFixedThisFixLoop = fixedThisCycleBefore + verifiedCount;
  const fixedLabel = totalFixedThisFixLoop > verifiedCount
    ? `${formatNumber(verifiedCount)} this iteration (${formatNumber(totalFixedThisFixLoop)} total this fix loop)`
    : `${formatNumber(verifiedCount)} ${pluralize(verifiedCount, 'issue')}`;
  console.log(chalk.gray(`\n  Iteration ${fixIteration} summary:`));
  console.log(chalk.gray(`    • Fixed: ${fixedLabel}`));
  console.log(chalk.gray(`    • Failed: ${formatNumber(failedCount)} ${pluralize(failedCount, 'issue')}`));
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
      const fixedIssueDetails = changedIssues
        .filter(issue => newlyVerified.includes(issue.comment.id))
        .map(issue => ({ filePath: getIssuePrimaryPath(issue), comment: issue.comment.body }));
      const issuesWithIds = changedIssues
        .filter(issue => newlyVerified.includes(issue.comment.id))
        .map(issue => ({ commentId: issue.comment.id, filePath: getIssuePrimaryPath(issue), comment: issue.comment.body }));

      let commitCount = 0;
      if (options.commitPerFile && newlyVerified.length > 1) {
        // One commit per file — cleaner history when multiple files touched
        const { committedIds, filesCommitted } = await commitIterationPerFile(git, issuesWithIds, fixIteration);
        for (const id of committedIds) alreadyCommitted.add(id);
        commitCount = committedIds.length;
        if (filesCommitted > 0) {
          console.log(chalk.green(`  Committed ${formatNumber(committedIds.length)} ${pluralize(committedIds.length, 'fix', 'fixes')} in ${formatNumber(filesCommitted)} ${pluralize(filesCommitted, 'file')}`));
        }
      } else {
        const commitResult = await commitIteration(git, newlyVerified, fixIteration, fixedIssueDetails);
        if (commitResult) {
          for (const id of newlyVerified) alreadyCommitted.add(id);
          commitCount = newlyVerified.length;
          console.log(chalk.green(`  Committed ${formatNumber(newlyVerified.length)} ${pluralize(newlyVerified.length, 'fix', 'fixes')} [${commitResult.hash.slice(0, 7)}]`));
        }
      }

      if (commitCount > 0 && options.autoPush && !options.noPush) {
        try {
          startTimer('Push iteration fixes');
          await pushWithRetry(git, prBranch, { githubToken: githubToken || undefined });
          const pushTime = endTimer('Push iteration fixes');
          console.log(chalk.green(`  Pushed to origin/${prBranch} (${formatDuration(pushTime)})`));

          if (options.replyToThreads && threadReplyContext && newlyVerified.length > 0) {
            try {
              const commitSha = await git.revparse(['HEAD']);
              await postThreadReplies({
                comments: threadReplyContext.comments,
                verifiedCommentIds: verifiedThisSession,
                dismissedIssues: [],
                commitSha,
                repliedThreadIds: threadReplyContext.repliedThreadIds,
                github: threadReplyContext.github,
                prInfo: threadReplyContext.prInfo,
                replyToThreads: true,
                resolveThreads: options.resolveThreads,
              });
            } catch (replyErr) {
              debug('Thread reply failed (non-fatal)', { error: String(replyErr) });
            }
          }

          const pushTime_now = new Date();
          newExpectedBotResponseTime = calculateExpectedBotResponseTime(pushTime_now);
          if (newExpectedBotResponseTime) {
            const msUntil = newExpectedBotResponseTime.getTime() - Date.now();
            debug('Updated expected bot response time after push', { expectedIn: formatDuration(msUntil) });
          }
        } catch (err) {
          const pushError = err instanceof Error ? err.message : String(err);
          console.log(chalk.yellow(`  Push failed (will retry): ${pushError}`));
          debug('Push error', { error: pushError });
        }
      }
    } else if (await git.status().then((s) => !s.isClean()).catch(() => false)) {
      debug('Skipping incremental commit: worktree changed but no newly verified fixes this iteration');
    }
  }
  
  return { 
    progressMade,
    expectedBotResponseTime: newExpectedBotResponseTime 
  };
}
