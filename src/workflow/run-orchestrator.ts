/**
 * Run orchestrator - complete execution workflow
 * 
 * Orchestrates the entire PR resolution workflow from initialization through
 * setup, execution, and cleanup.
 */

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
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<UnresolvedIssue[]>;
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
    const maxPushIterations = options.autoPush ? (options.maxPushIterations ?? Infinity) : 1;
    const prInfoRef = { current: state.prInfo };
    const finalUnresolvedIssuesRef = { current: state.finalUnresolvedIssues };
    const finalCommentsRef = { current: state.finalComments };
    const expectedBotResponseTimeRef = { current: state.expectedBotResponseTime };
    while (pushIteration < maxPushIterations) {
      pushIteration++;
      const iterResult = await ResolverProc.executePushIteration(
        { git, github, owner, repo, number, workdir: state.workdir },
        { pushIteration, maxPushIterations, rapidFailureCount: state.rapidFailureCount, lastFailureTime: state.lastFailureTime, consecutiveFailures: state.consecutiveFailures, modelFailuresInCycle: state.modelFailuresInCycle, progressThisCycle: state.progressThisCycle, expectedBotResponseTime: state.expectedBotResponseTime },
        { prInfo: state.prInfo, stateContext: state.stateContext, lessonsContext: state.lessonsContext, finalUnresolvedIssues: state.finalUnresolvedIssues, finalComments: state.finalComments, prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef },
        { findUnresolvedIssues: callbacks.findUnresolvedIssues, resolveConflictsWithLLM: callbacks.resolveConflictsWithLLM, getCodeSnippet: callbacks.getCodeSnippet, printUnresolvedIssues: callbacks.printUnresolvedIssues, getCurrentModel: callbacks.getCurrentModel, parseNoChangesExplanation: callbacks.parseNoChangesExplanation, trySingleIssueFix: callbacks.trySingleIssueFix, tryRotation: callbacks.tryRotation, tryDirectLLMFix: callbacks.tryDirectLLMFix, executeBailOut: callbacks.executeBailOut, checkForNewBotReviews: callbacks.checkForNewBotReviews, calculateExpectedBotResponseTime: callbacks.calculateExpectedBotResponseTime, waitForBotReviews: callbacks.waitForBotReviews },
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
    }
    // Sync resolver instance with final state so callbacks (e.g. printFinalSummary)
    // see the updated exitReason. Without this, this.exitReason stays 'unknown'
    // because syncResolverState only ran once after setup, before the push loop.
    if (callbacks.syncResolverState) {
      callbacks.syncResolverState(state);
    }
    await ResolverProc.executeFinalCleanup(git, state.workdir, state.lessonsContext, state.stateContext, options, spinner, state.finalUnresolvedIssues, state.finalComments, state.exitReason, state.exitDetails,
      callbacks.cleanupCreatedSyncTargets, cleanupWorkdir, callbacks.printModelPerformance, callbacks.printHandoffPrompt, callbacks.printAfterActionReport, callbacks.printFinalSummary, callbacks.ringBell);
  } catch (error) {
    // Use empty string as workdir if not yet initialized (error during setup phase)
    await ResolverProc.executeErrorCleanup(state.workdir || '', options, spinner, state.finalUnresolvedIssues, state.finalComments, cleanupWorkdir, callbacks.printModelPerformance, callbacks.printHandoffPrompt, callbacks.printAfterActionReport, callbacks.printFinalSummary, callbacks.ringBell);
    throw error;
  }
  return state;
}
