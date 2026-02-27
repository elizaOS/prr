/**
 * Run orchestrator — the outermost loop of the PR resolution workflow.
 *
 * WHY a separate orchestrator: The fix loop (push-iteration-loop.ts) handles
 * a single push cycle: analyze → fix → verify → commit → push → wait for bots.
 * But after bots respond, we may need to re-enter the loop with fresh comments.
 * The orchestrator manages this outer loop, including:
 *
 *   1. Setup (clone, load state, fetch comments)
 *   2. Push iteration loop (delegates to push-iteration-loop.ts)
 *   3. Outer bail-out detection (consecutive stalemates → hard exit)
 *   4. Post-processing (dismissal comments, cleanup)
 *
 * WHY outer bail-out tracking: After a stalemate, the inner loop commits
 * partial progress and returns shouldBreak:false so we can process new bot
 * comments. In practice, bots add MORE comments after each push, making each
 * re-entry hit the same stalemate on a larger set. We track consecutive
 * bail-outs and hard-exit after 2 with no progress. One re-entry is useful
 * (catches bot-resolved issues); beyond that is waste.
 *
 * WHY refs (prInfoRef, finalUnresolvedIssuesRef): The push iteration loop
 * runs callbacks that update PR info and unresolved issues. Refs let the
 * orchestrator see those updates without the loop returning them explicitly.
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { SimpleGit } from 'simple-git';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import type { ReviewComment, PRInfo, BotResponseTiming } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { Runner } from '../runners/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import { logTokenUsage } from '../state/state-context.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import type { LLMClient } from '../llm/client.js';
import type { RotationContext } from '../models/rotation.js';
import { cleanupWorkdir } from '../git/workdir.js';
import * as ResolverProc from '../resolver-proc.js';
import { addDismissalComments } from './dismissal-comments.js';
import * as Dismissed from '../state/state-dismissed.js';
import { debug } from '../logger.js';

export interface RunState {
  prInfo: PRInfo;
  botTimings: BotResponseTiming[];
  expectedBotResponseTime: Date | null;
  workdir: string;
  stateContext: StateContext;
  lessonsContext: LessonsContext;
  lockConfig: LockConfig;
  runner: Runner;
  runners: Runner[];
  currentRunnerIndex: number;
  modelIndices: Map<string, number>;
  rapidFailureCount: number;
  lastFailureTime: number;
  consecutiveFailures: number;
  modelFailuresInCycle: number;
  progressThisCycle: number;
  exitReason: string;
  exitDetails: string;
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: ReviewComment[];
}

export interface RunCallbacks {
  setupRunner: () => Promise<Runner>;
  ensureStateFileIgnored: (workdir: string) => Promise<void>;
  resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>;
  syncResolverState?: (state: RunState) => void;
  getRotationContext: () => RotationContext;
  getCurrentModel: () => string | undefined;
  getRunner: () => Runner;
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<{
    unresolved: UnresolvedIssue[];
    recommendedModels?: string[];
    recommendedModelIndex: number;
    modelRecommendationReasoning?: string;
    duplicateMap: Map<string, string[]>;
  }>;
  getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>;
  printUnresolvedIssues: (issues: UnresolvedIssue[]) => void;
  parseNoChangesExplanation: (output: string) => string | null;
  trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  tryRotation: (failureErrorType?: string) => boolean;
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
  onDisableRunner?: (runnerName: string) => void;
  checkForNewBotReviews: (owner: string, repo: string, prNumber: number, existingIds: Set<string>) => Promise<{ newComments: ReviewComment[]; message: string } | null>;
  calculateExpectedBotResponseTime: (lastCommitTime: Date) => Date | null;
  waitForBotReviews: (owner: string, repo: string, prNumber: number, headSha: string) => Promise<void>;
  cleanupCreatedSyncTargets: (git: SimpleGit) => Promise<void>;
  printModelPerformance: () => void;
  printHandoffPrompt: (issues: UnresolvedIssue[]) => void;
  printAfterActionReport: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
  printFinalSummary: (remainingCount?: number) => void;
  ringBell: (times: number) => void;
  runCleanupMode: (prUrl: string, owner: string, repo: string, prNumber: number) => Promise<void>;
}

export async function executeRun(
  prUrl: string,
  config: Config,
  options: CLIOptions,
  github: GitHubAPI,
  llm: LLMClient,
  spinner: Ora,
  callbacks: RunCallbacks,
  state: RunState
): Promise<RunState> {
  // Refs hoisted ABOVE try/catch so the catch block can read the latest remaining-issues snapshot.
  //
  // WHY hoisted: These refs are also created inside the push-loop setup (line ~190) and
  // updated on every exit path inside the loop. But if executeFixIteration throws (e.g.
  // unhandled network error mid-iteration), execution jumps straight to catch — skipping
  // the ref assignments. Without hoisting the catch always saw the initial [] and produced
  // "Remaining: 0" and an empty AAR even when 20 issues were still open.
  //
  // The try block re-assigns .current on line ~190 to align them with the loop refs, so
  // there's a single logical ref object shared between the loop and the catch.
  const finalUnresolvedIssuesRef = { current: state.finalUnresolvedIssues };
  const finalCommentsRef = { current: state.finalComments };
  try {
    debug('Run start', { autoPush: options.autoPush, maxPushIterations: options.maxPushIterations, maxFixIterations: options.maxFixIterations, maxStaleCycles: options.maxStaleCycles, noWaitBot: options.noWaitBot });
    const initResult = await ResolverProc.initializeRun(prUrl, github, options, spinner, callbacks.runCleanupMode, callbacks.calculateExpectedBotResponseTime);
    if (!initResult) {
      state.exitReason = 'init_failed';
      state.exitDetails = `PR initialization returned no result for ${prUrl}`;
      return state;
    }
    const { owner, repo, number, prInfo, botTimings, expectedBotResponseTime } = initResult;
    state.prInfo = prInfo;
    state.botTimings = botTimings;
    state.expectedBotResponseTime = expectedBotResponseTime;
    const setupResult = await ResolverProc.executeSetupPhase(config, options, owner, repo, number, state.prInfo, github, spinner, callbacks.setupRunner, callbacks.ensureStateFileIgnored, callbacks.resolveConflictsWithLLM, callbacks.getRotationContext, callbacks.getCurrentModel);
    
    // Always copy setup results to state, even on early exit
    // WHY: Error handlers and cleanup need these values (especially stateContext)
    // CRITICAL: Also update via callback so the resolver instance is updated BEFORE callbacks are invoked
    state.workdir = setupResult.workdir;
    state.stateContext = setupResult.stateContext;
    state.lessonsContext = setupResult.lessonsContext;
    state.lockConfig = setupResult.lockConfig;
    state.runner = setupResult.runner;
    state.runners = setupResult.runners;
    state.currentRunnerIndex = setupResult.currentRunnerIndex;
    state.modelIndices = setupResult.modelIndices;
    
    // If codex is active, ensure AGENTS.md is a sync target
    // WHY: Codex reads AGENTS.md for project instructions, same way Claude reads CLAUDE.md
    if (state.runner?.name === 'codex' && state.lessonsContext && !state.lessonsContext.syncTargets.includes('agents-md')) {
      state.lessonsContext.syncTargets.push('agents-md');
    }
    
    // Immediately sync resolver instance via callback before continuing
    // WHY: Callbacks need to access updated this.stateContext during main loop
    if (callbacks.syncResolverState) {
      callbacks.syncResolverState(state);
    }
    
    if (setupResult.shouldExit) {
      debug('Setup requested early exit', { exitReason: setupResult.exitReason, exitDetails: setupResult.exitDetails });
      if (setupResult.exitReason) state.exitReason = setupResult.exitReason;
      if (setupResult.exitDetails) state.exitDetails = setupResult.exitDetails;
      return state;
    }
    debug('Setup complete, entering push iteration loop', { workdir: setupResult.workdir, hasPrefetchedComments: !!setupResult.prefetchedComments?.length });
    const git = setupResult.git;
    let pushIteration = 0;
    // CLI convention: 0 = unlimited. Use explicit check so 0 becomes Infinity (?? preserves 0 and would skip the loop).
    const rawMaxPush = options.autoPush ? (options.maxPushIterations ?? Infinity) : 1;
    const maxPushIterations = rawMaxPush === 0 ? Infinity : rawMaxPush;
    debug('Push iteration loop config', { autoPush: options.autoPush, rawMaxPushIterations: options.maxPushIterations, maxPushIterations, maxBailoutsBeforeExit: options.maxStaleCycles ?? 2 });

    // Track consecutive bail-outs at the outer loop level.
    //
    // HISTORY: After a stalemate bail-out, push-iteration-loop returns
    // shouldBreak: false so the outer loop re-enters with fresh bot comments.
    // The reasoning was that new comments might be worth processing. In
    // practice, bots add MORE comments after each push (not fewer), so each
    // re-entry hits the same stalemate on an even larger issue set. Observed:
    // 5 bail-outs × 300s wait = 25 min wasted in a single run. Now we track
    // consecutive bail-outs and hard-exit after MAX_CONSECUTIVE_BAILOUTS.
    // One re-entry is still useful (catches fixes the bots resolved), but
    // beyond that it's diminishing returns.
    // Use CLI --max-stale-cycles so "bail-out after 1" actually exits after 1 (no re-entry).
    const maxBailoutsBeforeExit = options.maxStaleCycles ?? 2;
    // WHY 2: Exit sooner when fixer isn't producing committable changes (was 3; medium fix).
    const MAX_CONSECUTIVE_NO_COMMIT = 2;
    debug('Orchestrator loop limits', { maxBailoutsBeforeExit, MAX_CONSECUTIVE_NO_COMMIT });
    let consecutiveBailouts = 0;
    let consecutiveNoCommits = 0;
    let consecutiveZeroVerified = 0;
    let progressBeforePushIteration = 0; // snapshot to compute per-iteration delta
    let lastBailoutRemainingCount = Infinity;
    const prInfoRef = { current: state.prInfo };
    finalUnresolvedIssuesRef.current = state.finalUnresolvedIssues;
    finalCommentsRef.current = state.finalComments;
    const expectedBotResponseTimeRef = { current: state.expectedBotResponseTime };
    // Pass prefetched comments from setup phase to avoid redundant fetch on first iteration.
    // The push iteration loop clears this after consuming it once.
    const lastAnalysisCacheRef = { current: null as { commentCount: number; headSha: string; unresolvedIssues: UnresolvedIssue[]; comments: ReviewComment[]; duplicateMap: Map<string, string[]> } | null };
    const pushContexts = { prInfo: state.prInfo, stateContext: state.stateContext, lessonsContext: state.lessonsContext, finalUnresolvedIssues: state.finalUnresolvedIssues, finalComments: state.finalComments, prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef, prefetchedComments: setupResult.prefetchedComments, lastAnalysisCacheRef };
    while (pushIteration < maxPushIterations) {
      pushIteration++;
      debug('Push iteration start', { pushIteration, maxPushIterations, consecutiveBailouts, consecutiveNoCommits });
      const iterResult = await ResolverProc.executePushIteration(
        { git, github, owner, repo, number, workdir: state.workdir },
        { pushIteration, maxPushIterations, rapidFailureCount: state.rapidFailureCount, lastFailureTime: state.lastFailureTime, consecutiveFailures: state.consecutiveFailures, modelFailuresInCycle: state.modelFailuresInCycle, progressThisCycle: state.progressThisCycle, expectedBotResponseTime: state.expectedBotResponseTime },
        pushContexts,
        { findUnresolvedIssues: callbacks.findUnresolvedIssues, resolveConflictsWithLLM: callbacks.resolveConflictsWithLLM, getCodeSnippet: callbacks.getCodeSnippet, printUnresolvedIssues: callbacks.printUnresolvedIssues, getCurrentModel: callbacks.getCurrentModel, getRunner: callbacks.getRunner, parseNoChangesExplanation: callbacks.parseNoChangesExplanation, trySingleIssueFix: callbacks.trySingleIssueFix, tryRotation: callbacks.tryRotation, tryDirectLLMFix: callbacks.tryDirectLLMFix, executeBailOut: callbacks.executeBailOut, onDisableRunner: callbacks.onDisableRunner, checkForNewBotReviews: callbacks.checkForNewBotReviews, calculateExpectedBotResponseTime: callbacks.calculateExpectedBotResponseTime, waitForBotReviews: callbacks.waitForBotReviews },
        { llm, options, config, spinner, runner: state.runner }
      );
      state.rapidFailureCount = iterResult.updatedRapidFailureCount;
      state.lastFailureTime = iterResult.updatedLastFailureTime;
      state.consecutiveFailures = iterResult.updatedConsecutiveFailures;
      state.modelFailuresInCycle = iterResult.updatedModelFailuresInCycle;
      state.progressThisCycle = iterResult.updatedProgressThisCycle;
      state.prInfo = prInfoRef.current;
      state.finalUnresolvedIssues = finalUnresolvedIssuesRef.current;
      state.finalComments = finalCommentsRef.current;
      state.expectedBotResponseTime = expectedBotResponseTimeRef.current;
      // Always capture exit reason from last iteration (even when shouldBreak is false)
      // WHY: When loop exhausts maxPushIterations without break, the last
      // iteration's exitReason would be lost, causing "Exit: unknown"
      if (iterResult.exitReason) state.exitReason = iterResult.exitReason;
      if (iterResult.exitDetails) state.exitDetails = iterResult.exitDetails;
      debug('Push iteration done', { pushIteration, shouldBreak: iterResult.shouldBreak, exitReason: iterResult.exitReason, committedThisIteration: iterResult.committedThisIteration });
      if (iterResult.shouldBreak) {
        break;
      }

      // Exit after 2 push iterations with zero verified fixes (token-saving; same issues keep failing).
      // Compare delta (not cumulative) since progressThisCycle accumulates across all push iterations.
      const progressDelta = iterResult.updatedProgressThisCycle - progressBeforePushIteration;
      progressBeforePushIteration = iterResult.updatedProgressThisCycle;
      if (progressDelta > 0) {
        consecutiveZeroVerified = 0;
      } else {
        consecutiveZeroVerified++;
        if (consecutiveZeroVerified >= 2) {
          console.log(chalk.yellow(`\n  ⏹ ${consecutiveZeroVerified} consecutive push iterations with no verified fixes — exiting`));
          console.log(chalk.gray(`     Re-run after manual edits or to pick up new bot comments`));
          state.exitReason = 'no_verified_progress';
          state.exitDetails = `${consecutiveZeroVerified} consecutive push iterations with zero verified fixes`;
          break;
        }
      }

      // Track consecutive iterations with no commit (fixer made no file changes).
      // Avoids unbounded run when runner keeps "fixing" but writes identical content.
      if (iterResult.committedThisIteration) {
        consecutiveNoCommits = 0;
      } else {
        consecutiveNoCommits++;
        if (consecutiveNoCommits >= MAX_CONSECUTIVE_NO_COMMIT) {
          console.log(chalk.red(`\n  🛑 ${consecutiveNoCommits} consecutive push iterations with no files committed — exiting`));
          console.log(chalk.gray(`     Fixer is not producing new changes; re-run after manual edits if needed`));
          state.exitReason = 'no_progress';
          state.exitDetails = `${consecutiveNoCommits} consecutive push iterations with no committable changes`;
          break;
        }
      }

      // Track consecutive bail-outs to prevent infinite re-entry.
      // Reset only when this cycle verified at least one fix (progressThisCycle > 0).
      // Do NOT reset when we merely committed (commit after bail-out is partial progress
      // from the same cycle). Otherwise we'd see 4+ bail-outs instead of stopping at 2.
      if (iterResult.updatedProgressThisCycle > 0) {
        consecutiveBailouts = 0;
        lastBailoutRemainingCount = Infinity;
      } else if (iterResult.exitReason === 'bail_out') {
        consecutiveBailouts++;
        const currentRemaining = state.finalUnresolvedIssues?.length ?? Infinity;
        lastBailoutRemainingCount = currentRemaining;

        if (consecutiveBailouts >= maxBailoutsBeforeExit) {
          debug('Orchestrator exiting: max consecutive bail-outs', { consecutiveBailouts, maxBailoutsBeforeExit, currentRemaining });
          console.log(chalk.red(`\n  🛑 ${consecutiveBailouts} consecutive bail-out(s) with no progress — exiting outer loop`));
          console.log(chalk.gray(`     Re-entering would hit the same stalemate on ${currentRemaining} remaining issues`));
          state.exitReason = 'bail_out';
          state.exitDetails = `${consecutiveBailouts} consecutive stalemate bail-out(s) (max: ${maxBailoutsBeforeExit})`;
          break;
        }
      } else {
        consecutiveBailouts = 0;
        lastBailoutRemainingCount = Infinity;
      }
    }
    if (pushIteration === 0) {
      state.exitReason = 'no_push_iterations';
      state.exitDetails = 'Push iteration loop did not run (maxPushIterations was 0 or misconfigured)';
      debug('Push iteration loop never ran', { maxPushIterations, rawMaxPush: options.maxPushIterations });
    }
    // Sync resolver instance with final state so callbacks (e.g. printFinalSummary)
    // see the updated exitReason. Without this, this.exitReason stays 'unknown'
    // because syncResolverState only ran once after setup, before the push loop.
    if (callbacks.syncResolverState) {
      callbacks.syncResolverState(state);
    }

    logTokenUsage(state.stateContext);

    // Add dismissal comments as post-processing step (after all fix iterations complete)
    // WHY: Comments are added after fixer modifications are done so they don't get clobbered.
    // If comments are added, commit them separately for clean separation in git history.
    try {
      const dismissedIssues = Dismissed.getDismissedIssues(state.stateContext);
      if (dismissedIssues.length > 0) {
        const { added, skipped } = await addDismissalComments(
          dismissedIssues,
          state.workdir,
          llm,
          state.stateContext.verifiedThisSession
        );
        
        if (added > 0) {
          spinner.text = `Added ${added} dismissal comment${added === 1 ? '' : 's'}, committing...`;
          
          // Stage all files (comments may span multiple files)
          await git.add('.');
          
          // Commit with descriptive message
          await git.commit('docs: add review dismissal comments\n\nExplains reasoning for dismissed issues inline in code');
          
          // Push if auto-push is enabled (even on bailout — exhausted comments are
          // informational and safe, and bots need to see them on the next review pass)
          if (options.autoPush && !options.noPush) {
            spinner.text = 'Pushing dismissal comments...';
            await git.push();
          }
          
          spinner.succeed(`Added ${added} dismissal comment${added === 1 ? '' : 's'}`);
        }
      }
    } catch (error) {
      // On failure, revert uncommitted changes to avoid confusion on next run (Pitfall #12)
      spinner.warn(`Failed to add dismissal comments: ${String(error)}`);
      try {
        await git.checkout(['--', '.']);
      } catch (revertError) {
        // Best effort revert; if it fails, log and continue
        console.error('Failed to revert uncommitted changes:', revertError);
      }
    }
    
    await ResolverProc.executeFinalCleanup(git, state.workdir, state.lessonsContext, state.stateContext, options, spinner, state.finalUnresolvedIssues, state.finalComments, state.exitReason, state.exitDetails,
      callbacks.cleanupCreatedSyncTargets, cleanupWorkdir, callbacks.printModelPerformance, callbacks.printHandoffPrompt, callbacks.printAfterActionReport, callbacks.printFinalSummary, callbacks.ringBell);
  } catch (error) {
    // Use empty string as workdir if not yet initialized (error during setup phase)
    // Prefer ref snapshot so AAR/remaining count are correct when error happens mid-iteration (audit: remaining on early exit, AAR on auth exit).
    const issuesForCleanup = finalUnresolvedIssuesRef.current.length > 0 ? finalUnresolvedIssuesRef.current : state.finalUnresolvedIssues;
    const commentsForCleanup = finalCommentsRef.current.length > 0 ? finalCommentsRef.current : state.finalComments;
    await ResolverProc.executeErrorCleanup(state.workdir || '', options, spinner, issuesForCleanup, commentsForCleanup, state.stateContext, cleanupWorkdir, callbacks.printModelPerformance, callbacks.printHandoffPrompt, callbacks.printAfterActionReport, callbacks.printFinalSummary, callbacks.ringBell);
    throw error;
  }
  return state;
}
