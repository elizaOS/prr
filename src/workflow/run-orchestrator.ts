/**
 * Run orchestrator - complete execution workflow
 * 
 * Orchestrates the entire PR resolution workflow from initialization through
 * setup, execution, and cleanup.
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
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import type { LLMClient } from '../llm/client.js';
import type { RotationContext } from '../models/rotation.js';
import { cleanupWorkdir } from '../git/workdir.js';
import * as ResolverProc from '../resolver-proc.js';
import { addDismissalComments } from './dismissal-comments.js';
import * as Dismissed from '../state/state-dismissed.js';

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
  tryRotation: () => boolean;
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
  checkForNewBotReviews: (owner: string, repo: string, prNumber: number, existingIds: Set<string>) => Promise<{ newComments: ReviewComment[]; message: string } | null>;
  calculateExpectedBotResponseTime: (lastCommitTime: Date) => Date | null;
  waitForBotReviews: (owner: string, repo: string, prNumber: number, headSha: string) => Promise<void>;
  cleanupCreatedSyncTargets: (git: SimpleGit) => Promise<void>;
  printModelPerformance: () => void;
  printHandoffPrompt: (issues: UnresolvedIssue[]) => void;
  printAfterActionReport: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
  printFinalSummary: () => void;
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
  try {
    const initResult = await ResolverProc.initializeRun(prUrl, github, options, spinner, callbacks.runCleanupMode, callbacks.calculateExpectedBotResponseTime);
    if (!initResult) {
      state.exitReason = 'init_failed';
      state.exitDetails = 'PR initialization returned no result';
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
      if (setupResult.exitReason) state.exitReason = setupResult.exitReason;
      if (setupResult.exitDetails) state.exitDetails = setupResult.exitDetails;
      return state;
    }
    const git = setupResult.git;
    let pushIteration = 0;
    // Use ?? so explicit 0 is honored (not treated as falsy)
    // CLI convention: 0 = unlimited. Use || (not ??) since 0 should map to Infinity.
    // CRITICAL: ?? only triggers on null/undefined, NOT 0. With default --max-push-iterations=0,
    // using ?? gives maxPushIterations=0 and the while(0<0) loop never executes.
    const maxPushIterations = options.autoPush ? (options.maxPushIterations || Infinity) : 1;

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
    const MAX_CONSECUTIVE_BAILOUTS = 2;
    let consecutiveBailouts = 0;
    let lastBailoutRemainingCount = Infinity;
    const prInfoRef = { current: state.prInfo };
    const finalUnresolvedIssuesRef = { current: state.finalUnresolvedIssues };
    const finalCommentsRef = { current: state.finalComments };
    const expectedBotResponseTimeRef = { current: state.expectedBotResponseTime };
    // Pass prefetched comments from setup phase to avoid redundant fetch on first iteration.
    // The push iteration loop clears this after consuming it once.
    const pushContexts = { prInfo: state.prInfo, stateContext: state.stateContext, lessonsContext: state.lessonsContext, finalUnresolvedIssues: state.finalUnresolvedIssues, finalComments: state.finalComments, prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef, prefetchedComments: setupResult.prefetchedComments };
    while (pushIteration < maxPushIterations) {
      pushIteration++;
      const iterResult = await ResolverProc.executePushIteration(
        { git, github, owner, repo, number, workdir: state.workdir },
        { pushIteration, maxPushIterations, rapidFailureCount: state.rapidFailureCount, lastFailureTime: state.lastFailureTime, consecutiveFailures: state.consecutiveFailures, modelFailuresInCycle: state.modelFailuresInCycle, progressThisCycle: state.progressThisCycle, expectedBotResponseTime: state.expectedBotResponseTime },
        pushContexts,
        { findUnresolvedIssues: callbacks.findUnresolvedIssues, resolveConflictsWithLLM: callbacks.resolveConflictsWithLLM, getCodeSnippet: callbacks.getCodeSnippet, printUnresolvedIssues: callbacks.printUnresolvedIssues, getCurrentModel: callbacks.getCurrentModel, getRunner: callbacks.getRunner, parseNoChangesExplanation: callbacks.parseNoChangesExplanation, trySingleIssueFix: callbacks.trySingleIssueFix, tryRotation: callbacks.tryRotation, tryDirectLLMFix: callbacks.tryDirectLLMFix, executeBailOut: callbacks.executeBailOut, checkForNewBotReviews: callbacks.checkForNewBotReviews, calculateExpectedBotResponseTime: callbacks.calculateExpectedBotResponseTime, waitForBotReviews: callbacks.waitForBotReviews },
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
      if (iterResult.shouldBreak) {
        break;
      }

      // Track consecutive bail-outs to prevent infinite re-entry.
      // HISTORY: After bail-out, push-iteration-loop returns shouldBreak:false
      // to let the outer loop process new bot comments. But bots add MORE
      // comments after each push, so each re-entry bails again on an even
      // larger set. After MAX_CONSECUTIVE_BAILOUTS (2), hard-exit: one
      // re-entry is useful (catches bot-resolved issues), beyond that is waste.
      if (iterResult.exitReason === 'bail_out') {
        const currentRemaining = state.finalUnresolvedIssues?.length ?? Infinity;
        if (currentRemaining >= lastBailoutRemainingCount) {
          // No progress since last bail-out — remaining count didn't shrink
          consecutiveBailouts++;
        } else {
          // Made some progress — reset counter but still track
          consecutiveBailouts = 1;
        }
        lastBailoutRemainingCount = currentRemaining;

        if (consecutiveBailouts >= MAX_CONSECUTIVE_BAILOUTS) {
          console.log(chalk.red(`\n  🛑 ${consecutiveBailouts} consecutive bail-outs with no progress — exiting outer loop`));
          console.log(chalk.gray(`     Re-entering would hit the same stalemate on ${currentRemaining} remaining issues`));
          state.exitReason = 'bail_out';
          state.exitDetails = `${consecutiveBailouts} consecutive stalemate bail-outs with no progress reduction`;
          break;
        }
      } else {
        // Non-bail-out iteration resets the counter
        consecutiveBailouts = 0;
        lastBailoutRemainingCount = Infinity;
      }
    }
    // Sync resolver instance with final state so callbacks (e.g. printFinalSummary)
    // see the updated exitReason. Without this, this.exitReason stays 'unknown'
    // because syncResolverState only ran once after setup, before the push loop.
    if (callbacks.syncResolverState) {
      callbacks.syncResolverState(state);
    }
    
    // Add dismissal comments as post-processing step (after all fix iterations complete)
    // WHY: Comments are added after fixer modifications are done so they don't get clobbered.
    // If comments are added, commit them separately for clean separation in git history.
    try {
      const dismissedIssues = Dismissed.getDismissedIssues(state.stateContext);
      if (dismissedIssues.length > 0) {
        const { added, skipped } = await addDismissalComments(
          dismissedIssues,
          state.workdir,
          llm
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
    await ResolverProc.executeErrorCleanup(state.workdir || '', options, spinner, state.finalUnresolvedIssues, state.finalComments, state.stateContext, cleanupWorkdir, callbacks.printModelPerformance, callbacks.printHandoffPrompt, callbacks.printAfterActionReport, callbacks.printFinalSummary, callbacks.ringBell);
    throw error;
  }
  return state;
}
