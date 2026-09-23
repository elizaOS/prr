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
import type { DismissedIssue } from '../state/types.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';
import type { PRInfo } from '../github/types.js';
import { debug, endTimer, formatNumber, printTimingSummary, printTokenSummary } from '../../../shared/logger.js';
import { buildReviewSummaryMarkdown } from '../ui/reporter.js';
import { printDebugIssueTable } from './debug-issue-table.js';
import { postThreadReplies } from './thread-replies.js';
import type { GitHubAPI } from '../github/api.js';

/** Dedupe by (filePath, line) so remaining count matches AAR (same location = one remaining). */
function dedupeDismissedByLocation(issues: DismissedIssue[]): DismissedIssue[] {
  const seen = new Set<string>();
  return issues.filter((d) => {
    const key = `${d.filePath}:${d.line ?? '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  printHandoffPrompt: (
    issues: UnresolvedIssue[],
    exhaustedIssues?: DismissedIssue[],
    exitReason?: string | null,
    exitDetails?: string | null
  ) => void,
  printAfterActionReport: (
    issues: UnresolvedIssue[],
    comments: ReviewComment[],
    exitReason?: string | null,
    exitDetails?: string | null
  ) => Promise<void>,
  printFinalSummary: (remainingCount?: number) => void,
  ringBell: (times: number) => void,
  prInfo?: PRInfo | null,
  submitReview?: (body: string, prInfo: PRInfo) => Promise<void>,
  /** When set and options.replyToThreads, post replies for dismissed issues at end of run */
  repliedThreadIds?: Set<string>,
  github?: GitHubAPI
): Promise<void> {
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
  
  // Developer handoff prompt and after action report when there's session activity.
  // Filter out dismissed issues from "remaining" — but include exhausted in handoff and AAR
  // so they are clearly "not completely resolved" until fixed, conversation, or other means.
  const trulyUnresolved = finalUnresolvedIssues.filter(
    issue =>
      !Dismissed.isCommentDismissed(stateContext, issue.comment.id) &&
      !Verification.isVerified(stateContext, issue.comment.id)
  );
  const dismissedIssues = Dismissed.getDismissedIssues(stateContext);
  // Remaining count must match AAR: exhausted + 'remaining', deduped by (filePath, line).
  const exhaustedOrRemaining = dismissedIssues.filter(d => d.category === 'exhausted' || d.category === 'remaining');
  const exhaustedDeduped = dedupeDismissedByLocation(exhaustedOrRemaining);
  const remainingCount = trulyUnresolved.length + exhaustedDeduped.length;
  const fixedThisSessionCount = stateContext.verifiedThisSession?.size ?? 0;
  if (remainingCount > 0) {
    printHandoffPrompt(trulyUnresolved, exhaustedDeduped, exitReason, exitDetails);
  }
  // AAR when there are remaining issues (unresolved + exhausted/remaining) or fixes this session — gives a record of what was done (audit).
  if (remainingCount > 0 || fixedThisSessionCount > 0) {
    await printAfterActionReport(trulyUnresolved, finalComments, exitReason, exitDetails);
  }

  // Final results summary - remaining = unresolved + legacy exhausted/remaining (same formula as AAR)
  printFinalSummary(remainingCount);
  if (options.verbose) {
    printDebugIssueTable('final state', finalComments, stateContext, trulyUnresolved);
  }

  // Submit a formal Pull Request Review so PRR shows in the PR's Reviews section (GitHub reviewer UX).
  if (!options.dryRun && prInfo && submitReview) {
    try {
      const body = buildReviewSummaryMarkdown(stateContext, exitReason, exitDetails, remainingCount);
      await submitReview(body, prInfo);
    } catch (err) {
      // Non-fatal: review submission is a nice-to-have; don't fail the run
      // Detailed GitHub 5xx debug: `submitPullRequestReview` logs via `logGitHubApiFailure` before throw.
      console.log(chalk.gray(`\nCould not submit PR review: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Reply on review threads: dismissed outcomes + verified fixes that did not get a push-phase reply.
  // WHY verified at end: commit-and-push only posts "Fixed in …" when a push actually happened (!pushNothingToPush).
  // Runs that verify fixes but skip push (--no-push), or "nothing to push", would otherwise leave threads silent.
  // repliedThreadIds dedupes with any replies already posted after push.
  if (!options.dryRun && options.replyToThreads && prInfo && repliedThreadIds != null && github) {
    try {
      let commitSha: string;
      try {
        commitSha = await git.revparse(['HEAD']);
      } catch {
        commitSha = prInfo.headSha;
      }
      const verifiedForReply = new Set<string>();
      if (stateContext.verifiedThisSession) {
        for (const id of stateContext.verifiedThisSession) {
          if (Verification.isVerified(stateContext, id)) verifiedForReply.add(id);
        }
      }
      const replyStats = await postThreadReplies({
        comments: finalComments,
        verifiedCommentIds: verifiedForReply,
        dismissedIssues,
        commitSha,
        repliedThreadIds,
        github,
        prInfo,
        replyToThreads: true,
        resolveThreads: options.resolveThreads,
      });
      // User-visible nudge when most replies failed (details already in thread-replies summary line; output.log audit).
      if (replyStats && replyStats.attempted > 0 && replyStats.replied < replyStats.attempted * 0.1) {
        const failed = replyStats.attempted - replyStats.replied;
        const v422 = replyStats.failed422;
        const other = replyStats.failedOther;
        const hint422 =
          v422 > 0
            ? `${formatNumber(v422)} were HTTP 422 (stale thread / old diff anchor — see CodeRabbit vs HEAD warning). `
            : '';
        const hintOther = other > 0 ? `${formatNumber(other)} failed for other reasons. ` : '';
        console.log(
          chalk.yellow(
            `Thread replies: ${formatNumber(failed)} of ${formatNumber(replyStats.attempted)} attempt(s) did not post. ${hint422}${hintOther}` +
              `Check token scopes, or re-run after review bots target the current HEAD (docs/THREAD-REPLIES.md).`,
          ),
        );
      }
    } catch (err) {
      debug('Thread replies for dismissed (non-fatal)', { error: String(err) });
    }
  }

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
  stateContext: StateContext | null,
  cleanupWorkdir: (workdir: string) => Promise<void>,
  printModelPerformance: () => void,
  printHandoffPrompt: (
    issues: UnresolvedIssue[],
    exhaustedIssues?: DismissedIssue[],
    exitReason?: string | null,
    exitDetails?: string | null
  ) => void,
  printAfterActionReport: (
    issues: UnresolvedIssue[],
    comments: ReviewComment[],
    exitReason?: string | null,
    exitDetails?: string | null
  ) => Promise<void>,
  printFinalSummary: (remainingCount?: number) => void,
  ringBell: (times: number) => void,
  /** Passed to handoff/AAR when setup exits early (e.g. merge_conflicts). */
  exitReasonForReporting?: string | null,
  exitDetailsForReporting?: string | null
): Promise<void> {
  endTimer('Total');
  printTimingSummary();
  printTokenSummary();
  printModelPerformance();
  
  // Developer handoff prompt and after action report on error — same dismissed/verified filter and session-activity gate; include exhausted
  const trulyUnresolved = stateContext
    ? finalUnresolvedIssues.filter(
        issue =>
          !Dismissed.isCommentDismissed(stateContext, issue.comment.id) &&
          !Verification.isVerified(stateContext, issue.comment.id)
      )
    : finalUnresolvedIssues;
  const dismissedIssuesErr = stateContext ? Dismissed.getDismissedIssues(stateContext) : [];
  const exhaustedOrRemainingErr = dismissedIssuesErr.filter(d => d.category === 'exhausted' || d.category === 'remaining');
  const exhaustedDedupedErr = dedupeDismissedByLocation(exhaustedOrRemainingErr);
  const remainingCountErr = trulyUnresolved.length + exhaustedDedupedErr.length;
  const fixedThisSessionCount = stateContext?.verifiedThisSession?.size ?? 0;
  const er = exitReasonForReporting ?? null;
  const ed = exitDetailsForReporting ?? null;
  if (remainingCountErr > 0) {
    printHandoffPrompt(trulyUnresolved, exhaustedDedupedErr, er, ed);
  }
  if (remainingCountErr > 0 || fixedThisSessionCount > 0) {
    await printAfterActionReport(trulyUnresolved, finalComments, er, ed);
  }

  printFinalSummary(remainingCountErr);  // same formula as AAR: unresolved + exhausted/remaining deduped
  if (options.verbose && stateContext) {
    printDebugIssueTable('final state (error)', finalComments, stateContext, trulyUnresolved);
  }
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
