/**
 * Main resolver: runs the PR fix loop (analyze → fix → verify → commit) and
 * coordinates GitHub, LLM, runners, and state.
 *
 * WHY a class: Encapsulates per-run state (runner index, model indices, progress
 * counters, bot timings) that would otherwise be a large bag of arguments across
 * resolver-proc and rotation. Single entry point run(prUrl) keeps index.ts simple.
 * WHY delegate to resolver-proc: Procedural functions there are easier to test
 * and reason about; the class handles lifecycle and state, procedures handle flow.
 */
import chalk from 'chalk';
import { existsSync } from 'fs';
import ora from 'ora';
import { join } from 'path';
import type { Config } from '../../shared/config.js';
import type { CLIOptions } from './cli.js';
import type { ReviewComment, PRInfo, BotResponseTiming, PRStatus } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from '../../shared/runners/types.js';
import { GitHubAPI } from './github/api.js';
import { parsePRUrl } from './github/types.js';
import { LLMClient, type ModelRecommendationContext } from './llm/client.js';
import type { DismissedIssue } from './state/types.js';
import type { StateContext } from './state/state-context.js';
import type { LessonsContext } from './state/lessons-context.js';
import type { LockConfig } from './state/lock-functions.js';
import { ensureWorkdir, cleanupWorkdir, getWorkdirInfo } from '../../shared/git/workdir.js';
import { cloneOrUpdate, getChangedFiles, getDiffForFile, hasChanges, checkForConflicts, checkRemoteAhead, pullLatest, abortMerge, mergeBaseBranch, startMergeForConflictResolution, markConflictsResolved, completeMerge, isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from '../../shared/git/git-clone-index.js';
import type { SimpleGit } from 'simple-git';
import { squashCommit, pushWithRetry, commitIteration, scanCommittedFixes } from '../../shared/git/git-commit-index.js';
import { detectAvailableRunners, getRunnerByName, printRunnerSummary, DEFAULT_MODEL_ROTATIONS } from '../../shared/runners/detect.js';
import { debug, debugStep, setVerbose, warn, info, startTimer, endTimer, formatDuration, printTimingSummary, resetTimings, setTokenPhase, printTokenSummary, resetTokenUsage, formatNumber } from '../../shared/logger.js';
import * as Reporter from './ui/reporter.js';
import * as Rotation from './models/rotation.js';
import * as GitOps from './git/git-operations-index.js';
import * as ResolverProc from './resolver-proc.js';
import * as Performance from './state/state-performance.js';
import { getWiderSnippetForAnalysis } from './workflow/issue-analysis.js';
import { getFullFileContentForSingleIssue } from './workflow/utils.js';

export class PRResolver {
  private config: Config;
  private options: CLIOptions;
  private github: GitHubAPI;
  private llm: LLMClient;
  private stateContext!: StateContext;
  private lessonsContext!: LessonsContext;
  private lockConfig!: LockConfig;
  private runner!: Runner;
  private runners!: Runner[];
  private currentRunnerIndex = 0;
  private prInfo!: PRInfo;
  private workdir!: string;
  private isShuttingDown = false;
  private consecutiveFailures = 0;
  private modelIndices: Map<string, number> = new Map();
  private modelFailuresInCycle = 0;
  private modelsTriedThisToolRound = 0;
  private recommendedModels?: string[];
  private recommendedModelIndex = 0;
  private modelRecommendationReasoning?: string;
  private progressThisCycle = 0;
  private cycleHadOnlyTimeouts: boolean | undefined = undefined;
  private runnersAttemptedInCycle: Set<string> = new Set();
  private disabledRunners: Set<string> = new Set();
  private bailedOut = false;
  private botTimings: BotResponseTiming[] = [];
  private expectedBotResponseTime: Date | null = null;
  private lastCommentFetchTime: Date | null = null;
  private lastHeadSha: string | null = null;
  private exitReason: string = 'unknown';
  private exitDetails: string = '';
  private finalUnresolvedIssues: UnresolvedIssue[] = [];
  private finalComments: ReviewComment[] = [];
  private rapidFailureCount = 0;
  private lastFailureTime = 0;

  constructor(config: Config, options: CLIOptions) {
    this.config = config;
    this.options = options;
    this.github = new GitHubAPI(config.githubToken);
    this.llm = new LLMClient(config);
  }
  private getRotationContext(): Rotation.RotationContext {
    return { runner: this.runner, runners: this.runners, currentRunnerIndex: this.currentRunnerIndex, modelIndices: this.modelIndices,
      modelFailuresInCycle: this.modelFailuresInCycle, modelsTriedThisToolRound: this.modelsTriedThisToolRound, progressThisCycle: this.progressThisCycle,
      recommendedModels: this.recommendedModels, recommendedModelIndex: this.recommendedModelIndex, modelRecommendationReasoning: this.modelRecommendationReasoning,
      runnersAttemptedInCycle: this.runnersAttemptedInCycle, disabledRunners: this.disabledRunners, cycleHadOnlyTimeouts: this.cycleHadOnlyTimeouts, stateContext: this.stateContext };
  }
  private syncRotationContext(ctx: Rotation.RotationContext): void {
    this.runner = ctx.runner;
    this.runners = ctx.runners;
    this.currentRunnerIndex = ctx.currentRunnerIndex;
    this.modelIndices = ctx.modelIndices;
    this.modelFailuresInCycle = ctx.modelFailuresInCycle;
    this.modelsTriedThisToolRound = ctx.modelsTriedThisToolRound;
    this.progressThisCycle = ctx.progressThisCycle;
    this.recommendedModels = ctx.recommendedModels;
    this.recommendedModelIndex = ctx.recommendedModelIndex;
    this.modelRecommendationReasoning = ctx.modelRecommendationReasoning;
    this.runnersAttemptedInCycle = ctx.runnersAttemptedInCycle;
    this.cycleHadOnlyTimeouts = ctx.cycleHadOnlyTimeouts;
  }
  private ringBell(times: number = 3): void { ResolverProc.ringBell(times); }
  private printModelPerformance(): void { Reporter.printModelPerformance(this.stateContext); }
  private printFinalSummary(remainingCount?: number): void {
    Reporter.printFinalSummary(this.stateContext, this.exitReason, this.exitDetails, remainingCount);
  }
  private getExitReasonDisplay(): { label: string; icon: string; color: (text: string) => string } { return Reporter.getExitReasonDisplay(this.exitReason); }
  private printHandoffPrompt(unresolvedIssues: UnresolvedIssue[], exhaustedIssues?: DismissedIssue[]): void { Reporter.printHandoffPrompt(unresolvedIssues, this.options.noHandoffPrompt, exhaustedIssues ?? []); }
  private async printAfterActionReport(unresolvedIssues: UnresolvedIssue[], comments: ReviewComment[]): Promise<void> { return Reporter.printAfterActionReport(unresolvedIssues, comments, this.options.noAfterAction, this.stateContext, this.lessonsContext); }
  private getModelsForRunner(runner: Runner): string[] { return Rotation.getModelsForRunner(runner); }
  private getCurrentModel(): string | undefined { const ctx = this.getRotationContext(); return Rotation.getCurrentModel(ctx, this.options); }
  private isModelAvailableForRunner(model: string): boolean { const ctx = this.getRotationContext(); return Rotation.isModelAvailableForRunner(ctx, model); }
  private advanceModel(): boolean { const ctx = this.getRotationContext(); const result = Rotation.advanceModel(ctx, this.stateContext, this.options); this.syncRotationContext(ctx); return result; }
  private rotateModel(): boolean { const ctx = this.getRotationContext(); const result = Rotation.rotateModel(ctx, this.stateContext); this.syncRotationContext(ctx); return result; }
  private switchToNextRunner(): boolean { const ctx = this.getRotationContext(); const result = Rotation.switchToNextRunner(ctx, this.stateContext, this.options); this.syncRotationContext(ctx); return result; }
  private allModelsExhausted(): boolean { const ctx = this.getRotationContext(); return Rotation.allModelsExhausted(ctx); }
  private tryRotation(failureErrorType?: string): boolean { const ctx = this.getRotationContext(); ctx.cycleHadOnlyTimeouts = failureErrorType === 'timeout' ? (ctx.cycleHadOnlyTimeouts !== false) : false; const result = Rotation.tryRotation(ctx, this.stateContext, this.options); this.syncRotationContext(ctx); return result; }
  /** Reset model rotation to first model (call at start of each push iteration when pushIteration > 1). WHY: Each push cycle gets best model first instead of retrying the model that may have just 500'd or timed out. */
  private resetRotationToFirstModel(): void { const ctx = this.getRotationContext(); Rotation.resetCurrentModelToFirst(ctx, this.stateContext); this.syncRotationContext(ctx); }
  private async executeBailOut(unresolvedIssues: UnresolvedIssue[], comments: ReviewComment[]): Promise<void> { const result = await ResolverProc.executeBailOut(unresolvedIssues, comments, this.stateContext, this.lessonsContext, this.runners, this.options, (runner) => this.getModelsForRunner(runner), this.workdir, this.llm); this.bailedOut = result.bailedOut; this.exitReason = result.exitReason; this.exitDetails = result.exitDetails; this.finalUnresolvedIssues = result.finalUnresolvedIssues; this.finalComments = result.finalComments; }
  private async trySingleIssueFix(issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>): Promise<boolean> { return await ResolverProc.trySingleIssueFix(issues, git, this.workdir, this.runner, this.stateContext, this.lessonsContext, this.llm, verifiedThisSession, (issue, options) => this.buildSingleIssuePrompt(issue, options), () => this.getCurrentModel(), (output) => this.parseNoChangesExplanation(output), (output, maxLength) => this.sanitizeOutputForLog(output, maxLength), this.config.openaiApiKey); }
  private async buildSingleIssuePrompt(issue: UnresolvedIssue, options?: { pathExists?: (path: string) => boolean }): Promise<string> {
    const primaryPath = issue.resolvedPath ?? issue.comment.path;
    let codeSnippetOverride: string | undefined;
    if (this.stateContext.state?.widerSnippetRequestedByCommentId?.[issue.comment.id]) {
      codeSnippetOverride = await getWiderSnippetForAnalysis(this.workdir, primaryPath, issue.comment.line ?? null, issue.comment.body);
    }
    // WHY full file as default: Single-issue prompts with only 15-30 line snippets caused
    // models to respond INCOMPLETE_FILE/UNCLEAR. Full file (capped at 600 lines) gives
    // enough context for imports, types, and broader function structure.
    if (codeSnippetOverride === undefined && this.workdir) {
      codeSnippetOverride = await getFullFileContentForSingleIssue(this.workdir, primaryPath) ?? undefined;
    }
    const pathExists = options?.pathExists ?? (this.workdir ? ((p: string) => existsSync(join(this.workdir, p))) : undefined);
    return ResolverProc.buildSingleIssuePrompt(issue, this.lessonsContext, this.prInfo, codeSnippetOverride, { pathExists });
  }
  private async tryDirectLLMFix(issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>): Promise<boolean> { return await ResolverProc.tryDirectLLMFix(issues, git, this.workdir, this.config.llmProvider, this.llm, this.stateContext, verifiedThisSession, this.lessonsContext); }
  async gracefulShutdown(): Promise<void> { this.isShuttingDown = await ResolverProc.executeGracefulShutdown(this.isShuttingDown, this.stateContext, () => this.printModelPerformance(), () => this.printFinalSummary()); }
  isRunning(): boolean { return !this.isShuttingDown; }

  /** Abort in-flight LLM requests (e.g. on fatal error). Call from error handler before cleanup. */
  abortRun(): void {
    if (this.runAbortController) {
      this.runAbortController.abort();
      this.runAbortController = null;
      this.llm.setRunAbortSignal(null);
    }
  }

  private runAbortController: AbortController | null = null;

  async run(prUrl: string): Promise<void> {
    this.disabledRunners.clear();
    this.runAbortController = new AbortController();
    this.llm.setRunAbortSignal(this.runAbortController.signal);
    const state: ResolverProc.RunState = { prInfo: this.prInfo, botTimings: this.botTimings, expectedBotResponseTime: this.expectedBotResponseTime, workdir: this.workdir, stateContext: this.stateContext, lessonsContext: this.lessonsContext, lockConfig: this.lockConfig, runner: this.runner, runners: this.runners, currentRunnerIndex: this.currentRunnerIndex, modelIndices: this.modelIndices, rapidFailureCount: this.rapidFailureCount, lastFailureTime: this.lastFailureTime, consecutiveFailures: this.consecutiveFailures, modelFailuresInCycle: this.modelFailuresInCycle, progressThisCycle: this.progressThisCycle, exitReason: this.exitReason, exitDetails: this.exitDetails, finalUnresolvedIssues: this.finalUnresolvedIssues, finalComments: this.finalComments };
    const callbacks: ResolverProc.RunCallbacks = {
      setupRunner: () => this.setupRunner(),
      ensureStateFileIgnored: (workdir) => this.ensureStateFileIgnored(workdir),
      resolveConflictsWithLLM: (git, files, source) => this.resolveConflictsWithLLM(git, files, source),
      syncResolverState: (s) => Object.assign(this, s),
      getRotationContext: () => this.getRotationContext(),
      getCurrentModel: () => this.getCurrentModel(),
      getRunner: () => this.runner,
      findUnresolvedIssues: (comments, totalCount, opts) => this.findUnresolvedIssues(comments, totalCount, opts),
      getCodeSnippet: (path, line, commentBody) => this.getCodeSnippet(path, line, commentBody),
      printUnresolvedIssues: (issues) => this.printUnresolvedIssues(issues),
      parseNoChangesExplanation: (output) => this.parseNoChangesExplanation(output),
      trySingleIssueFix: (issues, git, verified) => this.trySingleIssueFix(issues, git, verified),
      tryRotation: (failureErrorType?: string) => this.tryRotation(failureErrorType),
      resetRotationToFirstModel: () => this.resetRotationToFirstModel(),
      tryDirectLLMFix: (issues, git, verified) => this.tryDirectLLMFix(issues, git, verified),
      executeBailOut: (issues, comments) => this.executeBailOut(issues, comments),
      onDisableRunner: (name) => this.disabledRunners.add(name),
      checkForNewBotReviews: (o, r, n, ids, headSha) => this.checkForNewBotReviews(o, r, n, ids, headSha), 
      calculateExpectedBotResponseTime: (lastCommitTime) => this.calculateExpectedBotResponseTime(lastCommitTime), 
      waitForBotReviews: (o, r, n, sha) => this.waitForBotReviews(o, r, n, sha), 
      cleanupCreatedSyncTargets: (git) => this.cleanupCreatedSyncTargets(git), 
      printModelPerformance: () => this.printModelPerformance(), 
      printHandoffPrompt: (issues, exhausted) => this.printHandoffPrompt(issues, exhausted), 
      printAfterActionReport: (issues, comments) => this.printAfterActionReport(issues, comments), 
      printFinalSummary: (remainingCount?: number) => this.printFinalSummary(remainingCount), 
      ringBell: (times) => this.ringBell(times), 
      runCleanupMode: (url, o, r, n) => this.runCleanupMode(url, o, r, n) 
    };
    const result = await ResolverProc.executeRun(prUrl, this.config, this.options, this.github, this.llm, ora(), callbacks, state);
    this.llm.setRunAbortSignal(null);
    this.runAbortController = null;
    // Explicitly sync only the mutable run-state fields
    this.prInfo = result.prInfo;
    this.botTimings = result.botTimings;
    this.expectedBotResponseTime = result.expectedBotResponseTime;
    this.workdir = result.workdir;
    this.stateContext = result.stateContext;
    this.lessonsContext = result.lessonsContext;
    this.lockConfig = result.lockConfig;
    this.runner = result.runner;
    this.runners = result.runners;
    this.currentRunnerIndex = result.currentRunnerIndex;
    this.modelIndices = result.modelIndices;
    this.rapidFailureCount = result.rapidFailureCount;
    this.lastFailureTime = result.lastFailureTime;
    this.consecutiveFailures = result.consecutiveFailures;
    this.modelFailuresInCycle = result.modelFailuresInCycle;
    this.progressThisCycle = result.progressThisCycle;
    this.exitReason = result.exitReason;
    this.exitDetails = result.exitDetails;
    this.finalUnresolvedIssues = result.finalUnresolvedIssues;
    this.finalComments = result.finalComments;
  }

  private async setupRunner(): Promise<Runner> { const result = await Rotation.setupRunner(this.options, this.config); this.runners = result.all; return result.primary; }
  private buildConflictResolutionPrompt(conflictedFiles: string[], baseBranch: string): string { return GitOps.buildConflictResolutionPrompt(conflictedFiles, baseBranch); }

  private async resolveConflictsWithLLM(git: SimpleGit, conflictedFiles: string[], mergingBranch: string): Promise<{ success: boolean; remainingConflicts: string[] }> { return GitOps.resolveConflictsWithLLM(git, conflictedFiles, mergingBranch, this.workdir, this.config, this.llm, this.runner, () => this.getCurrentModel()); }

  private async handleLockFileConflicts(git: SimpleGit, lockFiles: string[]): Promise<void> { return GitOps.handleLockFileConflicts(git, lockFiles, this.workdir, this.config); }
  private parseNoChangesExplanation(output: string): string | null { return ResolverProc.parseNoChangesExplanation(output); }
  private sanitizeOutputForLog(output: string | undefined, maxLength: number = 500): string { return ResolverProc.sanitizeOutputForLog(output, maxLength); }
  private validateDismissalExplanation(explanation: string, commentPath: string, commentLine: number | null): boolean { return ResolverProc.validateDismissalExplanation(explanation, commentPath, commentLine); }

  private async findUnresolvedIssues(comments: ReviewComment[], totalCount: number, opts?: import('./workflow/issue-analysis.js').FindUnresolvedIssuesOptions): Promise<{ unresolved: UnresolvedIssue[]; recommendedModels?: string[]; recommendedModelIndex: number; modelRecommendationReasoning?: string; duplicateMap: Map<string, string[]> }> { const result = await ResolverProc.findUnresolvedIssues(comments, totalCount, this.stateContext, this.lessonsContext, this.llm, this.runner, this.options, this.workdir, (path, line, commentBody) => this.getCodeSnippet(path, line, commentBody), (runner) => this.getModelsForRunner(runner), opts); if (result.recommendedModels?.length) { this.recommendedModels = Performance.sortRecommendedModelsByPerformance(result.recommendedModels, this.runner.name, this.stateContext); this.recommendedModelIndex = result.recommendedModelIndex; this.modelRecommendationReasoning = result.modelRecommendationReasoning; } return result; }

  private async ensureStateFileIgnored(workdir: string): Promise<void> { return ResolverProc.ensureStateFileIgnored(workdir); }
  private async cleanupCreatedSyncTargets(git: SimpleGit): Promise<void> { return GitOps.cleanupCreatedSyncTargets(git, this.workdir, this.lessonsContext); }
  private async runCleanupMode(prUrl: string, owner: string, repo: string, prNumber: number): Promise<void> { await ResolverProc.runCleanupMode(prUrl, owner, repo, prNumber, this.config, this.options, this.github, getWorkdirInfo, ensureWorkdir, (cloneUrl, branch, workdir, githubToken) => cloneOrUpdate(cloneUrl, branch, workdir, githubToken)); }
  private async getCodeSnippet(path: string, line: number | null, commentBody?: string): Promise<string> { return ResolverProc.getCodeSnippet(this.workdir, path, line, commentBody); }
  private printUnresolvedIssues(issues: UnresolvedIssue[]): void { Reporter.printUnresolvedIssues(issues); }
  private calculateExpectedBotResponseTime(lastCommitTime: Date): Date | null { return ResolverProc.calculateExpectedBotResponseTime(this.botTimings, lastCommitTime); }
  private shouldCheckForNewComments(): boolean { return ResolverProc.shouldCheckForNewComments(this.expectedBotResponseTime); }
  private async checkForNewBotReviews(owner: string, repo: string, prNumber: number, existingCommentIds: Set<string>, headSha?: string): Promise<{ newComments: ReviewComment[]; message: string } | null> {
    const { COMMENT_FETCH_SKIP_IF_FETCHED_WITHIN_MS } = await import('../../shared/constants.js');
    if (headSha && this.lastHeadSha === headSha && this.lastCommentFetchTime && (Date.now() - this.lastCommentFetchTime.getTime() < COMMENT_FETCH_SKIP_IF_FETCHED_WITHIN_MS)) {
      return null;
    }
    const result = await ResolverProc.checkForNewBotReviews(this.expectedBotResponseTime, this.botTimings, this.github, owner, repo, prNumber, existingCommentIds);
    if (result.lastCommentFetchTime) this.lastCommentFetchTime = result.lastCommentFetchTime;
    if (headSha) this.lastHeadSha = headSha;
    this.expectedBotResponseTime = result.updatedExpectedBotResponseTime;
    if (result.newComments) return { newComments: result.newComments, message: result.message! };
    return null;
  }
  private async calculateSmartWaitTime(owner: string, repo: string, prNumber: number, headSha: string): Promise<{ waitSeconds: number; reason: string }> { return ResolverProc.calculateSmartWaitTime(this.botTimings, this.options.pollInterval, this.github, owner, repo, prNumber, headSha); }
  private async waitForBotReviews(owner: string, repo: string, prNumber: number, headSha: string): Promise<void> { return ResolverProc.waitForBotReviews(this.botTimings, this.options.pollInterval, this.github, owner, repo, prNumber, headSha, this.stateContext); }
  private sleep(ms: number): Promise<void> { return ResolverProc.sleep(ms); }
}
