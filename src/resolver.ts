import chalk from 'chalk';
import ora from 'ora';
import type { Config } from './config.js';
import type { CLIOptions } from './cli.js';
import type { ReviewComment, PRInfo, BotResponseTiming, PRStatus } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from './runners/types.js';
import { GitHubAPI } from './github/api.js';
import { parsePRUrl } from './github/types.js';
import { LLMClient, type ModelRecommendationContext } from './llm/client.js';
import type { StateContext } from './state/state-context.js';
import type { LessonsContext } from './state/lessons-context.js';
import type { LockConfig } from './state/lock-functions.js';
import { ensureWorkdir, cleanupWorkdir } from './git/workdir.js';
import { cloneOrUpdate, getChangedFiles, getDiffForFile, hasChanges, checkForConflicts, checkRemoteAhead, pullLatest, abortMerge, mergeBaseBranch, startMergeForConflictResolution, markConflictsResolved, completeMerge, isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from './git/git-clone-index.js';
import type { SimpleGit } from 'simple-git';
import { squashCommit, pushWithRetry, commitIteration, scanCommittedFixes } from './git/git-commit-index.js';
import { detectAvailableRunners, getRunnerByName, printRunnerSummary, DEFAULT_MODEL_ROTATIONS } from './runners/index.js';
import { debug, debugStep, setVerbose, warn, info, startTimer, endTimer, formatDuration, printTimingSummary, resetTimings, setTokenPhase, printTokenSummary, resetTokenUsage, formatNumber } from './logger.js';
import * as Reporter from './ui/reporter.js';
import * as Rotation from './models/rotation.js';
import * as GitOps from './git/git-operations-index.js';
import * as ResolverProc from './resolver-proc.js';

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
  private static readonly MAX_MODELS_PER_TOOL_ROUND = 2;
  private recommendedModels?: string[];
  private recommendedModelIndex = 0;
  private modelRecommendationReasoning?: string;
  private progressThisCycle = 0;
  private bailedOut = false;
  private botTimings: BotResponseTiming[] = [];
  private expectedBotResponseTime: Date | null = null;
  private lastCommentFetchTime: Date | null = null;
  private exitReason: string = 'unknown';
  private exitDetails: string = '';
  private finalUnresolvedIssues: UnresolvedIssue[] = [];
  private finalComments: ReviewComment[] = [];
  private rapidFailureCount = 0;
  private lastFailureTime = 0;
  private static readonly MAX_RAPID_FAILURES = 3;
  private static readonly RAPID_FAILURE_MS = 2000;
  private static readonly RAPID_FAILURE_WINDOW_MS = 10_000;

  constructor(config: Config, options: CLIOptions) {
    this.config = config;
    this.options = options;
    this.github = new GitHubAPI(config.githubToken);
    this.llm = new LLMClient(config);
  }
  private getRotationContext(): Rotation.RotationContext {
    return { runner: this.runner, runners: this.runners, currentRunnerIndex: this.currentRunnerIndex, modelIndices: this.modelIndices,
      modelFailuresInCycle: this.modelFailuresInCycle, modelsTriedThisToolRound: this.modelsTriedThisToolRound, progressThisCycle: this.progressThisCycle,
      recommendedModels: this.recommendedModels, recommendedModelIndex: this.recommendedModelIndex, modelRecommendationReasoning: this.modelRecommendationReasoning };
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
  }
  private ringBell(times: number = 3): void { ResolverProc.ringBell(times); }
  private printModelPerformance(): void { Reporter.printModelPerformance(this.stateContext); }
  private printFinalSummary(): void {
    Reporter.printFinalSummary(this.stateContext, this.exitReason, this.exitDetails); 
  }
  private getExitReasonDisplay(): { label: string; icon: string; color: (text: string) => string } { return Reporter.getExitReasonDisplay(this.exitReason); }
  private printHandoffPrompt(unresolvedIssues: UnresolvedIssue[]): void { Reporter.printHandoffPrompt(unresolvedIssues, this.options.noHandoffPrompt); }
  private async printAfterActionReport(unresolvedIssues: UnresolvedIssue[], comments: ReviewComment[]): Promise<void> { return Reporter.printAfterActionReport(unresolvedIssues, comments, this.options.noAfterAction, this.stateContext, this.lessonsContext); }
  private getModelsForRunner(runner: Runner): string[] { return Rotation.getModelsForRunner(runner); }
  private getCurrentModel(): string | undefined { const ctx = this.getRotationContext(); return Rotation.getCurrentModel(ctx, this.options); }
  private isModelAvailableForRunner(model: string): boolean { const ctx = this.getRotationContext(); return Rotation.isModelAvailableForRunner(ctx, model); }
  private advanceModel(): boolean { const ctx = this.getRotationContext(); const result = Rotation.advanceModel(ctx, this.stateContext, this.options); this.syncRotationContext(ctx); return result; }
  private rotateModel(): boolean { const ctx = this.getRotationContext(); const result = Rotation.rotateModel(ctx, this.stateContext); this.syncRotationContext(ctx); return result; }
  private switchToNextRunner(): boolean { const ctx = this.getRotationContext(); const result = Rotation.switchToNextRunner(ctx, this.stateContext); this.syncRotationContext(ctx); return result; }
  private allModelsExhausted(): boolean { const ctx = this.getRotationContext(); return Rotation.allModelsExhausted(ctx); }
  private tryRotation(): boolean { const ctx = this.getRotationContext(); const result = Rotation.tryRotation(ctx, this.stateContext, this.options); this.syncRotationContext(ctx); return result; }
  private async executeBailOut(unresolvedIssues: UnresolvedIssue[], comments: ReviewComment[]): Promise<void> { const result = await ResolverProc.executeBailOut(unresolvedIssues, comments, this.stateContext, this.lessonsContext, this.runners, this.options, (runner) => this.getModelsForRunner(runner)); this.bailedOut = result.bailedOut; this.exitReason = result.exitReason; this.exitDetails = result.exitDetails; this.finalUnresolvedIssues = result.finalUnresolvedIssues; this.finalComments = result.finalComments; }
  private async trySingleIssueFix(issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>): Promise<boolean> { return await ResolverProc.trySingleIssueFix(issues, git, this.workdir, this.runner, this.stateContext, this.lessonsContext, this.llm, verifiedThisSession, (issue) => this.buildSingleIssuePrompt(issue), () => this.getCurrentModel(), (output) => this.parseNoChangesExplanation(output), (output, maxLength) => this.sanitizeOutputForLog(output, maxLength)); }
  private buildSingleIssuePrompt(issue: UnresolvedIssue): string { return ResolverProc.buildSingleIssuePrompt(issue, this.lessonsContext); }
  private async tryDirectLLMFix(issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>): Promise<boolean> { return await ResolverProc.tryDirectLLMFix(issues, git, this.workdir, this.config.llmProvider, this.llm, this.stateContext, verifiedThisSession); }
  async gracefulShutdown(): Promise<void> { this.isShuttingDown = await ResolverProc.executeGracefulShutdown(this.isShuttingDown, this.stateContext, () => this.printModelPerformance(), () => this.printFinalSummary()); }
  isRunning(): boolean { return !this.isShuttingDown; }
  async run(prUrl: string): Promise<void> {
    const state: ResolverProc.RunState = { prInfo: this.prInfo, botTimings: this.botTimings, expectedBotResponseTime: this.expectedBotResponseTime, workdir: this.workdir, stateContext: this.stateContext, lessonsContext: this.lessonsContext, lockConfig: this.lockConfig, runner: this.runner, runners: this.runners, currentRunnerIndex: this.currentRunnerIndex, modelIndices: this.modelIndices, rapidFailureCount: this.rapidFailureCount, lastFailureTime: this.lastFailureTime, consecutiveFailures: this.consecutiveFailures, modelFailuresInCycle: this.modelFailuresInCycle, progressThisCycle: this.progressThisCycle, exitReason: this.exitReason, exitDetails: this.exitDetails, finalUnresolvedIssues: this.finalUnresolvedIssues, finalComments: this.finalComments };
    const callbacks: ResolverProc.RunCallbacks = { 
      setupRunner: () => this.setupRunner(), 
      ensureStateFileIgnored: (workdir) => this.ensureStateFileIgnored(workdir), 
      resolveConflictsWithLLM: (git, files, source) => this.resolveConflictsWithLLM(git, files, source), 
      syncResolverState: (s) => Object.assign(this, s),
      getRotationContext: () => this.getRotationContext(), 
      getCurrentModel: () => this.getCurrentModel(), 
      findUnresolvedIssues: (comments, totalCount) => this.findUnresolvedIssues(comments, totalCount), 
      getCodeSnippet: (path, line, commentBody) => this.getCodeSnippet(path, line, commentBody), 
      printUnresolvedIssues: (issues) => this.printUnresolvedIssues(issues), 
      parseNoChangesExplanation: (output) => this.parseNoChangesExplanation(output), 
      trySingleIssueFix: (issues, git, verified) => this.trySingleIssueFix(issues, git, verified), 
      tryRotation: () => this.tryRotation(), 
      tryDirectLLMFix: (issues, git, verified) => this.tryDirectLLMFix(issues, git, verified), 
      executeBailOut: (issues, comments) => this.executeBailOut(issues, comments), 
      checkForNewBotReviews: (o, r, n, ids) => this.checkForNewBotReviews(o, r, n, ids), 
      calculateExpectedBotResponseTime: (lastCommitTime) => this.calculateExpectedBotResponseTime(lastCommitTime), 
      waitForBotReviews: (o, r, n, sha) => this.waitForBotReviews(o, r, n, sha), 
      cleanupCreatedSyncTargets: (git) => this.cleanupCreatedSyncTargets(git), 
      printModelPerformance: () => this.printModelPerformance(), 
      printHandoffPrompt: (issues) => this.printHandoffPrompt(issues), 
      printAfterActionReport: (issues, comments) => this.printAfterActionReport(issues, comments), 
      printFinalSummary: () => this.printFinalSummary(), 
      ringBell: (times) => this.ringBell(times), 
      runCleanupMode: (url, o, r, n) => this.runCleanupMode(url, o, r, n) 
    };
    const result = await ResolverProc.executeRun(prUrl, this.config, this.options, this.github, this.llm, ora(), callbacks, state);
    Object.assign(this, result);
  }

  private async setupRunner(): Promise<Runner> { const result = await Rotation.setupRunner(this.options, this.config); this.runners = result.all; return result.primary; }
  private buildConflictResolutionPrompt(conflictedFiles: string[], baseBranch: string): string { return GitOps.buildConflictResolutionPrompt(conflictedFiles, baseBranch); }

  private async resolveConflictsWithLLM(git: SimpleGit, conflictedFiles: string[], mergingBranch: string): Promise<{ success: boolean; remainingConflicts: string[] }> { return GitOps.resolveConflictsWithLLM(git, conflictedFiles, mergingBranch, this.workdir, this.config, this.llm, this.runner, () => this.getCurrentModel()); }

  private async handleLockFileConflicts(git: SimpleGit, lockFiles: string[]): Promise<void> { return GitOps.handleLockFileConflicts(git, lockFiles, this.workdir, this.config); }
  private parseNoChangesExplanation(output: string): string | null { return ResolverProc.parseNoChangesExplanation(output); }
  private sanitizeOutputForLog(output: string | undefined, maxLength: number = 500): string { return ResolverProc.sanitizeOutputForLog(output, maxLength); }
  private validateDismissalExplanation(explanation: string, commentPath: string, commentLine: number | null): boolean { return ResolverProc.validateDismissalExplanation(explanation, commentPath, commentLine); }

  private async findUnresolvedIssues(comments: ReviewComment[], totalCount: number): Promise<UnresolvedIssue[]> { const result = await ResolverProc.findUnresolvedIssues(comments, totalCount, this.stateContext, this.lessonsContext, this.llm, this.runner, this.options, (path, line, commentBody) => this.getCodeSnippet(path, line, commentBody), (runner) => this.getModelsForRunner(runner)); if (result.recommendedModels?.length) { this.recommendedModels = result.recommendedModels; this.recommendedModelIndex = result.recommendedModelIndex; this.modelRecommendationReasoning = result.modelRecommendationReasoning; } return result.unresolved; }

  private async ensureStateFileIgnored(workdir: string): Promise<void> { return ResolverProc.ensureStateFileIgnored(workdir); }
  private async cleanupCreatedSyncTargets(git: SimpleGit): Promise<void> { return GitOps.cleanupCreatedSyncTargets(git, this.workdir, this.lessonsContext); }
  private async runCleanupMode(prUrl: string, owner: string, repo: string, prNumber: number): Promise<void> { await ResolverProc.runCleanupMode(prUrl, owner, repo, prNumber, this.config, this.options, this.github, getWorkdirInfo, ensureWorkdir, (cloneUrl, branch, workdir, githubToken) => cloneOrUpdate(cloneUrl, branch, workdir, githubToken)); }
  private async getCodeSnippet(path: string, line: number | null, commentBody?: string): Promise<string> { return ResolverProc.getCodeSnippet(this.workdir, path, line, commentBody); }
  private printUnresolvedIssues(issues: UnresolvedIssue[]): void { Reporter.printUnresolvedIssues(issues); }
  private calculateExpectedBotResponseTime(lastCommitTime: Date): Date | null { return ResolverProc.calculateExpectedBotResponseTime(this.botTimings, lastCommitTime); }
  private shouldCheckForNewComments(): boolean { return ResolverProc.shouldCheckForNewComments(this.expectedBotResponseTime); }
  private async checkForNewBotReviews(owner: string, repo: string, prNumber: number, existingCommentIds: Set<string>): Promise<{ newComments: ReviewComment[]; message: string } | null> { const result = await ResolverProc.checkForNewBotReviews(this.expectedBotResponseTime, this.botTimings, this.github, owner, repo, prNumber, existingCommentIds); if (result.lastCommentFetchTime) this.lastCommentFetchTime = result.lastCommentFetchTime; this.expectedBotResponseTime = result.updatedExpectedBotResponseTime; if (result.newComments) return { newComments: result.newComments, message: result.message! }; return null; }
  private async calculateSmartWaitTime(owner: string, repo: string, prNumber: number, headSha: string): Promise<{ waitSeconds: number; reason: string }> { return ResolverProc.calculateSmartWaitTime(this.botTimings, this.options.pollInterval, this.github, owner, repo, prNumber, headSha); }
  private async waitForBotReviews(owner: string, repo: string, prNumber: number, headSha: string): Promise<void> { return ResolverProc.waitForBotReviews(this.botTimings, this.options.pollInterval, this.github, owner, repo, prNumber, headSha); }
  private sleep(ms: number): Promise<void> { return ResolverProc.sleep(ms); }
}
