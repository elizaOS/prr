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
  getRotationContext: () => any;
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
    if (!initResult) return state;
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
    const maxPushIterations = options.autoPush ? (options.maxPushIterations || Infinity) : 1;
    const prInfoRef = { current: state.prInfo };
    const finalUnresolvedIssuesRef = { current: state.finalUnresolvedIssues };
    const finalCommentsRef = { current: state.finalComments };
    const expectedBotResponseTimeRef = { current: state.expectedBotResponseTime };
    while (pushIteration < maxPushIterations) {
      pushIteration++;
      const iterResult = await ResolverProc.executePushIteration(pushIteration, maxPushIterations, git, github, owner, repo, number, state.prInfo, state.stateContext, state.lessonsContext, llm, options, config, state.workdir, spinner, state.runner,
        state.rapidFailureCount, state.lastFailureTime, state.consecutiveFailures, state.modelFailuresInCycle, state.progressThisCycle, state.expectedBotResponseTime, state.finalUnresolvedIssues, state.finalComments,
        callbacks.findUnresolvedIssues, callbacks.resolveConflictsWithLLM, callbacks.getCodeSnippet, callbacks.printUnresolvedIssues, callbacks.getCurrentModel, callbacks.parseNoChangesExplanation,
        callbacks.trySingleIssueFix, callbacks.tryRotation, callbacks.tryDirectLLMFix, callbacks.executeBailOut, callbacks.checkForNewBotReviews, callbacks.calculateExpectedBotResponseTime, callbacks.waitForBotReviews,
        prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef);
      state.rapidFailureCount = iterResult.updatedRapidFailureCount;
      state.lastFailureTime = iterResult.updatedLastFailureTime;
      state.consecutiveFailures = iterResult.updatedConsecutiveFailures;
      state.modelFailuresInCycle = iterResult.updatedModelFailuresInCycle;
      state.progressThisCycle = iterResult.updatedProgressThisCycle;
      if (iterResult.updatedHeadSha) state.prInfo.headSha = iterResult.updatedHeadSha;
      state.prInfo = prInfoRef.current;
      state.finalUnresolvedIssues = finalUnresolvedIssuesRef.current;
      state.finalComments = finalCommentsRef.current;
      state.expectedBotResponseTime = expectedBotResponseTimeRef.current;
      if (iterResult.shouldBreak) {
        if (iterResult.exitReason) state.exitReason = iterResult.exitReason;
        if (iterResult.exitDetails) state.exitDetails = iterResult.exitDetails;
        break;
      }
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
