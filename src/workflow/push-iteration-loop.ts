/**
 * Push iteration loop
 * 
 * Execute single push iteration:
 * 1. Process comments and prepare fix loop
 * 2. Run fix iterations until all fixed or max iterations
 * 3. Commit and push if changes
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { SimpleGit } from 'simple-git';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { Runner } from '../runners/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as CommentStatusAPI from '../state/state-comment-status.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import { hasChanges } from '../git/git-clone-index.js';
import { formatNumber, debugStep, startTimer, debug } from '../logger.js';
import * as ResolverProc from '../resolver-proc.js';
import * as Bailout from '../state/state-bailout.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { recheckSolvability } from './helpers/solvability.js';

/** Git and GitHub context for a push iteration */
export interface PushIterationGitContext {
  git: SimpleGit;
  github: GitHubAPI;
  owner: string;
  repo: string;
  number: number;
  workdir: string;
}

/** Mutable iteration state tracked across push iterations */
export interface PushIterationState {
  pushIteration: number;
  maxPushIterations: number;
  rapidFailureCount: number;
  lastFailureTime: number;
  consecutiveFailures: number;
  modelFailuresInCycle: number;
  progressThisCycle: number;
  expectedBotResponseTime: Date | null;
}

/** Contextual objects passed through the push iteration */
export interface PushIterationContexts {
  prInfo: PRInfo;
  stateContext: StateContext;
  lessonsContext: LessonsContext;
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: ReviewComment[];
  /** Mutation refs for cross-iteration state */
  prInfoRef: { current: PRInfo };
  finalUnresolvedIssuesRef: { current: UnresolvedIssue[] };
  finalCommentsRef: { current: ReviewComment[] };
  expectedBotResponseTimeRef: { current: Date | null };
  /**
   * Comments already fetched during setup phase (e.g., CodeRabbit polling).
   * WHY: Avoids redundant GitHub API fetch (~3s, 3 pages) when the same data
   * was already retrieved. Consumed once on first push iteration, then cleared.
   */
  prefetchedComments?: ReviewComment[];
  /**
   * Cache of last analysis result (comment count + headSha → unresolved, duplicateMap).
   * When comment count and head SHA unchanged, reuse to skip expensive findUnresolvedIssues.
   */
  lastAnalysisCacheRef?: { current: { commentCount: number; headSha: string; unresolvedIssues: UnresolvedIssue[]; comments: ReviewComment[]; duplicateMap: Map<string, string[]> } | null };
}

/** Callback functions used during push iteration */
export interface PushIterationCallbacks {
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<{
    unresolved: UnresolvedIssue[];
    recommendedModels?: string[];
    recommendedModelIndex: number;
    modelRecommendationReasoning?: string;
    duplicateMap: Map<string, string[]>;
  }>;
  resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>;
  getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>;
  printUnresolvedIssues: (issues: UnresolvedIssue[]) => void;
  getCurrentModel: () => string | undefined;
  getRunner: () => Runner;
  parseNoChangesExplanation: (output: string) => string | null;
  trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  tryRotation: (failureErrorType?: string) => boolean;
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
  /** Called when a runner fails with tool_config (e.g. unknown option) so it's skipped for rest of run */
  onDisableRunner?: (runnerName: string) => void;
  checkForNewBotReviews: (owner: string, repo: string, number: number, existingIds: Set<string>) => Promise<{ newComments: ReviewComment[]; message: string } | null>;
  calculateExpectedBotResponseTime: (lastCommitTime: Date) => Date | null;
  waitForBotReviews: (owner: string, repo: string, number: number, sha: string) => Promise<void>;
}

/** Service dependencies for push iteration */
export interface PushIterationServices {
  llm: LLMClient;
  options: CLIOptions;
  config: Config;
  spinner: Ora;
  runner: Runner;
}

/**
 * Execute single push iteration
 * 
 * WORKFLOW:
 * 1. Process comments and prepare fix loop
 * 2. Initialize fix loop state
 * 3. While not all fixed and under max iterations:
 *    - Run pre-iteration checks
 *    - Execute fix iteration
 *    - Verify fixes
 *    - Handle iteration cleanup
 *    - Post-verification handling (rotation if needed)
 * 4. Commit and push if changes exist
 * 
 * @returns Exit control flow
 */
export async function executePushIteration(
  gitCtx: PushIterationGitContext,
  iterState: PushIterationState,
  contexts: PushIterationContexts,
  callbacks: PushIterationCallbacks,
  services: PushIterationServices
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
  updatedRapidFailureCount: number;
  updatedLastFailureTime: number;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: number;
  updatedHeadSha?: string;
  /** True when this iteration created a commit (with ≥1 file).
   * WHY: Orchestrator counts consecutive iterations with no commit and exits after 3 to avoid infinite loop when fixer produces no real changes. */
  committedThisIteration?: boolean;
}> {
  // Destructure parameter objects for local use
  const { git, github, owner, repo, number, workdir } = gitCtx;
  let { rapidFailureCount, lastFailureTime, consecutiveFailures, modelFailuresInCycle, progressThisCycle } = iterState;
  const { pushIteration, maxPushIterations } = iterState;
  const { prInfo, stateContext, lessonsContext } = contexts;
  const { prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef } = contexts;
  const {
    findUnresolvedIssues, resolveConflictsWithLLM, getCodeSnippet, printUnresolvedIssues,
    getCurrentModel, getRunner, parseNoChangesExplanation, trySingleIssueFix, tryRotation,
    tryDirectLLMFix, executeBailOut, checkForNewBotReviews, calculateExpectedBotResponseTime, waitForBotReviews,
  } = callbacks;
  const { llm, options, config, spinner } = services;

  if (options.autoPush && pushIteration > 1) {
    const iterLabel = maxPushIterations === Infinity ? `${pushIteration}` : `${pushIteration}/${maxPushIterations}`;
    console.log(chalk.blue(`\n--- Push iteration ${iterLabel} ---\n`));
  }

  // Process comments and prepare fix loop.
  // Pass prefetched comments from setup phase to avoid redundant API call on first iteration.
  const prefetched = contexts.prefetchedComments;
  // Clear after first use — subsequent push iterations must fetch fresh data
  contexts.prefetchedComments = undefined;
  
  const loopResult = await ResolverProc.processCommentsAndPrepareFixLoop(
    git, github, owner, repo, number, prInfo, stateContext, lessonsContext, llm, options, config, workdir, spinner,
    findUnresolvedIssues, resolveConflictsWithLLM, getCodeSnippet, printUnresolvedIssues, prefetched
  );
  
  const { comments, unresolvedIssues, duplicateMap } = loopResult;
  
  if (loopResult.shouldBreak) {
    // Store final state for after action report (for dry-run); issue refs preserved for AAR
    if (options.dryRun) {
      finalUnresolvedIssuesRef.current = [...unresolvedIssues];
      finalCommentsRef.current = [...comments];
    }
    return {
      shouldBreak: true,
      exitReason: loopResult.exitReason,
      exitDetails: loopResult.exitDetails,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle,
      committedThisIteration: false,
    };
  }

  // Initialize fix loop
  // CLI convention: 0 = unlimited, undefined = use Infinity default
  // CLI convention: 0 = unlimited. Use || (not ??) since 0 should map to Infinity.
  // CRITICAL: ?? only triggers on null/undefined, NOT 0. Default is 0 = unlimited.
  const maxFixIterations = options.maxFixIterations || Infinity;
  const loopState = ResolverProc.initializeFixLoop(comments.map(c => c.id));
  let { fixIteration, allFixed, verifiedThisSession, alreadyCommitted, existingCommentIds } = loopState;

  // Reset stalemate counter at the start of each push iteration's fix loop.
  // WHY: noProgressCycles persists in state across push iterations. Without this,
  // a bail-out in push iteration N leaves the counter at threshold, so push
  // iteration N+1 bails immediately on its first cycle (even if that cycle was
  // timeout-only and should not count as stalemate).
  Bailout.resetNoProgressCycles(stateContext);
  
  // Expose verifiedThisSession on stateContext so reporters can use the actual
  // session verification count instead of unreliable delta counting.
  stateContext.verifiedThisSession = verifiedThisSession;

  let exitReason = '';
  let exitDetails = '';
  let committedThisIteration = false;

  while (fixIteration < maxFixIterations && !allFixed) {
    fixIteration++;
    
    // Pre-iteration checks
    const preChecks = await ResolverProc.executePreIterationChecks(
      fixIteration, git, github, owner, repo, number, prInfo, comments, unresolvedIssues, existingCommentIds, verifiedThisSession, stateContext, getRunner(), options,
      checkForNewBotReviews, getCodeSnippet, getCurrentModel
    );
    
    if (preChecks.shouldBreak) {
      exitReason = preChecks.exitReason || '';
      exitDetails = preChecks.exitDetails || '';
      break;
    }
    if (preChecks.updatedHeadSha) {
      prInfoRef.current.headSha = preChecks.updatedHeadSha;
    }

    // 3.1(a): Re-fetch file content for issues where verifier said still exists
    const verifierRefreshCount = await ResolverProc.refreshSnippetsForVerifierContradiction(unresolvedIssues, getCodeSnippet);
    if (verifierRefreshCount > 0) {
      debug('Refreshed snippets for verifier-contradiction retry', { count: verifierRefreshCount });
    }

    // Execute fix iteration
    // WHY getRunner(): After tryRotation() updates this.runner via syncRotationContext,
    // a destructured `runner` variable would still hold the OLD runner reference.
    // getRunner() always returns the current runner from the PRResolver instance.
    const iterResult = await ResolverProc.executeFixIteration(
      unresolvedIssues, comments, git, workdir, getRunner(), stateContext, lessonsContext, llm, options, config.openaiApiKey, prInfo, verifiedThisSession,
      rapidFailureCount, lastFailureTime, consecutiveFailures, modelFailuresInCycle, progressThisCycle,
      getCurrentModel, parseNoChangesExplanation, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut,
      callbacks.onDisableRunner
    );
    
    // Update state
    rapidFailureCount = iterResult.updatedRapidFailureCount;
    lastFailureTime = iterResult.updatedLastFailureTime;
    consecutiveFailures = iterResult.updatedConsecutiveFailures;
    modelFailuresInCycle = iterResult.updatedModelFailuresInCycle;
    progressThisCycle = iterResult.updatedProgressThisCycle;
    unresolvedIssues.splice(0, unresolvedIssues.length, ...iterResult.updatedUnresolvedIssues);
    const lessonsBeforeFix = iterResult.lessonsBeforeFix;
    
    if (iterResult.shouldExit) return { shouldBreak: true, exitReason: iterResult.exitReason || 'bail_out', exitDetails: iterResult.exitDetails || 'Fix iteration requested early exit', updatedRapidFailureCount: rapidFailureCount, updatedLastFailureTime: lastFailureTime, updatedConsecutiveFailures: consecutiveFailures, updatedModelFailuresInCycle: modelFailuresInCycle, updatedProgressThisCycle: progressThisCycle, committedThisIteration: false };
    if (iterResult.shouldBreak) {
      exitReason = iterResult.exitReason || '';
      exitDetails = iterResult.exitDetails || '';
      break;
    }
    if (iterResult.allFixed) {
      allFixed = true;
      break;
    }
    if (iterResult.shouldContinue) {
      await State.saveState(stateContext);
      await LessonsAPI.Save.save(lessonsContext);
      continue;
    }

    // Verify fixes
    const { verifiedCount, failedCount, changedIssues, unchangedIssues, changedFiles } = await ResolverProc.verifyFixes(git, unresolvedIssues, stateContext, lessonsContext, llm, verifiedThisSession, options.noBatch, duplicateMap, workdir);
    const totalIssues = unresolvedIssues.length;
    const currentModel = getCurrentModel();

    // Invalidate "open" comment statuses for files that were modified by the fixer.
    // HISTORY: Comment statuses persist the LLM's "issue still exists" verdict
    // keyed by file content hash. After the fixer modifies a file, the hash is
    // stale — the issue may now be resolved. By invalidating here, the next
    // iteration's findUnresolvedIssues will re-analyze only these comments
    // instead of the entire set.
    if (changedFiles.length > 0) {
      const invalidated = CommentStatusAPI.invalidateForFiles(stateContext, changedFiles);
      if (invalidated > 0) {
        debug(`Invalidated ${invalidated} comment status(es) for ${changedFiles.length} changed file(s)`);
      }
      // Refresh in-memory code snippets for remaining issues in the modified files.
      // WHY: After the fixer edits a file, the cached snippet for other issues in
      // that file is stale — line numbers may have shifted and context changed.
      // The next fix iteration would send outdated code, causing duplicate patches
      // or wrong-location errors.
      const snippetRefreshCount = await ResolverProc.refreshSnippetsForChangedFiles(unresolvedIssues, changedFiles, getCodeSnippet);
      if (snippetRefreshCount > 0) {
        debug(`Refreshed ${snippetRefreshCount} snippet(s) for changed file(s)`, { changedFiles });
      }
    }

    // Report verification failures to runner for escalation tracking.
    // HISTORY: The runner only tracked search/replace matching failures.
    // Files with structural corruption got patched (S/R matched) but failed
    // verification, so they never escalated to full-file-rewrite. Now both
    // signal types count, so persistent failures trigger escalation.
    if (failedCount > 0 && changedIssues.length > 0) {
      const failedFiles = new Set<string>();
      for (const issue of changedIssues) {
        if (!Verification.isVerified(stateContext, issue.comment.id)) {
          failedFiles.add(issue.comment.path);
        }
      }
      if (failedFiles.size > 0) {
        const runner = getRunner();
        runner.reportVerificationFailures?.(Array.from(failedFiles));
      }
    }
    
    // Handle iteration cleanup
    const cleanupResult = await ResolverProc.handleIterationCleanup(verifiedCount, failedCount, totalIssues, changedIssues, unchangedIssues, getRunner(), currentModel,
      stateContext, lessonsContext, verifiedThisSession, alreadyCommitted, lessonsBeforeFix, fixIteration, git, prInfo.branch, config.githubToken, options, calculateExpectedBotResponseTime, progressThisCycle);
    
    progressThisCycle += cleanupResult.progressMade;
    if (cleanupResult.expectedBotResponseTime !== undefined) expectedBotResponseTimeRef.current = cleanupResult.expectedBotResponseTime;

    // Check if all fixed
    allFixed = failedCount === 0;
    if (allFixed && !exitReason.startsWith('all')) {
      exitReason = 'all_fixed';
      exitDetails = 'All issues fixed and verified in fix loop';
    }

    if (!allFixed) {
      // Post-verification handling
      const postVerif = await ResolverProc.handlePostVerification(verifiedCount, allFixed, unresolvedIssues, comments, verifiedThisSession, git, consecutiveFailures, modelFailuresInCycle, progressThisCycle,
        stateContext, lessonsContext, options, getRunner().name, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut);
      
      consecutiveFailures = postVerif.updatedConsecutiveFailures;
      modelFailuresInCycle = postVerif.updatedModelFailuresInCycle;
      progressThisCycle = postVerif.updatedProgressThisCycle;
      unresolvedIssues.splice(0, unresolvedIssues.length, ...postVerif.updatedUnresolvedIssues);
      
      // Phase 2: Refresh snippets for issues whose files were touched by fixer
      const getCodeSnippetFn = (path: string, line: number | null, body?: string) =>
        ResolverProc.getCodeSnippet(gitCtx.workdir, path, line, body);
      const refreshResult = await recheckSolvability(
        unresolvedIssues, 
        changedFiles, 
        gitCtx.workdir, 
        stateContext, 
        getCodeSnippetFn
      );
      if (refreshResult.dismissed > 0) {
        console.log(chalk.yellow(`  ${refreshResult.dismissed} issue(s) became stale (files deleted by fixer)`));
      }
      if (refreshResult.refreshed > 0) {
        console.log(chalk.gray(`  ${refreshResult.refreshed} issue(s) refreshed (snippets updated)`));
      }
      unresolvedIssues.splice(0, unresolvedIssues.length, ...refreshResult.updated);
      
      if (postVerif.shouldBreak) {
        exitReason = 'bail_out';
        exitDetails = `Stalemate detected: fix loop exhausted all strategies with ${unresolvedIssues.length} issue(s) remaining`;
        break;
      }
    }
  }

  if (!allFixed && maxFixIterations !== Infinity) {
    console.log(chalk.yellow(`\nMax fix iterations (${formatNumber(maxFixIterations)}) reached. ${formatNumber(unresolvedIssues.length)} issues remain.`));
    exitReason = 'max_iterations';
    exitDetails = `Hit max fix iterations (${maxFixIterations}) with ${unresolvedIssues.length} issue(s) remaining`;
    finalUnresolvedIssuesRef.current = [...unresolvedIssues]; // issue refs preserved for AAR (verifierContradiction etc.)
    finalCommentsRef.current = [...comments];
  }

  // Commit changes if we have any
  debugStep('COMMIT PHASE');
  if (await hasChanges(git)) {
    // After bail-out, skip the 300s bot review wait — we've exhausted all
    // strategies and waiting for new comments just delays exit with no benefit.
    const isBailOut = exitReason === 'bail_out';
    const commitResult = await ResolverProc.handleCommitAndPush(git, prInfo, owner, repo, number, comments, stateContext, lessonsContext, options, config.githubToken, github, workdir, spinner, services.llm, pushIteration, maxPushIterations,
      resolveConflictsWithLLM, waitForBotReviews, allFixed, /* skipBotWait */ isBailOut);
    if (commitResult.shouldBreak) {
      // Ensure AAR has remaining issues when we exit (e.g. bail-out with no committable changes)
      if (unresolvedIssues.length > 0) {
        finalUnresolvedIssuesRef.current = [...unresolvedIssues];
        finalCommentsRef.current = [...comments];
      }
      return {
        shouldBreak: true,
        exitReason: commitResult.exitReason,
        exitDetails: commitResult.exitDetails,
        updatedRapidFailureCount: rapidFailureCount,
        updatedLastFailureTime: lastFailureTime,
        updatedConsecutiveFailures: consecutiveFailures,
        updatedModelFailuresInCycle: modelFailuresInCycle,
        updatedProgressThisCycle: progressThisCycle,
        committedThisIteration: false,
      };
    }
    // Committed and pushed this iteration
    committedThisIteration = true;
    // Invalidate analysis cache so next iteration re-analyzes with new head
    if (contexts.lastAnalysisCacheRef) contexts.lastAnalysisCacheRef.current = null;
  } else {
    console.log(chalk.yellow('\nNo changes to commit'));
    // Preserve issue objects (including verifierContradiction) so AAR shows "Verifier said" for each
    finalUnresolvedIssuesRef.current = [...unresolvedIssues];
    finalCommentsRef.current = [...comments];

    // If intermediate pushes happened during this iteration's fix loop, wait for
    // bot reviews before deciding to exit. Bots reviewing the pushed fixes may
    // find NEW issues that warrant another push iteration.
    // WHY: Without this, the run exits immediately after bail-out even though
    // fixes were pushed mid-loop and bots haven't had time to review them.
    if (alreadyCommitted.size > 0 && options.autoPush && (maxPushIterations === 0 || pushIteration < maxPushIterations)) {
      const headSha = await git.revparse(['HEAD']);
      await waitForBotReviews(owner, repo, number, headSha);
      // Don't break — let the outer loop re-fetch comments and process any new
      // bot feedback. If no new issues, the next iteration exits immediately
      // (alreadyCommitted will be empty since no fixes were made).
      return {
        shouldBreak: false,
        exitReason: exitReason || 'no_changes',
        exitDetails: exitDetails || 'No new changes (waiting for bot review cycle)',
        updatedRapidFailureCount: rapidFailureCount,
        updatedLastFailureTime: lastFailureTime,
        updatedConsecutiveFailures: consecutiveFailures,
        updatedModelFailuresInCycle: modelFailuresInCycle,
        updatedProgressThisCycle: progressThisCycle,
        committedThisIteration: false,
      };
    }

    // No intermediate pushes (or not in auto-push mode) — truly done.
    const preserveExitReason = exitReason === 'bail_out';
    const noChangesDetails =
      unresolvedIssues.length > 0
        ? `No changes to commit (fixer made no modifications); ${unresolvedIssues.length} issue${unresolvedIssues.length === 1 ? '' : 's'} still need attention`
        : 'No changes to commit (fixer made no modifications)';
    return {
      shouldBreak: true,
      exitReason: preserveExitReason ? exitReason : 'no_changes',
      exitDetails: preserveExitReason ? exitDetails : noChangesDetails,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle,
      committedThisIteration: false,
    };
  }

  // After commit+push, if we broke out due to bail-out, DON'T immediately exit.
  // The pushed fixes may trigger bot reviews with NEW issues worth processing.
  // The outer loop will re-enter, re-fetch comments, and process new bot feedback.
  // Convergence: if no new issues, the next iteration's fix loop exits immediately
  // → no changes → alreadyCommitted empty → shouldBreak: true.
  const bailedOut = exitReason === 'bail_out';
  if (bailedOut) {
    // Same issue refs (with verifierContradiction when set) for AAR and handoff
    finalUnresolvedIssuesRef.current = [...unresolvedIssues];
    finalCommentsRef.current = [...comments];
  }

  return {
    shouldBreak: false,
    exitReason,
    exitDetails,
    updatedRapidFailureCount: rapidFailureCount,
    updatedLastFailureTime: lastFailureTime,
    updatedConsecutiveFailures: consecutiveFailures,
    updatedModelFailuresInCycle: modelFailuresInCycle,
    updatedProgressThisCycle: progressThisCycle,
    committedThisIteration,
  };
}
