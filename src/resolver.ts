import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import type { Config } from './config.js';
import type { CLIOptions } from './cli.js';
import type { ReviewComment, PRInfo, BotResponseTiming, PRStatus } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from './runners/types.js';

import { GitHubAPI } from './github/api.js';
import { parsePRUrl } from './github/types.js';
import { LLMClient, type ModelRecommendationContext } from './llm/client.js';
import { StateManager } from './state/manager.js';
import { LessonsManager, formatLessonForDisplay } from './state/lessons.js';
import { buildFixPrompt } from './analyzer/prompt-builder.js';
import { getWorkdirInfo, ensureWorkdir, cleanupWorkdir } from './git/workdir.js';
import { cloneOrUpdate, getChangedFiles, getDiffForFile, hasChanges, checkForConflicts, pullLatest, abortMerge, mergeBaseBranch, startMergeForConflictResolution, markConflictsResolved, completeMerge, isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from './git/clone.js';
import type { SimpleGit } from 'simple-git';
import { squashCommit, pushWithRetry, commitIteration, scanCommittedFixes } from './git/commit.js';
import { detectAvailableRunners, getRunnerByName, printRunnerSummary, DEFAULT_MODEL_ROTATIONS } from './runners/index.js';
import { debug, debugStep, setVerbose, warn, info, startTimer, endTimer, formatDuration, printTimingSummary, resetTimings, setTokenPhase, printTokenSummary, resetTokenUsage, formatNumber } from './logger.js';

export class PRResolver {
  private config: Config;
  private options: CLIOptions;
  private github: GitHubAPI;
  private llm: LLMClient;
  private stateManager!: StateManager;
  private lessonsManager!: LessonsManager;
  private runner!: Runner;
  private runners!: Runner[];
  private currentRunnerIndex = 0;
  private prInfo!: PRInfo;
  private workdir!: string;
  private isShuttingDown = false;
  private consecutiveFailures = 0;
  
  // Model rotation: track current model index for each runner
  private modelIndices: Map<string, number> = new Map();
  private modelFailuresInCycle = 0;  // Failures since last model/tool rotation
  private modelsTriedThisToolRound = 0;  // Models tried on current tool before switching
  private static readonly MAX_MODELS_PER_TOOL_ROUND = 2;  // Switch tools after this many models
  
  // Smart model selection: LLM recommends models based on issue analysis
  // WHY: Instead of blind rotation, let the LLM recommend models based on issue complexity
  // and historical performance. Still rotate within recommendations for different perspectives.
  private recommendedModels?: string[];
  private recommendedModelIndex = 0;
  private modelRecommendationReasoning?: string;
  
  // Bail-out tracking: detect stalemates where no progress is made
  // WHY: Prevents infinite loops when agents disagree or can't fix issues
  private progressThisCycle = 0;  // Verified fixes in current tool/model cycle
  private bailedOut = false;  // True if we've triggered bail-out
  
  // Bot response timing data - used to schedule smart waits after pushing
  // WHY: Instead of fixed pollInterval, wait based on observed bot response times
  private botTimings: BotResponseTiming[] = [];
  
  // Expected bot response time - when we predict bot reviews will arrive
  // WHY: Work on existing issues while waiting, then pull new issues when ready
  private expectedBotResponseTime: Date | null = null;
  private lastCommentFetchTime: Date | null = null;
  
  // Exit reason tracking - explains why the session ended
  // WHY: Users need to know at a glance why we stopped (success, bail-out, limits, etc.)
  private exitReason: string = 'unknown';
  private exitDetails: string = '';
  
  // Final state for after action report
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

  /**
   * Ring terminal bell to notify user
   * WHY: Long-running processes need audio notification when complete
   */
  private ringBell(times: number = 3): void {
    for (let i = 0; i < times; i++) {
      process.stdout.write('\x07'); // BEL character (ASCII 7)
    }
  }

  /**
   * Print model performance summary.
   * WHY: Shows which models work well for this project and which don't.
   * Helps users understand which models to prefer or avoid.
   */
  private printModelPerformance(): void {
    if (!this.stateManager) return;
    
    const models = this.stateManager.getModelsBySuccessRate();
    if (models.length === 0) return;
    
    console.log(chalk.cyan('\n📊 Model Performance:'));
    
    for (const { key, stats, successRate } of models) {
      const total = stats.fixes + stats.failures;
      if (total === 0 && stats.noChanges === 0 && stats.errors === 0) continue;
      
      const pct = total > 0 ? Math.round(successRate * 100) : 0;
      const successColor = pct >= 70 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
      
      const parts: string[] = [];
      if (stats.fixes > 0) parts.push(chalk.green(`${formatNumber(stats.fixes)} fixes`));
      if (stats.failures > 0) parts.push(chalk.red(`${formatNumber(stats.failures)} failed`));
      if (stats.noChanges > 0) parts.push(chalk.gray(`${formatNumber(stats.noChanges)} no-change`));
      if (stats.errors > 0) parts.push(chalk.red(`${formatNumber(stats.errors)} errors`));
      
      const rateStr = total > 0 ? ` (${successColor(pct + '%')} success)` : '';
      console.log(`  ${key}: ${parts.join(', ')}${rateStr}`);
    }
  }

  /**
   * Print final results summary AFTER profiling output.
   * WHY: Profiling info pushes important results off screen. This ensures
   * the most important info (what got fixed) is visible at the end.
   */
  private printFinalSummary(): void {
    if (!this.stateManager) return;
    
    // Get counts
    const verifiedFixed = this.stateManager.getState()?.verifiedFixed || [];
    const dismissedIssues = this.stateManager.getDismissedIssues();
    
    console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('                      RESULTS SUMMARY                         '));
    console.log(chalk.cyan('════════════════════════════════════════════════════════════'));
    
    // Exit reason - most important info
    const exitReasonDisplay = this.getExitReasonDisplay();
    console.log(exitReasonDisplay.color(`\n  ${exitReasonDisplay.icon} Exit: ${exitReasonDisplay.label}`));
    if (this.exitDetails) {
      console.log(chalk.gray(`     ${this.exitDetails}`));
    }
    
    // Fixed issues
    if (verifiedFixed.length > 0) {
      console.log(chalk.green(`\n  ✓ ${formatNumber(verifiedFixed.length)} issue${verifiedFixed.length === 1 ? '' : 's'} fixed and verified`));
    }
    
    // Dismissed issues by category
    if (dismissedIssues.length > 0) {
      const byCategory = dismissedIssues.reduce((acc, issue) => {
        acc[issue.category] = (acc[issue.category] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      const categoryParts = Object.entries(byCategory)
        .map(([cat, count]) => `${count} ${cat}`)
        .join(', ');
      
      console.log(chalk.gray(`  ○ ${formatNumber(dismissedIssues.length)} issue${dismissedIssues.length === 1 ? '' : 's'} dismissed (${categoryParts})`));
    }
    
    console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
  }

  /**
   * Get display properties for the current exit reason.
   */
  private getExitReasonDisplay(): { label: string; icon: string; color: typeof chalk.green } {
    switch (this.exitReason) {
      case 'all_fixed':
      case 'all_resolved':
      case 'audit_passed':
        return { label: 'All issues resolved', icon: '✓', color: chalk.green };
      
      case 'bail_out':
        return { label: 'Bail-out (stalemate)', icon: '⚠', color: chalk.red };
      
      case 'max_iterations':
        return { label: 'Max iterations reached', icon: '⏱', color: chalk.yellow };
      
      case 'no_comments':
        return { label: 'No review comments found', icon: '○', color: chalk.green };
      
      case 'dry_run':
        return { label: 'Dry run completed', icon: '👁', color: chalk.blue };
      
      case 'no_commit_mode':
        return { label: 'Stopped (no-commit mode)', icon: '⏸', color: chalk.yellow };
      
      case 'no_push_mode':
        return { label: 'Stopped (no-push mode)', icon: '⏸', color: chalk.yellow };
      
      case 'committed_locally':
        return { label: 'Committed locally (not pushed)', icon: '📝', color: chalk.blue };
      
      case 'no_changes':
        return { label: 'No changes made', icon: '○', color: chalk.yellow };
      
      default:
        return { label: this.exitReason || 'Unknown', icon: '?', color: chalk.gray };
    }
  }

  /**
   * Print developer handoff prompt for remaining issues.
   * This gives a prompt that can be used with any LLM tool to continue the work.
   */
  private printHandoffPrompt(unresolvedIssues: UnresolvedIssue[]): void {
    if (this.options.noHandoffPrompt || unresolvedIssues.length === 0) return;
    
    console.log(chalk.cyan('\n┌─────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('│              DEVELOPER HANDOFF PROMPT                       │'));
    console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));
    console.log(chalk.gray('\nCopy this prompt to continue with a different tool:\n'));
    
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.white(`Fix the following ${unresolvedIssues.length} code review issue(s):\n`));
    
    for (let i = 0; i < unresolvedIssues.length; i++) {
      const issue = unresolvedIssues[i];
      console.log(chalk.white(`${i + 1}. File: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}`));
      console.log(chalk.white(`   Issue: ${issue.comment.body.split('\n')[0].substring(0, 100)}${issue.comment.body.length > 100 ? '...' : ''}`));
      if (issue.comment.body.split('\n').length > 1) {
        const secondLine = issue.comment.body.split('\n')[1].trim();
        if (secondLine) {
          console.log(chalk.white(`          ${secondLine.substring(0, 80)}${secondLine.length > 80 ? '...' : ''}`));
        }
      }
      console.log('');
    }
    
    console.log(chalk.white('For each issue, make the minimum necessary code change to address'));
    console.log(chalk.white('the reviewer\'s concern while maintaining code quality and tests.'));
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.gray('\n(Disable with --no-handoff-prompt)'));
  }

  /**
   * Print after action report for remaining issues.
   * Provides analysis of what was attempted and possible resolutions.
   */
  private async printAfterActionReport(
    unresolvedIssues: UnresolvedIssue[],
    comments: ReviewComment[]
  ): Promise<void> {
    if (this.options.noAfterAction || unresolvedIssues.length === 0) return;
    
    console.log(chalk.cyan('\n┌─────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('│                 AFTER ACTION REPORT                         │'));
    console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));
    
    
    for (let i = 0; i < unresolvedIssues.length; i++) {
      const issue = unresolvedIssues[i];
      const issueNum = i + 1;
      
      console.log(chalk.yellow(`\n━━━ Issue ${issueNum}/${unresolvedIssues.length}: ${issue.comment.path}:${issue.comment.line || '?'} ━━━`));
      
      // Original issue
      console.log(chalk.cyan('\n  📝 Original Issue:'));
      const issueLines = issue.comment.body.split('\n').slice(0, 4);
      for (const line of issueLines) {
        console.log(chalk.gray(`     ${line.substring(0, 70)}${line.length > 70 ? '...' : ''}`));
      }
      if (issue.comment.body.split('\n').length > 4) {
        console.log(chalk.gray('     ...'));
      }
      
      // Analysis / why it's hard
      console.log(chalk.cyan('\n  🔍 Analysis:'));
      if (issue.explanation) {
        console.log(chalk.gray(`     ${issue.explanation}`));
      }
      
      // Check model performance for this file
      const fileModels = this.stateManager?.getModelsBySuccessRate() || [];
      const relevantAttempts = fileModels.filter(m => m.stats.fixes > 0 || m.stats.failures > 0);
      if (relevantAttempts.length > 0) {
        console.log(chalk.gray(`     Tools attempted: ${relevantAttempts.map(m => m.key.split('/')[0]).join(', ')}`));
      }
      
      // Learnings related to this file
      const fileSpecificLessons = this.lessonsManager?.getLessonsForFiles([issue.comment.path]) || [];
      if (fileSpecificLessons.length > 0) {
        console.log(chalk.cyan('\n  📚 Relevant Learnings:'));
        for (const lesson of fileSpecificLessons.slice(0, 2)) {
          console.log(chalk.gray(`     • ${lesson.substring(0, 80)}${lesson.length > 80 ? '...' : ''}`));
        }
      }
      
      // Possible resolutions
      console.log(chalk.cyan('\n  💡 Possible Resolutions:'));
      const resolutions = this.suggestResolutions(issue);
      for (const resolution of resolutions) {
        console.log(chalk.gray(`     • ${resolution}`));
      }
    }
    
    // Summary
    console.log(chalk.cyan('\n━━━ Summary ━━━'));
    const fixedCount = comments.filter(c => this.stateManager?.isCommentVerifiedFixed(c.id)).length;
    const dismissedCount = this.stateManager?.getDismissedIssues().length || 0;
    console.log(chalk.gray(`  Total issues: ${comments.length}`));
    console.log(chalk.green(`  Fixed: ${fixedCount}`));
    console.log(chalk.gray(`  Dismissed: ${dismissedCount}`));
    console.log(chalk.yellow(`  Remaining: ${unresolvedIssues.length}`));
    
    console.log(chalk.gray('\n(Disable with --no-after-action)'));
  }

  /**
   * Suggest possible resolutions for an unresolved issue.
   */
  private suggestResolutions(issue: UnresolvedIssue): string[] {
    const resolutions: string[] = [];
    const body = issue.comment.body.toLowerCase();
    const path = issue.comment.path.toLowerCase();
    
    // Generic suggestions based on issue content
    if (body.includes('type') || body.includes('typescript')) {
      resolutions.push('Review TypeScript types and interfaces in the file');
    }
    if (body.includes('test') || body.includes('coverage')) {
      resolutions.push('Add or update tests for the affected code');
    }
    if (body.includes('error') || body.includes('exception') || body.includes('handle')) {
      resolutions.push('Review error handling and edge cases');
    }
    if (body.includes('performance') || body.includes('slow') || body.includes('optimize')) {
      resolutions.push('Profile the code and consider caching or algorithmic improvements');
    }
    if (body.includes('security') || body.includes('injection') || body.includes('sanitize')) {
      resolutions.push('Review security implications and add input validation');
    }
    if (body.includes('refactor') || body.includes('clean') || body.includes('simplify')) {
      resolutions.push('Break down into smaller functions or extract common patterns');
    }
    
    // File-type specific suggestions
    if (path.endsWith('.tsx') || path.endsWith('.jsx')) {
      resolutions.push('Check React component props and state management');
    }
    if (path.includes('test')) {
      resolutions.push('Verify test assertions match expected behavior');
    }
    
    // Always include these
    if (resolutions.length === 0) {
      resolutions.push('Manually review the code and reviewer comment');
    }
    resolutions.push('Try a different LLM model with more context');
    resolutions.push('Break the issue into smaller, incremental changes');
    
    return resolutions.slice(0, 4); // Max 4 suggestions
  }

  /**
   * Get the list of models available for a runner
   */
  private getModelsForRunner(runner: Runner): string[] {
    // Use runner's own list if provided, otherwise use defaults
    return runner.supportedModels || DEFAULT_MODEL_ROTATIONS[runner.name] || [];
  }

  /**
   * Get the current model for the active runner
   * Returns undefined if using CLI default or user-specified model
   * 
   * Smart model selection (default):
   * - Uses LLM-recommended models first (if available)
   * - Falls back to rotation when recommendations exhausted
   * 
   * Legacy rotation (--model-rotation):
   * - Uses DEFAULT_MODEL_ROTATIONS in order
   */
  private getCurrentModel(): string | undefined {
    // If user specified a model via CLI, always use that
    if (this.options.toolModel) {
      return this.options.toolModel;
    }
    
    // Smart model selection: use LLM recommendations first
    if (!this.options.modelRotation && this.recommendedModels?.length) {
      const model = this.recommendedModels[this.recommendedModelIndex];
      if (model && this.isModelAvailableForRunner(model)) {
        return model;
      }
    }
    
    // Fall back to legacy rotation
    const models = this.getModelsForRunner(this.runner);
    if (models.length === 0) {
      return undefined;  // Let the tool use its default
    }
    
    const index = this.modelIndices.get(this.runner.name) || 0;
    return models[index];
  }
  
  /**
   * Check if a model is available for the current runner
   */
  private isModelAvailableForRunner(model: string): boolean {
    const available = this.getModelsForRunner(this.runner);
    const lowerModel = model.toLowerCase();
    return available.some(m => {
      const lowerAvail = m.toLowerCase();
      return lowerAvail === lowerModel || 
             lowerAvail.includes(lowerModel) || 
             lowerModel.includes(lowerAvail);
    });
  }
  
  /**
   * Advance to next recommended model, or fall back to rotation
   * Returns true if we have more models to try
   */
  private advanceModel(): boolean {
    // If using smart selection and we have recommendations
    if (!this.options.modelRotation && this.recommendedModels?.length) {
      this.recommendedModelIndex++;
      
      // Still have recommendations to try?
      if (this.recommendedModelIndex < this.recommendedModels.length) {
        const nextModel = this.recommendedModels[this.recommendedModelIndex];
        const prevModel = this.recommendedModels[this.recommendedModelIndex - 1];
        console.log(chalk.yellow(`\n  🔄 Next recommended model: ${prevModel} → ${nextModel}`));
        return true;
      }
      
      // Exhausted recommendations, clear and fall back to rotation
      console.log(chalk.gray(`  Exhausted ${this.recommendedModels.length} recommended models, falling back to rotation`));
      this.recommendedModels = undefined;
      this.recommendedModelIndex = 0;
    }
    
    // Fall back to legacy rotation
    return this.rotateModel();
  }

  /**
   * Rotate to the next model for the current runner
   * Returns true if rotated to a new model, false if we've cycled through all
   */
  private rotateModel(): boolean {
    const models = this.getModelsForRunner(this.runner);
    if (models.length <= 1) {
      return false;  // No rotation possible
    }
    
    const currentIndex = this.modelIndices.get(this.runner.name) || 0;
    const nextIndex = (currentIndex + 1) % models.length;
    
    // Check if we've completed a full cycle
    if (nextIndex === 0) {
      return false;  // Cycled through all models
    }
    
    const previousModel = models[currentIndex];
    const nextModel = models[nextIndex];
    this.modelIndices.set(this.runner.name, nextIndex);
    
    // Persist to state so we resume here if interrupted
    this.stateManager.setModelIndex(this.runner.name, nextIndex);
    
    this.modelsTriedThisToolRound++;
    console.log(chalk.yellow(`\n  🔄 Rotating model: ${previousModel} → ${nextModel}`));
    return true;
  }

  /**
   * Switch to the next runner/tool
   * Does NOT reset model index - we continue where we left off when we come back
   * WHY: Interleaving tools is more effective than exhausting all models on one tool
   */
  private switchToNextRunner(): boolean {
    if (this.runners.length <= 1) return false;
    
    const previousRunner = this.runner.name;
    this.currentRunnerIndex = (this.currentRunnerIndex + 1) % this.runners.length;
    this.runner = this.runners[this.currentRunnerIndex];
    
    // Persist runner index so we resume here if interrupted
    this.stateManager.setCurrentRunnerIndex(this.currentRunnerIndex);
    
    // Reset the per-tool-round counter, but DON'T reset model index
    // We'll continue from where we left off on this tool
    this.modelsTriedThisToolRound = 0;
    
    const newModel = this.getCurrentModel();
    const modelInfo = newModel ? ` (${newModel})` : '';
    console.log(chalk.yellow(`\n  🔄 Switching fixer: ${previousRunner} → ${this.runner.name}${modelInfo}`));
    return true;
  }

  /**
   * Check if all tools have exhausted all their models
   */
  private allModelsExhausted(): boolean {
    for (const runner of this.runners) {
      const models = this.getModelsForRunner(runner);
      const currentIndex = this.modelIndices.get(runner.name) || 0;
      // If any runner has models left to try, we're not exhausted
      if (currentIndex < models.length - 1) {
        return false;
      }
    }
    return true;
  }

  /**
   * Try rotating - interleaves tools more aggressively
   * Strategy: Try MAX_MODELS_PER_TOOL_ROUND models on current tool, then switch tools
   * WHY: Different tools have different strengths; cycling through tools faster
   * gives each tool a chance before we exhaust all options on one tool
   * 
   * Returns false if we should bail out (too many cycles with no progress).
   */
  private tryRotation(): boolean {
    // Track which tools we've fully exhausted (tried all models)
    const exhaustedTools = new Set<string>();
    
    // Check if current tool is exhausted
    const checkToolExhausted = (runnerName: string): boolean => {
      const models = this.getModelsForRunner(this.runners.find(r => r.name === runnerName)!);
      const currentIndex = this.modelIndices.get(runnerName) || 0;
      return currentIndex >= models.length - 1;  // On last model or beyond
    };
    
    // Helper: Check if we should bail out after completing a cycle
    const checkBailOut = (): boolean => {
      // A cycle just completed - check if we made progress
      if (this.progressThisCycle === 0) {
        const cycles = this.stateManager.incrementNoProgressCycles();
        console.log(chalk.yellow(`\n  ⚠️  Completed cycle ${cycles} with zero progress`));
        
        if (cycles >= this.options.maxStaleCycles) {
          console.log(chalk.red(`\n  🛑 Bail-out triggered: ${cycles} cycles with no progress (max: ${this.options.maxStaleCycles})`));
          return true;  // Signal bail-out
        }
      } else {
        // Made progress - reset counter
        this.stateManager.resetNoProgressCycles();
      }
      
      // Reset for next cycle
      this.progressThisCycle = 0;
      return false;
    };
    
    // If we've tried enough models on this tool, switch to next tool
    if (this.modelsTriedThisToolRound >= PRResolver.MAX_MODELS_PER_TOOL_ROUND && this.runners.length > 1) {
      // Mark current tool if exhausted
      if (checkToolExhausted(this.runner.name)) {
        exhaustedTools.add(this.runner.name);
      }
      
      // Find a tool that has models left to try
      const startingRunner = this.currentRunnerIndex;
      let foundTool = false;
      
      do {
        this.switchToNextRunner();
        
        // Check if this tool has more models to try
        if (!checkToolExhausted(this.runner.name)) {
          // Start with current model on the new tool (don't skip index 0)
          this.modelsTriedThisToolRound = 1;
          this.modelFailuresInCycle = 0;
          foundTool = true;
          break;
        } else {
          exhaustedTools.add(this.runner.name);
        }
      } while (this.currentRunnerIndex !== startingRunner && exhaustedTools.size < this.runners.length);
      
      if (foundTool) {
        return true;
      }
      
      // All tools exhausted - check bail-out before starting fresh round
      if (exhaustedTools.size >= this.runners.length) {
        if (checkBailOut()) {
          return false;  // Bail out - don't reset
        }
        
        console.log(chalk.yellow('\n  All tools exhausted their models, starting fresh round...'));
        for (const runner of this.runners) {
          this.modelIndices.set(runner.name, 0);
          this.stateManager.setModelIndex(runner.name, 0);
        }
        this.modelsTriedThisToolRound = 0;
        return true;  // Will retry with first model on current tool
      }
      
      return false;
    }
    
    // Try next model within current tool (uses recommendations first if available)
    if (this.advanceModel()) {
      this.modelFailuresInCycle = 0;
      return true;
    }
    
    // Current tool exhausted its models, try switching to another tool
    if (this.runners.length > 1) {
      const startingRunner = this.currentRunnerIndex;
      
      do {
        this.switchToNextRunner();
        
        if (!checkToolExhausted(this.runner.name)) {
          // Start with current model on the new tool (don't skip index 0)
          this.modelsTriedThisToolRound = 1;
          this.modelFailuresInCycle = 0;
          return true;
        }
      } while (this.currentRunnerIndex !== startingRunner);
      
      // All tools exhausted - check bail-out before starting fresh round
      if (checkBailOut()) {
        return false;  // Bail out - don't reset
      }
      
      console.log(chalk.yellow('\n  All tools exhausted their models, starting fresh round...'));
      for (const runner of this.runners) {
        this.modelIndices.set(runner.name, 0);
        this.stateManager.setModelIndex(runner.name, 0);
      }
      this.modelsTriedThisToolRound = 0;
      return true;
    }
    
    // Only one tool and it's exhausted - check bail-out before reset
    const models = this.getModelsForRunner(this.runner);
    if (models.length > 0) {
      if (checkBailOut()) {
        return false;  // Bail out - don't reset
      }
      
      console.log(chalk.yellow('\n  Tool exhausted, restarting model rotation...'));
      this.modelIndices.set(this.runner.name, 0);
      this.stateManager.setModelIndex(this.runner.name, 0);
      this.modelsTriedThisToolRound = 0;
      return true;
    }
    
    return false;
  }

  /**
   * Execute graceful bail-out when stalemate detected.
   * 
   * WHY bail-out exists: Prevents infinite loops when:
   * - Agents disagree (fixer says fixed, verifier says not)
   * - Issues are genuinely beyond automation capability
   * - Conflicting requirements in review comments
   * 
   * WHAT happens:
   * 1. Record the bail-out with details for human follow-up
   * 2. Commit/push whatever WAS successfully fixed
   * 3. Print clear summary of what remains
   * 4. Exit the fix loop (caller handles commit/push)
   */
  private async executeBailOut(
    unresolvedIssues: UnresolvedIssue[],
    comments: ReviewComment[],
  ): Promise<void> {
    this.bailedOut = true;
    this.exitReason = 'bail_out';
    this.exitDetails = `Stalemate after ${this.stateManager.getNoProgressCycles()} cycles with no progress - ${unresolvedIssues.length} issue(s) remain`;
    
    // Store final state for after action report
    this.finalUnresolvedIssues = [...unresolvedIssues];
    this.finalComments = [...comments];
    
    const cyclesCompleted = this.stateManager.getNoProgressCycles();
    const toolsExhausted = this.runners.map(r => r.name);
    
    // Count what was fixed vs what remains
    const issuesFixed = comments.filter(c => 
      this.stateManager.isCommentVerifiedFixed(c.id)
    ).length;
    
    // Build remaining issues summary
    const remainingIssues = unresolvedIssues.map(issue => ({
      commentId: issue.comment.id,
      filePath: issue.comment.path,
      line: issue.comment.line,
      summary: issue.comment.body.split('\n')[0].substring(0, 100),
    }));
    
    // Record bail-out in state
    this.stateManager.recordBailOut(
      'no-progress-cycles',
      cyclesCompleted,
      remainingIssues,
      issuesFixed,
      toolsExhausted
    );
    
    await this.stateManager.save();
    
    // Print bail-out summary
    console.log(chalk.red('\n' + '═'.repeat(60)));
    console.log(chalk.red.bold('  BAIL-OUT: Stalemate Detected'));
    console.log(chalk.red('═'.repeat(60)));
    
    console.log(chalk.yellow(`\n  Reason: ${cyclesCompleted} complete cycle(s) with zero verified fixes`));
    console.log(chalk.gray(`  Max allowed: ${this.options.maxStaleCycles} (--max-stale-cycles)`));
    
    console.log(chalk.cyan('\n  Progress Summary:'));
    console.log(chalk.green(`    ✓ Fixed: ${issuesFixed} issues`));
    console.log(chalk.red(`    ✗ Remaining: ${unresolvedIssues.length} issues`));
    const totalLessons = this.lessonsManager.getTotalCount();
    const newLessons = this.lessonsManager.getNewLessonsCount();
    const lessonInfo = newLessons > 0 
      ? `${totalLessons} total (${newLessons} new this run)` 
      : `${totalLessons} (from previous runs)`;
    console.log(chalk.gray(`    📚 Lessons: ${lessonInfo}`));
    
    console.log(chalk.cyan('\n  Tools Exhausted:'));
    for (const tool of toolsExhausted) {
      const models = this.getModelsForRunner(this.runners.find(r => r.name === tool)!);
      console.log(chalk.gray(`    • ${tool}: ${models.length} models tried`));
    }
    
    if (unresolvedIssues.length > 0) {
      console.log(chalk.cyan('\n  Remaining Issues (need human attention):'));
      for (const issue of unresolvedIssues.slice(0, 5)) {
        console.log(chalk.yellow(`    • ${issue.comment.path}:${issue.comment.line || '?'}`));
        console.log(chalk.gray(`      "${issue.comment.body.split('\n')[0].substring(0, 60)}..."`));
      }
      if (unresolvedIssues.length > 5) {
        console.log(chalk.gray(`    ... and ${unresolvedIssues.length - 5} more`));
      }
    }
    
    console.log(chalk.red('\n' + '═'.repeat(60)));
    console.log(chalk.gray('\n  Next steps:'));
    console.log(chalk.gray('    1. Review the lessons learned in .pr-resolver-state.json'));
    console.log(chalk.gray('    2. Check if remaining issues have conflicting requirements'));
    console.log(chalk.gray('    3. Consider increasing --max-stale-cycles if issues seem solvable'));
    console.log(chalk.gray('    4. Manually fix remaining issues or dismiss with comments'));
    console.log('');
  }

  private async trySingleIssueFix(
    issues: UnresolvedIssue[], 
    git: SimpleGit,
    verifiedThisSession?: Set<string>
  ): Promise<boolean> {
    // Focus on one issue at a time to reduce context and improve success rate
    // Randomize which issues to try to avoid hammering the same hard issue
    const shuffled = [...issues].sort(() => Math.random() - 0.5);
    const toTry = shuffled.slice(0, Math.min(issues.length, 3));
    
    console.log(chalk.cyan(`\n  Focusing on ${toTry.length} random issues one at a time...`));
    
    let anyFixed = false;
    
    for (let i = 0; i < toTry.length; i++) {
      const issue = toTry[i];
      console.log(chalk.cyan(`\n  [${i + 1}/${toTry.length}] Focusing on: ${issue.comment.path}:${issue.comment.line || '?'}`));
      console.log(chalk.gray(`    "${issue.comment.body.split('\n')[0].substring(0, 60)}..."`));
      
      // Build a focused prompt for just this one issue
      const focusedPrompt = this.buildSingleIssuePrompt(issue);
      
      // Run with current runner
      const result = await this.runner.run(this.workdir, focusedPrompt, { model: this.getCurrentModel() });
      
      if (result.success) {
        // Check if this specific file changed
        const changedFiles = await getChangedFiles(git);
        
        if (changedFiles.includes(issue.comment.path)) {
          // Verify this single fix
          setTokenPhase('Verify single fix');
          const diff = await getDiffForFile(git, issue.comment.path);
          const verification = await this.llm.verifyFix(
            issue.comment.body,
            issue.comment.path,
            diff
          );

          if (verification.fixed) {
            console.log(chalk.green(`    ✓ Fixed and verified!`));
            debug('Fix verified successfully', {
              file: issue.comment.path,
              line: issue.comment.line,
              diffLength: diff.length,
            });
            this.stateManager.markCommentVerifiedFixed(issue.comment.id);
            verifiedThisSession?.add(issue.comment.id);  // Track for session filtering
            anyFixed = true;
          } else {
            console.log(chalk.yellow(`    ○ Changed but not verified: ${verification.explanation}`));
            debug('Fix rejected by verification', {
              file: issue.comment.path,
              line: issue.comment.line,
              explanation: verification.explanation,
              diff: diff.substring(0, 500),
              issueComment: issue.comment.body.substring(0, 200),
            });

            // Analyze the failure to generate an actionable lesson
            // WHY: "rejected: [reason]" isn't helpful; we need specific guidance
            setTokenPhase('Analyze failure');
            const lesson = await this.llm.analyzeFailedFix(
              {
                comment: issue.comment.body,
                filePath: issue.comment.path,
                line: issue.comment.line,
              },
              diff,
              verification.explanation
            );
            console.log(chalk.gray(`    📝 Lesson: ${lesson}`));
            this.lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - ${lesson}`);

            // Reset ONLY this issue's file, not all changed files
            // WHY: Other issues in this batch may have been successfully fixed
            // and we don't want to lose those changes
            await git.checkout([issue.comment.path]);
          }
        } else if (changedFiles.length > 0) {
          // Tool made changes but to different files - might still be relevant
          console.log(chalk.yellow(`    ○ Changed other files instead: ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? ` (+${changedFiles.length - 3} more)` : ''}`));
          debug('Fixer modified wrong files', {
            expectedFile: issue.comment.path,
            actualFiles: changedFiles,
            issueComment: issue.comment.body.substring(0, 200),
            toolOutput: result.output?.substring(0, 500),
          });
          // Add lesson so tool knows to focus on the right file
          this.lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - tool modified wrong files (${changedFiles.join(', ')}), need to modify ${issue.comment.path}`);
          // Reset wrong files but keep any changes to the target file
          // WHY: The target file might have partial progress worth keeping
          const wrongFiles = changedFiles.filter(f => f !== issue.comment.path);
          if (wrongFiles.length > 0) {
            await git.checkout(wrongFiles);
          }
        } else {
          // Tool ran but made no changes at all
          // Parse fixer output for NO_CHANGES explanation
          const noChangesExplanation = this.parseNoChangesExplanation(result.output || '');

          if (noChangesExplanation) {
            console.log(chalk.gray(`    - No changes made`));
            console.log(chalk.cyan(`      Fixer's reason: ${noChangesExplanation}`));
            this.lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - ${noChangesExplanation}`);

            // If fixer says it's already fixed, dismiss this issue
            const lowerExplanation = noChangesExplanation.toLowerCase();
            const isAlreadyFixed = lowerExplanation.includes('already') ||
                                   lowerExplanation.includes('exists') ||
                                   lowerExplanation.includes('has') ||
                                   lowerExplanation.includes('implements');

            if (isAlreadyFixed) {
              this.stateManager.addDismissedIssue(
                issue.comment.id,
                `Fixer tool (single-issue mode) reported: ${noChangesExplanation}`,
                'already-fixed',
                issue.comment.path,
                issue.comment.line,
                issue.comment.body
              );
            }
          } else {
            // No explanation provided - this is a problem but not fatal
            console.log(chalk.yellow(`    - No changes made (fixer didn't explain why)`));
            console.log(chalk.gray(`      Tip: Will rotate to different model/tool on next attempt`));
            this.lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - tool made no changes without explanation, trying different approach`);
            
            // Only show debug details in verbose mode, and sanitize output
            debug('Fixer made no changes', {
              targetFile: issue.comment.path,
              targetLine: issue.comment.line,
              promptLength: focusedPrompt.length,
              toolOutput: this.sanitizeOutputForLog(result.output, 300),
            });
          }
        }
      } else {
        console.log(chalk.red(`    ✗ Failed: ${result.error}`));
        debug('Fixer tool failed', {
          file: issue.comment.path,
          line: issue.comment.line,
          error: result.error,
          output: result.output?.substring(0, 500),
        });
      }
      
      await this.stateManager.save();
      await this.lessonsManager.save();
    }
    
    return anyFixed;
  }

  private buildSingleIssuePrompt(issue: UnresolvedIssue): string {
    // Get file-scoped lessons (automatically includes global + this file's lessons)
    const lessons = this.lessonsManager.getLessonsForFiles([issue.comment.path])
      .slice(-5); // Last 5 relevant lessons
    
    let prompt = `# SINGLE ISSUE FIX

Focus on fixing ONLY this one issue. Make minimal, targeted changes.

## Issue
File: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}

Review Comment:
${issue.comment.body}

`;

    if (issue.codeSnippet) {
      prompt += `Current Code:
\`\`\`
${issue.codeSnippet}
\`\`\`

`;
    }

    if (lessons.length > 0) {
      prompt += `## Previous Failed Attempts (DO NOT REPEAT)
${lessons.map(l => `- ${l}`).join('\n')}

`;
    }

    prompt += `## Instructions
1. EDIT the file ${issue.comment.path} to fix this issue
2. Make the minimal change required - do NOT rewrite the whole file
3. Do not modify any other files
4. You MUST make a change - if unsure, make your best attempt

IMPORTANT: Actually edit the file. Do not just explain what to do.`;

    return prompt;
  }

  private async tryDirectLLMFix(
    issues: UnresolvedIssue[],
    git: SimpleGit,
    verifiedThisSession?: Set<string>
  ): Promise<boolean> {
    console.log(chalk.cyan(`\n  🧠 Attempting direct ${this.config.llmProvider} API fix...`));
    setTokenPhase('Direct LLM fix');
    
    let anyFixed = false;
    const fs = await import('fs');
    
    for (const issue of issues) {
      const filePath = join(this.workdir, issue.comment.path);
      
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        
        const prompt = `Fix this code review issue:

FILE: ${issue.comment.path}
ISSUE: ${issue.comment.body}

CURRENT CODE:
\`\`\`
${issue.codeSnippet}
\`\`\`

FULL FILE:
\`\`\`
${fileContent}
\`\`\`

Provide the COMPLETE fixed file content. Output ONLY the code, no explanations.
Start your response with \`\`\` and end with \`\`\`.`;

        const response = await this.llm.complete(prompt);
        
        // Extract code from response
        const codeMatch = response.content.match(/```[\w]*\n?([\s\S]*?)```/);
        if (codeMatch) {
          const fixedCode = codeMatch[1].trim();
          const fileContentTrimmed = fileContent.trimEnd();
          if (fixedCode !== fileContentTrimmed) {
            // Preserve trailing newline if original file had one
            const hasTrailingNewline = fileContent.endsWith('\n');
            fs.writeFileSync(filePath, fixedCode + (hasTrailingNewline ? '\n' : ''), 'utf-8');
            console.log(chalk.green(`    ✓ Written: ${issue.comment.path}`));

            // Verify the fix before counting it as successful
            // WHY: Direct LLM writes code but we need to verify it addresses the issue
            // Without this, the fix could be wrong and get undone by next fixer iteration
            setTokenPhase('Verify single fix');
            const diff = await getDiffForFile(git, issue.comment.path);
            const verification = await this.llm.verifyFix(
              issue.comment.body,
              issue.comment.path,
              diff
            );

            if (verification.fixed) {
              console.log(chalk.green(`    ✓ Verified: ${issue.comment.path}`));
              this.stateManager.markCommentVerifiedFixed(issue.comment.id);
              verifiedThisSession?.add(issue.comment.id);
              anyFixed = true;
            } else {
              console.log(chalk.yellow(`    ○ Not verified: ${verification.explanation}`));
              // Reset the file - the fix wasn't correct
              await git.checkout([issue.comment.path]);
            }
          } else {
            // LLM returned the same code - no changes needed
            console.log(chalk.gray(`    - No changes needed for ${issue.comment.path}`));
            console.log(chalk.cyan(`      Direct LLM indicated file is already correct`));
            // Document this dismissal
            this.stateManager.addDismissedIssue(
              issue.comment.id,
              `Direct LLM API returned unchanged code, indicating the issue is already addressed or not applicable`,
              'already-fixed',
              issue.comment.path,
              issue.comment.line,
              issue.comment.body
            );
          }
        }
      } catch (e) {
        console.log(chalk.gray(`    - Skipped ${issue.comment.path}: ${e}`));
      }
    }
    
    return anyFixed;
  }

  async gracefulShutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    
    console.log(chalk.yellow('\n\n⚠ Interrupted! Saving state...'));
    
    if (this.stateManager) {
      try {
        await this.stateManager.markInterrupted();
        console.log(chalk.green('✓ State saved. Run again to resume.'));
        
        // Print timing summary even on interrupt
        endTimer('Total');
        printTimingSummary();
        printTokenSummary();
        this.printModelPerformance();
        this.printFinalSummary();
      } catch (e) {
        console.log(chalk.red('✗ Failed to save state:', e));
      }
    }
  }

  isRunning(): boolean {
    return !this.isShuttingDown;
  }

  async run(prUrl: string): Promise<void> {
    const spinner = ora();
    
    // Enable verbose logging if requested
    setVerbose(this.options.verbose);

    try {
      debugStep('INITIALIZATION');
      resetTimings();
      resetTokenUsage();
      startTimer('Total');
      
      // Parse PR URL
      debug('Parsing PR URL', prUrl);
      const { owner, repo, number } = parsePRUrl(prUrl);
      debug('Parsed PR info', { owner, repo, number });
      
      console.log(chalk.blue(`\nProcessing PR: ${owner}/${repo}#${number}\n`));
      
      // Show mode warnings
      if (this.options.noCommit) {
        warn('NO-COMMIT MODE: Changes will be made but not committed');
      }
      if (this.options.noPush && !this.options.noCommit) {
        info('NO-PUSH MODE: Changes will be committed locally but not pushed');
      }
      if (this.options.dryRun) {
        info('DRY-RUN MODE: No changes will be made');
      }

      // Get PR info
      debugStep('FETCHING PR INFO');
      startTimer('Fetch PR info');
      spinner.start('Fetching PR information...');
      this.prInfo = await this.github.getPRInfo(owner, repo, number);
      spinner.succeed(`PR branch: ${this.prInfo.branch}`);
      debug('PR info', this.prInfo);
      endTimer('Fetch PR info');

      // Check PR status (are bots still running?)
      debugStep('CHECKING PR STATUS');
      spinner.start('Checking CI/bot status...');
      const prStatus = await this.github.getPRStatus(owner, repo, number, this.prInfo.headSha);
      spinner.stop();
      
      // CI checks status
      if (prStatus.inProgressChecks.length > 0) {
        warn(`CI: ${prStatus.inProgressChecks.length} checks running: ${prStatus.inProgressChecks.join(', ')}`);
      } else if (prStatus.pendingChecks.length > 0) {
        warn(`CI: ${prStatus.pendingChecks.length} checks queued: ${prStatus.pendingChecks.join(', ')}`);
      } else {
        console.log(chalk.green('✓'), `CI: ${prStatus.completedChecks}/${prStatus.totalChecks} checks completed (${prStatus.ciState})`);
      }

      // Bot review status
      if (prStatus.activelyReviewingBots.length > 0) {
        warn(`Bots reviewing: ${prStatus.activelyReviewingBots.join(', ')}`);
        info('These bots may still be analyzing - consider waiting for them to finish.');
      }
      
      // Bots with 👀 reaction (looking at it)
      if (prStatus.botsWithEyesReaction.length > 0) {
        warn(`Bots looking (👀): ${prStatus.botsWithEyesReaction.join(', ')}`);
      }
      
      // Pending reviewers
      if (prStatus.pendingReviewers.length > 0) {
        info(`Pending reviewers: ${prStatus.pendingReviewers.join(', ')}`);
      }

      // Overall status
      const hasActivity = prStatus.inProgressChecks.length > 0 || 
                          prStatus.pendingChecks.length > 0 || 
                          prStatus.activelyReviewingBots.length > 0 ||
                          prStatus.botsWithEyesReaction.length > 0;
      if (!hasActivity) {
        console.log(chalk.green('✓'), 'PR is idle - safe to proceed');
      }

      // Analyze bot response timing
      // WHY: Helps user understand how long to wait for bot reviews after pushing
      // Also stored for smart wait scheduling after pushes
      debugStep('ANALYZING BOT TIMING');
      let lastCommitTime: Date | null = null;
      try {
        spinner.start('Analyzing bot response timing...');
        
        // Get commits to find last commit time
        const commits = await this.github.getPRCommits(owner, repo, number);
        if (commits.length > 0) {
          lastCommitTime = commits[commits.length - 1].committedDate;
        }
        
        this.botTimings = await this.github.analyzeBotResponseTiming(owner, repo, number);
        spinner.stop();
        
        if (this.botTimings.length > 0) {
          console.log(chalk.cyan('\n📊 Bot Response Timing (observed on this PR):'));
          for (const timing of this.botTimings) {
            console.log(chalk.gray(
              `   ${timing.botName}: ${formatDuration(timing.minResponseMs)} / ${formatDuration(timing.avgResponseMs)} / ${formatDuration(timing.maxResponseMs)} (min/avg/max, n=${timing.responseCount})`
            ));
          }
          // Recommend wait time based on max observed
          const maxWait = Math.max(...this.botTimings.map(t => t.maxResponseMs));
          const recommendedWait = Math.ceil(maxWait / 1000 / 30) * 30; // Round up to nearest 30s
          console.log(chalk.gray(`   Recommended wait after push: ~${recommendedWait}s`));
          
          // Calculate when we expect bot reviews to arrive
          if (lastCommitTime) {
            this.expectedBotResponseTime = this.calculateExpectedBotResponseTime(lastCommitTime);
            if (this.expectedBotResponseTime) {
              const now = new Date();
              const msUntilExpected = this.expectedBotResponseTime.getTime() - now.getTime();
              if (msUntilExpected > 0) {
                console.log(chalk.cyan(`   📅 Expecting new bot reviews in ~${formatDuration(msUntilExpected)}`));
                console.log(chalk.gray('      Will check for new issues while working...'));
              } else {
                console.log(chalk.cyan('   📅 Bot reviews may already be available'));
              }
            }
          }
        } else {
          console.log(chalk.gray('No bot response timing data available yet'));
        }
      } catch (err) {
        debug('Bot timing analysis failed (non-critical)', { error: err });
      }

      // Check CodeRabbit status on startup
      // WHY: If CodeRabbit is in manual mode and hasn't reviewed the current commit,
      // we should trigger it early so reviews are ready when we need them
      debugStep('CHECKING CODERABBIT STATUS');
      try {
        spinner.start('Checking CodeRabbit status...');
        const crResult = await this.github.triggerCodeRabbitIfNeeded(
          owner, repo, number, this.prInfo.branch, this.prInfo.headSha
        );
        
        if (crResult.mode === 'none') {
          spinner.info('CodeRabbit: not configured for this repo');
        } else if (crResult.reviewedCurrentCommit) {
          spinner.succeed(`CodeRabbit: already reviewed ${this.prInfo.headSha.substring(0, 7)} ✓`);
        } else if (crResult.triggered) {
          spinner.succeed(`CodeRabbit: triggered review (${crResult.mode} mode)`);
          info('CodeRabbit review requested - it will analyze while we work');
        } else if (crResult.mode === 'auto') {
          spinner.info(`CodeRabbit: auto mode - will review automatically`);
        } else {
          spinner.info(`CodeRabbit: ${crResult.reason}`);
        }
        debug('CodeRabbit startup check', crResult);
      } catch (err) {
        spinner.warn('Could not check CodeRabbit status (continuing anyway)');
        debug('CodeRabbit startup check failed', { error: err });
      }

      // Setup workdir (includes branch in hash for repos with PRs on different target branches)
      debugStep('SETTING UP WORKDIR');
      const workdirInfo = getWorkdirInfo(this.config.workdirBase, owner, repo, number, this.prInfo.branch);
      this.workdir = workdirInfo.path;
      debug('Workdir info', workdirInfo);
      
      if (workdirInfo.exists) {
        console.log(chalk.gray(`Reusing existing workdir: ${this.workdir}`));
        console.log(chalk.gray(`  → ${workdirInfo.identifier}`));
      } else {
        console.log(chalk.gray(`Creating workdir: ${this.workdir}`));
        console.log(chalk.gray(`  → ${workdirInfo.identifier}`));
      }

      await ensureWorkdir(this.workdir);

      // Initialize state manager
      debugStep('LOADING STATE');
      this.stateManager = new StateManager(this.workdir);
      this.stateManager.setPhase('init');
      const state = await this.stateManager.load(
        `${owner}/${repo}#${number}`, 
        this.prInfo.branch,
        this.prInfo.headSha
      );
      debug('Loaded state', {
        iterations: state.iterations.length,
        verifiedFixed: state.verifiedFixed.length,
      });

      // Initialize lessons manager (branch-permanent storage)
      // WHY: Lessons help the fixer avoid repeating mistakes
      this.lessonsManager = new LessonsManager(owner, repo, this.prInfo.branch);
      this.lessonsManager.setWorkdir(this.workdir); // Enable repo-based lesson sharing
      await this.lessonsManager.load();
      const lessonCounts = this.lessonsManager.getCounts();
      debug('Loaded lessons', lessonCounts);

      // Setup runner
      debugStep('SETTING UP RUNNER');
      this.runner = await this.setupRunner();
      debug('Using runner', this.runner.name);
      
      // Restore tool/model rotation state from previous session
      // WHY: Resume where we left off if interrupted, don't restart from first model
      const savedRunnerIndex = this.stateManager.getCurrentRunnerIndex();
      const savedModelIndices = this.stateManager.getModelIndices();
      
      if (savedRunnerIndex > 0 && savedRunnerIndex < this.runners.length) {
        this.currentRunnerIndex = savedRunnerIndex;
        this.runner = this.runners[savedRunnerIndex];
        console.log(chalk.gray(`  Resuming at tool: ${this.runner.displayName} (from previous session)`));
      }
      
      if (Object.keys(savedModelIndices).length > 0) {
        for (const [runnerName, index] of Object.entries(savedModelIndices)) {
          this.modelIndices.set(runnerName, index);
        }
        const currentModel = this.getCurrentModel();
        if (currentModel) {
          console.log(chalk.gray(`  Resuming at model: ${currentModel} (from previous session)`));
        }
      }

      // Clone or update repo
      // If we have verified fixes from a previous run, preserve local changes
      const hasVerifiedFixes = state.verifiedFixed.length > 0;
      debugStep('CLONING/UPDATING REPOSITORY');
      spinner.start('Setting up repository...');
      const { git } = await cloneOrUpdate(
        this.prInfo.cloneUrl,
        this.prInfo.branch,
        this.workdir,
        this.config.githubToken,
        { preserveChanges: hasVerifiedFixes }
      );
      spinner.succeed('Repository ready');
      debug('Repository cloned/updated at', this.workdir);

      // Recover verification state from git history (Phase 2)
      // WHY: Git commits are durable. Recover which fixes were already verified.
      debugStep('RECOVERING STATE FROM GIT');
      const committedFixes = await scanCommittedFixes(git, this.prInfo.branch);
      if (committedFixes.length > 0) {
        console.log(chalk.cyan(`Recovered ${formatNumber(committedFixes.length)} previously committed fix(es) from git history`));
        for (const commentId of committedFixes) {
          this.stateManager.markCommentVerifiedFixed(commentId);
        }
        await this.stateManager.save();
        debug('Recovered verifications from git', { count: committedFixes.length });
      }

      // Check for conflicts and sync with remote
      // WHY CHECK EARLY: Conflict markers in files will cause fixer tools to fail confusingly.
      // Better to detect and resolve conflicts upfront before entering the fix loop.
      // 
      // SCENARIOS HANDLED:
      // 1. Previous interrupted merge/rebase left conflict markers in files
      // 2. User manually started a merge but didn't complete it
      // 3. Previous prr run was interrupted mid-conflict-resolution
      debugStep('CHECKING FOR CONFLICTS');
      spinner.start('Checking for conflicts with remote...');
      const conflictStatus = await checkForConflicts(git, this.prInfo.branch);
      spinner.stop();

      if (conflictStatus.hasConflicts) {
        // WHY AUTO-RESOLVE: Previously, prr would bail out here with "resolve manually".
        // This was frustrating because the same LLM tools that fix review comments can
        // also resolve merge conflicts. Auto-resolution keeps the workflow seamless.
        console.log(chalk.yellow('⚠ Merge conflicts detected from previous operation'));
        console.log(chalk.cyan('  Attempting to resolve conflicts automatically...'));
        
        startTimer('Resolve remote conflicts');
        const resolution = await this.resolveConflictsWithLLM(
          git,
          conflictStatus.conflictedFiles,
          `origin/${this.prInfo.branch}`
        );
        
        if (!resolution.success) {
          console.log(chalk.red('\n✗ Could not resolve all merge conflicts automatically'));
          console.log(chalk.red('  Remaining conflicts:'));
          for (const file of resolution.remainingConflicts) {
            console.log(chalk.red(`    - ${file}`));
          }
          console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
          await abortMerge(git);
          endTimer('Resolve remote conflicts');
          return;
        }
        
        // All conflicts resolved - complete the merge
        const commitResult = await completeMerge(git, `Merge remote-tracking branch 'origin/${this.prInfo.branch}'`);
        
        if (!commitResult.success) {
          console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
          await abortMerge(git);
          endTimer('Resolve remote conflicts');
          return;
        }
        
        console.log(chalk.green('✓ Conflicts resolved and merge completed'));
        endTimer('Resolve remote conflicts');
      }

      if (conflictStatus.behindBy > 0) {
        console.log(chalk.yellow(`⚠ Branch is ${conflictStatus.behindBy} commits behind remote`));
        spinner.start('Pulling latest changes...');
        const pullResult = await pullLatest(git, this.prInfo.branch);
        
        if (!pullResult.success) {
          spinner.fail('Failed to pull');
          console.log(chalk.red(`  Error: ${pullResult.error}`));
          
          if (pullResult.error?.includes('conflict')) {
            // Get conflicted files from git status
            const status = await git.status();
            const conflictedFiles = status.conflicted || [];
            
            if (conflictedFiles.length > 0) {
              console.log(chalk.cyan('  Attempting to resolve pull conflicts automatically...'));
              
              startTimer('Resolve pull conflicts');
              const resolution = await this.resolveConflictsWithLLM(
                git,
                conflictedFiles,
                `origin/${this.prInfo.branch}`
              );
              
              if (!resolution.success) {
                console.log(chalk.red('\n✗ Could not resolve pull conflicts automatically'));
                console.log(chalk.red('  Remaining conflicts:'));
                for (const file of resolution.remainingConflicts) {
                  console.log(chalk.red(`    - ${file}`));
                }
                console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
                await abortMerge(git);
                endTimer('Resolve pull conflicts');
                return;
              }
              
              // All conflicts resolved - complete the merge/rebase
              const commitResult = await completeMerge(git, `Merge remote-tracking branch 'origin/${this.prInfo.branch}'`);
              
              if (!commitResult.success) {
                console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
                await abortMerge(git);
                endTimer('Resolve pull conflicts');
                return;
              }
              
              console.log(chalk.green('✓ Pull conflicts resolved and merge completed'));
              endTimer('Resolve pull conflicts');
            } else {
              console.log(chalk.yellow('  Please resolve conflicts manually before running prr.'));
              await abortMerge(git);
              return;
            }
          } else {
            return;
          }
        }
        
        if (pullResult.stashConflicts && pullResult.stashConflicts.length > 0) {
          spinner.warn('Pulled with stash conflicts');
          console.log(chalk.cyan(`  Stash conflicts in: ${pullResult.stashConflicts.join(', ')}`));
          console.log(chalk.cyan('  Attempting to resolve stash conflicts automatically...'));
          
          startTimer('Resolve stash conflicts');
          const resolution = await this.resolveConflictsWithLLM(
            git,
            pullResult.stashConflicts,
            'stashed changes'
          );
          
          if (!resolution.success) {
            console.log(chalk.red('\n✗ Could not resolve stash conflicts automatically'));
            console.log(chalk.red('  Remaining conflicts:'));
            for (const file of resolution.remainingConflicts) {
              console.log(chalk.red(`    - ${file}`));
            }
            console.log(chalk.yellow('\n  Resolve conflicts and commit, then re-run prr.'));
            endTimer('Resolve stash conflicts');
            return;
          }
          
          // Stage and commit the resolved stash conflicts
          await git.add('.');
          await git.commit('Resolve stash conflicts after pull');
          console.log(chalk.green('✓ Stash conflicts resolved'));
          endTimer('Resolve stash conflicts');
        }
        
        spinner.succeed('Pulled latest changes');
      } else {
        console.log(chalk.green('✓ Branch is up to date with remote'));
      }

      if (conflictStatus.aheadBy > 0) {
        info(`Branch is ${conflictStatus.aheadBy} commits ahead of remote`);
      }

      // Check if PR has merge conflicts with base branch
      debugStep('CHECKING PR MERGE STATUS');
      if (this.prInfo.mergeable === false || this.prInfo.mergeableState === 'dirty') {
        console.log(chalk.yellow(`⚠ PR has conflicts with ${this.prInfo.baseBranch}`));
        
        // Only merge base branch if explicitly requested (--merge-base flag)
        // WHY opt-in: Auto-merging main/master can introduce unexpected changes
        // and some teams prefer rebase or manual conflict resolution
        if (this.options.mergeBase) {
          startTimer('Resolve conflicts');
          console.log(chalk.cyan(`  Attempting to merge origin/${this.prInfo.baseBranch} into ${this.prInfo.branch}...`));
          
          const mergeResult = await mergeBaseBranch(git, this.prInfo.baseBranch);
          
          if (!mergeResult.success) {
            // Merge failed - use LLM tool to resolve conflicts
            console.log(chalk.yellow('  Auto-merge failed, resolving conflicts...'));
            
            // Start the merge to get conflict markers in files
            const { conflictedFiles, error } = await startMergeForConflictResolution(
              git,
              this.prInfo.baseBranch,
              `Merge branch '${this.prInfo.baseBranch}' into ${this.prInfo.branch}`
            );
            
            if (error && conflictedFiles.length === 0) {
              console.log(chalk.red(`✗ Failed to start merge: ${error}`));
              return;
            }
            
            if (conflictedFiles.length === 0) {
              console.log(chalk.yellow('  No conflicts detected after merge attempt'));
            } else {
              // Use the shared conflict resolution method
              const resolution = await this.resolveConflictsWithLLM(
                git,
                conflictedFiles,
                this.prInfo.baseBranch
              );
              
              if (!resolution.success) {
                console.log(chalk.yellow('\n⚠ Could not resolve all merge conflicts automatically'));
                console.log(chalk.yellow('  Remaining conflicts:'));
                for (const file of resolution.remainingConflicts) {
                  console.log(chalk.yellow(`    - ${file}`));
                }
                console.log(chalk.cyan('\n  Aborting merge and resetting to PR branch...'));
                
                // Abort merge and reset to clean state on PR branch
                await abortMerge(git);
                await git.reset(['--hard', `origin/${this.prInfo.branch}`]);
                await git.clean('f', ['-d']);
                
                endTimer('Resolve conflicts');
                console.log(chalk.green(`  ✓ Reset to ${this.prInfo.branch} - ready to fix review comments`));
                console.log(chalk.gray('  (PR still has conflicts with base branch - human can resolve later)'));
                
                // Continue to fix review comments instead of returning
              } else {
                // All conflicts resolved - stage files and complete the merge
                const codeFiles = conflictedFiles.filter(f => !isLockFile(f));
                await markConflictsResolved(git, codeFiles);
                const commitResult = await completeMerge(git, `Merge branch '${this.prInfo.baseBranch}' into ${this.prInfo.branch}`);
                
                if (!commitResult.success) {
                  console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
                  return;
                }
                
                console.log(chalk.green(`✓ Conflicts resolved and merged ${this.prInfo.baseBranch}`));
              }
            }
          } else {
            console.log(chalk.green(`✓ Successfully merged ${this.prInfo.baseBranch} into ${this.prInfo.branch}`));
          }
          
          // Push the merge if auto-push enabled
          if (!this.options.noPush && !this.options.noCommit) {
            spinner.start('Pushing merge commit...');
            await git.push('origin', this.prInfo.branch);
            spinner.succeed('Pushed merge commit');
          } else {
            console.log(chalk.yellow('  Merge commit created locally. Use --push to push it.'));
          }
          endTimer('Resolve conflicts');
        } else {
          // Not merging base - just warn and continue with review comments
          console.log(chalk.gray(`  Skipping base branch merge (use --merge-base to auto-merge ${this.prInfo.baseBranch})`));
          console.log(chalk.gray('  Continuing to fix review comments...'));
        }
      } else if (this.prInfo.mergeable === null) {
        console.log(chalk.gray('  GitHub is still calculating merge status...'));
      } else {
        console.log(chalk.green(`✓ PR is mergeable with ${this.prInfo.baseBranch}`));
      }

      // Main loop
      let pushIteration = 0;
      const maxPushIterations = this.options.autoPush 
        ? (this.options.maxPushIterations || Infinity)  // 0 = unlimited
        : 1;

      while (pushIteration < maxPushIterations) {
        pushIteration++;
        
        if (this.options.autoPush && pushIteration > 1) {
          const iterLabel = maxPushIterations === Infinity ? `${pushIteration}` : `${pushIteration}/${maxPushIterations}`;
          console.log(chalk.blue(`\n--- Push iteration ${iterLabel} ---\n`));
        }

        // Fetch review comments
        debugStep('FETCHING REVIEW COMMENTS');
        startTimer('Fetch comments');
        spinner.start('Fetching review comments...');
        const comments = await this.github.getReviewComments(owner, repo, number);
        const fetchTime = endTimer('Fetch comments');
        spinner.succeed(`Found ${formatNumber(comments.length)} review comments (${formatDuration(fetchTime)})`);
        
        debug('Review comments', comments.map(c => ({
          id: c.id,
          author: c.author,
          path: c.path,
          line: c.line,
          bodyPreview: c.body.substring(0, 100) + (c.body.length > 100 ? '...' : ''),
        })));

        if (comments.length === 0) {
          console.log(chalk.green('\nNo review comments found. Nothing to do!'));
          this.exitReason = 'no_comments';
          this.exitDetails = 'No review comments found on the PR';
          break;
        }

        // Check which issues still exist
        debugStep('ANALYZING ISSUES');
        this.stateManager.setPhase('analyzing');
        setTokenPhase('Analyze issues');
        startTimer('Analyze issues');
        console.log(chalk.gray(`Analyzing ${formatNumber(comments.length)} review comments...`));
        const unresolvedIssues = await this.findUnresolvedIssues(comments, comments.length);
        const analyzeTime = endTimer('Analyze issues');
        
        const resolvedCount = comments.length - unresolvedIssues.length;
        console.log(chalk.green(`✓ ${formatNumber(resolvedCount)}/${formatNumber(comments.length)} already resolved (${formatDuration(analyzeTime)})`));
        if (unresolvedIssues.length > 0) {
          console.log(chalk.yellow(`→ ${formatNumber(unresolvedIssues.length)} issues remaining to fix`));
        }

        // Report dismissed issues (issues that don't need fixing)
        const dismissedIssues = this.stateManager.getDismissedIssues();
        if (dismissedIssues.length > 0) {
          const byCategory = dismissedIssues.reduce((acc, issue) => {
            acc[issue.category] = (acc[issue.category] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);

          console.log(chalk.gray(`\n  Issues dismissed (no fix needed): ${formatNumber(dismissedIssues.length)} total`));
          for (const [category, count] of Object.entries(byCategory)) {
            console.log(chalk.gray(`    • ${category}: ${formatNumber(count)}`));
          }

          // Show details for a few dismissed issues
          if (dismissedIssues.length <= 3) {
            console.log(chalk.gray('\n  Dismissal reasons:'));
            for (const issue of dismissedIssues) {
              console.log(chalk.gray(`    • ${issue.filePath}:${issue.line || '?'} [${issue.category}]`));
              console.log(chalk.gray(`      ${issue.reason}`));
            }
          }
        }

        debug('Unresolved issues', unresolvedIssues.map(i => ({
          id: i.comment.id,
          path: i.comment.path,
          line: i.comment.line,
          explanation: i.explanation,
        })));

        if (unresolvedIssues.length === 0) {
          // Before declaring victory, check for new comments added while we were fixing
          // WHY: Humans or bots may add new review comments during our fix cycle
          debugStep('CHECK FOR NEW COMMENTS');
          spinner.start('Checking for new review comments...');
          
          const freshComments = await this.github.getReviewComments(owner, repo, number);
          const existingIds = new Set(comments.map(c => c.id));
          const newComments = freshComments.filter(c => !existingIds.has(c.id));
          
          if (newComments.length > 0) {
            spinner.warn(`Found ${formatNumber(newComments.length)} new comment(s) added during fix cycle`);
            console.log(chalk.yellow('\n⚠ New review comments found:'));
            for (const comment of newComments) {
              console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'} (by ${comment.author})`));
              console.log(chalk.gray(`    "${comment.body.split('\n')[0].substring(0, 60)}..."`));
            }
            
            // Add new comments to our list and re-enter fix loop
            comments.push(...newComments);
            
            // Check which new comments need fixing
            for (const comment of newComments) {
              const codeSnippet = await this.getCodeSnippet(comment.path, comment.line, comment.body);
              unresolvedIssues.push({
                comment,
                codeSnippet,
                stillExists: true,
                explanation: 'New comment added during fix cycle',
              });
            }
            
            console.log(chalk.cyan(`\n→ Re-entering fix loop with ${formatNumber(unresolvedIssues.length)} new issues\n`));
            // Fall through to fix loop below
          } else {
            spinner.succeed('No new comments');
          }
        }
        
        // Only run final audit if we still have no unresolved issues
        if (unresolvedIssues.length === 0) {
          // Before declaring victory, run a final audit to catch false positives
          debugStep('FINAL AUDIT');
          setTokenPhase('Final audit');
          
          // Clear verification cache so audit results are authoritative
          // This prevents stale "verified fixed" entries from persisting
          this.stateManager.clearVerificationCache();
          debug('Cleared verification cache before final audit');
          
          spinner.start('Running final audit on all issues...');
          
          // Gather all comments with their current code
          const allIssuesForAudit: Array<{
            id: string;
            comment: string;
            filePath: string;
            line: number | null;
            codeSnippet: string;
          }> = [];
          
          for (const comment of comments) {
            const codeSnippet = await this.getCodeSnippet(comment.path, comment.line, comment.body);
            allIssuesForAudit.push({
              id: comment.id,
              comment: comment.body,
              filePath: comment.path,
              line: comment.line,
              codeSnippet,
            });
          }
          
          const auditResults = await this.llm.finalAudit(allIssuesForAudit, this.options.maxContextChars);
          
          // Find issues that failed the audit - mark passing ones as verified
          const failedAudit: Array<{ comment: ReviewComment; explanation: string }> = [];
          for (const comment of comments) {
            const result = auditResults.get(comment.id);
            if (result) {
              if (result.stillExists) {
                failedAudit.push({ comment, explanation: result.explanation });
              } else {
                // Audit confirmed this is fixed - add to cache
                this.stateManager.markCommentVerifiedFixed(comment.id);
              }
            } else {
              // No result from audit - treat as needing review (fail-safe)
              failedAudit.push({ comment, explanation: 'Audit did not return a result for this issue' });
            }
          }
          
          if (failedAudit.length > 0) {
            spinner.fail(`Final audit found ${formatNumber(failedAudit.length)} issue(s) not properly fixed`);
            console.log(chalk.yellow('\n⚠ Issues that need more work:'));
            for (const { comment, explanation } of failedAudit) {
              console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'}`));
              console.log(chalk.gray(`    ${explanation}`));
            }
            await this.stateManager.save();
            
            // Re-populate unresolvedIssues with failed audit items so fix loop can continue
            // WHY: We can't just `continue` - that goes to outer push loop which may exit
            // Instead, we populate unresolvedIssues and fall through to the inner fix loop
            unresolvedIssues.length = 0; // Clear
            for (const { comment, explanation } of failedAudit) {
              const codeSnippet = await this.getCodeSnippet(comment.path, comment.line, comment.body);
              unresolvedIssues.push({
                comment,
                codeSnippet,
                stillExists: true,
                explanation,
              });
            }
            console.log(chalk.cyan(`\n→ Re-entering fix loop with ${formatNumber(unresolvedIssues.length)} issues from audit\n`));
            // Fall through to inner fix loop below (don't break or continue)
          } else {
            // Final audit passed - all issues verified fixed
            spinner.succeed('Final audit passed - all issues verified fixed!');
            console.log(chalk.green('\n✓ All issues have been resolved and verified!'));
            this.exitReason = 'audit_passed';
            this.exitDetails = 'Final audit passed - all issues verified fixed';

            // Report summary of dismissed issues
            const dismissedIssues = this.stateManager.getDismissedIssues();
            if (dismissedIssues.length > 0) {
              console.log(chalk.cyan(`\n📋 Dismissed Issues Summary (${formatNumber(dismissedIssues.length)} total)`));
              console.log(chalk.gray('These issues were determined not to need fixing:\n'));

              const byCategory = dismissedIssues.reduce((acc, issue) => {
                if (!acc[issue.category]) {
                  acc[issue.category] = [];
                }
                acc[issue.category].push(issue);
                return acc;
              }, {} as Record<string, typeof dismissedIssues>);

              for (const [category, issues] of Object.entries(byCategory)) {
                console.log(chalk.cyan(`  ${category.toUpperCase()} (${formatNumber(issues.length)})`));
                for (const issue of issues) {
                  console.log(chalk.gray(`    • ${issue.filePath}:${issue.line || '?'}`));
                  console.log(chalk.gray(`      Reason: ${issue.reason}`));
                  if (issue.commentBody.length <= 80) {
                    console.log(chalk.gray(`      Comment: ${issue.commentBody}`));
                  } else {
                    console.log(chalk.gray(`      Comment: ${issue.commentBody.substring(0, 77)}...`));
                  }
                }
                console.log('');
              }

              console.log(chalk.yellow('💡 Tip: These dismissal reasons can help improve issue generation to reduce false positives.'));
            }

            // Check if we have uncommitted changes that need to be committed
            if (await hasChanges(git)) {
              debugStep('COMMIT PHASE (all resolved)');
              
              // Export lessons to repo BEFORE commit so they're included
              if (this.lessonsManager.hasNewLessonsForRepo()) {
                spinner.start('Exporting lessons to repo...');
                await this.lessonsManager.saveToRepo();
                spinner.succeed('Lessons exported');
              }
              
              if (this.options.noCommit) {
                warn('NO-COMMIT MODE: Skipping commit. Changes are in workdir.');
                console.log(chalk.gray(`Workdir: ${this.workdir}`));
              } else {
                // Get all comments that were fixed for commit message
                const fixedIssues = comments
                  .filter((comment) => this.stateManager.isCommentVerifiedFixed(comment.id))
                  .map((comment) => ({
                    filePath: comment.path,
                    comment: comment.body,
                  }));
                
                spinner.start('Generating commit message...');
                const commitMsg = await this.llm.generateCommitMessage(fixedIssues);
                debug('Generated commit message', commitMsg);
                
                spinner.text = 'Committing changes...';
                const commit = await squashCommit(git, commitMsg);
                spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${formatNumber(commit.filesChanged)} files)`);
                debug('Commit created', commit);
                
                if (this.options.autoPush && !this.options.noPush) {
                  // Log command BEFORE spinner so user can copy it if needed
                  console.log(chalk.gray(`  Running: git push origin ${this.prInfo.branch}`));
                  console.log(chalk.gray(`  Workdir: ${this.workdir}`));
                  spinner.start('Pushing changes...');
                  await pushWithRetry(git, this.prInfo.branch, {
                    onPullNeeded: () => {
                      spinner.text = 'Push rejected, pulling and retrying...';
                    },
                    githubToken: this.config.githubToken,
                    onConflict: async (conflictedFiles) => {
                      // Resolve rebase conflicts using LLM
                      spinner.text = 'Resolving rebase conflicts...';
                      const resolution = await this.resolveConflictsWithLLM(
                        git,
                        conflictedFiles,
                        `origin/${this.prInfo.branch}`
                      );
                      return resolution.success;
                    },
                  });
                  spinner.succeed('Pushed to remote');
                } else if (!this.options.noPush) {
                  console.log(chalk.blue('\nChanges committed locally. Use --auto-push to push automatically.'));
                } else {
                  warn('NO-PUSH MODE: Changes committed locally but not pushed.');
                }
                console.log(chalk.gray(`Workdir: ${this.workdir}`));
              }
            }
            break;
          }
        }

        // Dry run - just show issues
        if (this.options.dryRun) {
          this.printUnresolvedIssues(unresolvedIssues);
          this.exitReason = 'dry_run';
          this.exitDetails = `Dry run mode - showed ${unresolvedIssues.length} issue(s) without fixing`;
          
          // Store final state for after action report
          this.finalUnresolvedIssues = [...unresolvedIssues];
          this.finalComments = [...comments];
          break;
        }

        // Skip fix loop if there are no issues to fix
        // WHY: After final audit passes or all issues are resolved, we shouldn't
        // run the fixer with an empty prompt - it wastes time and may cause errors
        if (unresolvedIssues.length === 0) {
          debug('No unresolved issues - skipping fix loop');
          console.log(chalk.green('\n✓ All issues resolved - nothing to fix'));
          this.exitReason = 'all_resolved';
          this.exitDetails = 'All issues were already resolved before fix loop';
          break;
        }

        // Inner fix loop
        let fixIteration = 0;
        let allFixed = false;
        const maxFixIterations = this.options.maxFixIterations || Infinity;  // 0 = unlimited
        
        // Track which items were verified THIS SESSION (not from previous runs)
        // WHY: findUnresolvedIssues already handles stale verifications correctly.
        // We only need to filter items that got verified DURING this fix loop.
        const verifiedThisSession = new Set<string>();
        
        // Track which fixes have already been committed (Trap 3)
        // WHY: verifiedThisSession accumulates across iterations. Without this,
        // we'd try to commit already-committed fixes on subsequent iterations.
        const alreadyCommitted = new Set<string>();

        // Track existing comment IDs to detect new ones
        const existingCommentIds = new Set(comments.map(c => c.id));
        
        while (fixIteration < maxFixIterations && !allFixed) {
          // Check for new bot reviews if expected time has passed
          // WHY: Work on existing issues while waiting for bot reviews, then pull in new ones
          const newReviewResult = await this.checkForNewBotReviews(owner, repo, number, existingCommentIds);
          if (newReviewResult) {
            console.log(chalk.cyan(`\n📬 ${newReviewResult.message}`));
            
            // Add new comments to tracking
            for (const comment of newReviewResult.newComments) {
              existingCommentIds.add(comment.id);
              comments.push(comment);
              
              console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'} (by ${comment.author})`));
              
              // Analyze if this new comment needs fixing
              const codeSnippet = await this.getCodeSnippet(comment.path, comment.line, comment.body);
              // Quick check - assume new comments need attention unless obviously resolved
              unresolvedIssues.push({
                comment,
                codeSnippet,
                stillExists: true,
                explanation: 'New comment from bot review',
              });
            }
            
            console.log(chalk.cyan(`   Added ${newReviewResult.newComments.length} new issue(s) to workflow\n`));
          }
          
          // Filter out issues that were verified during THIS session (by single-issue mode, etc.)
          // WHY: trySingleIssueFix marks items as verified but 'continue' skips normal filtering
          // IMPORTANT: Don't use isCommentVerifiedFixed here - it would remove stale items
          // that findUnresolvedIssues intentionally kept for re-checking
          if (verifiedThisSession.size > 0) {
            const beforeCount = unresolvedIssues.length;
            const toRemove = unresolvedIssues.filter(i => verifiedThisSession.has(i.comment.id));
            if (toRemove.length > 0) {
              debug('Filtering issues verified this session', {
                before: beforeCount,
                removing: toRemove.map(i => i.comment.id),
              });
              unresolvedIssues.splice(
                0,
                unresolvedIssues.length,
                ...unresolvedIssues.filter(i => !verifiedThisSession.has(i.comment.id))
              );
              debug('After filtering', { remaining: unresolvedIssues.length });
            }
          }
          
          // Check for empty issues at start of each iteration
          // WHY: After verification/filtering, unresolvedIssues can be 0
          if (unresolvedIssues.length === 0) {
            // Sanity check: verify that all comments are actually marked as verified
            const actuallyVerified = comments.filter(c => 
              this.stateManager.isCommentVerifiedFixed(c.id)
            ).length;
            const actuallyUnverified = comments.length - actuallyVerified;
            
            if (actuallyUnverified > 0) {
              // BUG: We think we're done but there are unverified comments!
              console.log(chalk.red(`\n⚠ BUG DETECTED: unresolvedIssues is empty but ${actuallyUnverified} comments are not verified`));
              debug('Mismatch detected', {
                unresolvedIssuesLength: unresolvedIssues.length,
                actuallyVerified,
                actuallyUnverified,
                totalComments: comments.length,
                verifiedIds: comments.filter(c => this.stateManager.isCommentVerifiedFixed(c.id)).map(c => c.id),
              });
              
              // Re-populate unresolvedIssues from scratch
              unresolvedIssues.splice(0, unresolvedIssues.length);
              for (const comment of comments) {
                if (!this.stateManager.isCommentVerifiedFixed(comment.id)) {
                  const codeSnippet = await this.getCodeSnippet(comment.path, comment.line, comment.body);
                  unresolvedIssues.push({
                    comment,
                    codeSnippet,
                    stillExists: true,
                    explanation: 'Re-added after bug detection',
                  });
                }
              }
              debug('Re-populated unresolvedIssues', { count: unresolvedIssues.length });
              
              if (unresolvedIssues.length === 0) {
                // Now it's actually empty (all verified)
                debug('All comments now verified - breaking');
                console.log(chalk.green('\n✓ All issues resolved'));
                this.exitReason = 'all_fixed';
                this.exitDetails = 'All issues fixed and verified';
                break;
              }
              // Continue with the re-populated list
              console.log(chalk.yellow(`→ Continuing with ${unresolvedIssues.length} issues`));
            } else {
              debug('No issues to fix at start of iteration - breaking');
              console.log(chalk.green('\n✓ All issues resolved'));
              this.exitReason = 'all_fixed';
              this.exitDetails = 'All issues fixed and verified';
              break;
            }
          }
          
          fixIteration++;
          const iterLabel = this.options.maxFixIterations ? `${fixIteration}/${maxFixIterations}` : `${fixIteration}`;
          const currentModel = this.getCurrentModel();
          const modelInfo = currentModel ? chalk.gray(` [${this.runner.name}/${currentModel}]`) : chalk.gray(` [${this.runner.name}]`);
          console.log(chalk.blue(`\n--- Fix iteration ${iterLabel}${modelInfo} ---\n`));

          // Start new iteration in state
          this.stateManager.startIteration();

          // Build fix prompt
          debugStep('GENERATING FIX PROMPT');
          const lessonsBeforeFix = this.lessonsManager.getTotalCount();
          // Get lessons for all files being fixed
          const affectedFiles = [...new Set(unresolvedIssues.map(i => i.comment.path))];
          const lessons = this.lessonsManager.getLessonsForFiles(affectedFiles);
          const { prompt, detailedSummary, lessonsIncluded } = buildFixPrompt(
            unresolvedIssues,
            lessons
          );

          console.log(chalk.cyan(`\n${detailedSummary}\n`));
          
          // In verbose mode, show lessons by scope
          if (this.options.verbose && lessons.length > 0) {
            const allLessons = this.lessonsManager.getAllLessons();
            const counts = this.lessonsManager.getCounts();
            const newLabel = counts.newThisSession > 0 ? ` (${counts.newThisSession} new this run)` : '';
            console.log(chalk.yellow(`  Lessons from previous attempts${newLabel}:`));
            
            if (allLessons.global.length > 0) {
              console.log(chalk.gray('    Global:'));
              for (const lesson of allLessons.global.slice(-5)) {
                const display = formatLessonForDisplay(lesson);
                console.log(chalk.gray(`      • ${display.substring(0, 100)}...`));
              }
            }
            
            for (const filePath of affectedFiles) {
              const fileLessons = allLessons.files[filePath];
              if (fileLessons && fileLessons.length > 0) {
                console.log(chalk.gray(`    ${filePath}:`));
                for (const lesson of fileLessons.slice(-3)) {
                  const display = formatLessonForDisplay(lesson);
                  console.log(chalk.gray(`      • ${display.substring(0, 100)}...`));
                }
              }
            }
            console.log('');
          }
          
          debug('Fix prompt length', prompt.length);
          const newLessonsCount = this.lessonsManager.getNewLessonsCount();
          debug('Lessons in prompt', { total: lessonsIncluded, newThisSession: newLessonsCount });

          // Guard: Don't run fixer with empty prompt
          // WHY: Empty prompt = nothing to fix, fixer will fail or do nothing
          if (prompt.length === 0 || unresolvedIssues.length === 0) {
            debug('Empty prompt or no issues - skipping fixer');
            console.log(chalk.green('\n✓ Nothing to fix - all issues resolved'));
            allFixed = true;
            break;
          }

          // Run fixer tool
          debugStep('RUNNING FIXER TOOL');
          this.stateManager.setPhase('fixing');
          startTimer('Run fixer');
          spinner.start(`Running ${this.runner.name} to fix issues...`);
          spinner.stop();
          
          debug('Executing runner', { tool: this.runner.name, workdir: this.workdir, model: this.options.toolModel });
          const codexAddDirs = [...(this.options.codexAddDir ?? [])];

          const result = await this.runner.run(this.workdir, prompt, {
            model: this.getCurrentModel(),
            codexAddDirs,
          });
          const fixerTime = endTimer('Run fixer');
          debug('Runner result', { success: result.success, error: result.error, duration: fixerTime });

          if (!result.success) {
            console.log(chalk.red(`\n${this.runner.name} failed (${formatDuration(fixerTime)}):`, result.error));
            
            // PERMISSION ERRORS: Bail out immediately - don't waste tokens
            // WHY: If the tool can't write files, retrying won't help. User needs to fix permissions.
            if (result.errorType === 'permission') {
              console.log(chalk.red('\n⛔ PERMISSION ERROR: Fixer tool cannot write to files'));
              console.log(chalk.yellow('  Bailing out - retrying won\'t help.'));
              if (result.error) {
                console.log(chalk.cyan(`  ${result.error}`));
              }
              debug('Bailing out due to permission error', { tool: this.runner.name, error: result.error });
              // Don't record as lesson - this is an environment/config issue, not a code issue
              return;
            }
            
            // AUTH ERRORS: Also bail out - retrying won't help
            if (result.errorType === 'auth') {
              console.log(chalk.red('\n⛔ AUTHENTICATION ERROR: API key or auth issue'));
              console.log(chalk.yellow('  Check your API keys and authentication.'));
              debug('Bailing out due to auth error', { tool: this.runner.name, error: result.error });
              return;
            }
            
            // ENVIRONMENT ERRORS: Tool environment issue (e.g., TTY/cursor position)
            // WHY: These are infrastructure issues that won't fix themselves with retries.
            // The tool needs a different environment (real TTY, GUI, etc.)
            if (result.errorType === 'environment') {
              console.log(chalk.red('\n⛔ ENVIRONMENT ERROR: Tool requires different runtime environment'));
              console.log(chalk.yellow('  This tool may require an interactive terminal or GUI.'));
              if (result.error) {
                console.log(chalk.cyan(`  ${result.error}`));
              }
              console.log(chalk.yellow('\n  Suggestions:'));
              console.log(chalk.yellow('    - Try a different tool: --tool cursor or --tool claude-code'));
              console.log(chalk.yellow('    - Run prr in an interactive terminal (not CI/cron)'));
              console.log(chalk.yellow('    - Use --tool llm-api as a fallback (direct LLM without TUI)'));
              debug('Bailing out due to environment error', { tool: this.runner.name, error: result.error });
              return;
            }

            const now = Date.now();
            const isRapidFailure = fixerTime > 0 && fixerTime <= PRResolver.RAPID_FAILURE_MS;
            if (isRapidFailure) {
              if (now - this.lastFailureTime > PRResolver.RAPID_FAILURE_WINDOW_MS) {
                this.rapidFailureCount = 0;
              }
              this.rapidFailureCount++;
              this.lastFailureTime = now;

              if (this.rapidFailureCount >= PRResolver.MAX_RAPID_FAILURES) {
                console.log(chalk.red('\n⛔ FAST-FAIL: Repeated rapid tool failures detected'));
                console.log(chalk.yellow(`  ${this.runner.name} failed ${this.rapidFailureCount} times within ${formatDuration(PRResolver.RAPID_FAILURE_WINDOW_MS)}.`));
                console.log(chalk.yellow('  Aborting to avoid a tight retry loop.'));
                debug('Bailing out due to rapid failures', { tool: this.runner.name, error: result.error, duration: fixerTime });
                return;
              }
            } else {
              this.rapidFailureCount = 0;
            }
            
            // DON'T record transient tool failures as lessons
            // WHY: "connection stalled", "model unavailable" aren't actionable for future fixes
            // Only code-related lessons (fix rejected, wrong approach) are useful
            debug('Tool failure (not recorded as lesson)', { tool: this.runner.name, error: result.error });
            // Track model error for performance stats
            this.stateManager.recordModelError(this.runner.name, this.getCurrentModel());
            await this.stateManager.save();
            continue;
          }
          
          console.log(chalk.gray(`\n  Fixer completed in ${formatDuration(fixerTime)}`));

          // Check for changes
          if (!(await hasChanges(git))) {
            const currentModel = this.getCurrentModel();
            console.log(chalk.yellow(`\nNo changes made by ${this.runner.name}${currentModel ? ` (${currentModel})` : ''}`));

            // Parse fixer output for NO_CHANGES explanation
            const noChangesExplanation = this.parseNoChangesExplanation(result.output);

            if (noChangesExplanation) {
              // Fixer provided an explanation for why it made no changes
              console.log(chalk.cyan(`  Fixer's explanation: ${noChangesExplanation}`));
              this.lessonsManager.addGlobalLesson(`${this.runner.name}${currentModel ? ` with ${currentModel}` : ''} made no changes: ${noChangesExplanation}`);

              // Store this explanation with each issue (but don't necessarily dismiss - depends on the reason)
              const lowerExplanation = noChangesExplanation.toLowerCase();
              const isAlreadyFixed = lowerExplanation.includes('already') ||
                                     lowerExplanation.includes('exists') ||
                                     lowerExplanation.includes('has') ||
                                     lowerExplanation.includes('implements');

              if (isAlreadyFixed) {
                // Fixer claims issues are already fixed - document this
                console.log(chalk.gray(`  → Fixer believes issues are already addressed`));
                for (const issue of unresolvedIssues) {
                  this.stateManager.addDismissedIssue(
                    issue.comment.id,
                    `Fixer tool (${this.runner.name}) reported: ${noChangesExplanation}`,
                    'already-fixed',
                    issue.comment.path,
                    issue.comment.line,
                    issue.comment.body
                  );
                }
              } else {
                // Fixer couldn't fix for other reasons (unclear instructions, etc.) - document but don't dismiss
                console.log(chalk.gray(`  → This will be recorded for feedback loop`));
              }
            } else {
              // Fixer made zero changes WITHOUT explaining why
              console.log(chalk.yellow(`  Fixer didn't explain why no changes were made`));
              console.log(chalk.gray(`  → Will try different model/tool approach`));
              this.lessonsManager.addGlobalLesson(`${this.runner.name}${currentModel ? ` with ${currentModel}` : ''} made no changes without explanation - trying different approach`);
            }

            // Track no-changes for performance stats
            this.stateManager.recordModelNoChanges(this.runner.name, currentModel);
            
            // Count this as a failure for rotation purposes
            this.consecutiveFailures++;
            this.modelFailuresInCycle++;
            
            // Rotation strategy:
            // 1. Try single-issue focus with current model (odd failures)
            // 2. Rotate to next model for current tool (even failures, has more models)
            // 3. Rotate to next tool (all models exhausted for current tool)
            // 4. Try direct LLM API as last resort (all tools exhausted)
            
            const isOddFailure = this.consecutiveFailures % 2 === 1;
            
            if (isOddFailure && unresolvedIssues.length > 1) {
              console.log(chalk.yellow('\n  🎯 Trying single-issue focus mode...'));
              const singleIssueFixed = await this.trySingleIssueFix(unresolvedIssues, git, verifiedThisSession);
              if (singleIssueFixed) {
                this.consecutiveFailures = 0;
                this.modelFailuresInCycle = 0;
                this.progressThisCycle++;  // Track progress for bail-out
              }
            } else if (!isOddFailure) {
              // Try rotating model or tool
              const rotated = this.tryRotation();
              
              // Check if bail-out was triggered by tryRotation()
              if (this.stateManager.getNoProgressCycles() >= this.options.maxStaleCycles) {
                // Bail-out triggered - try direct LLM one last time before giving up
                console.log(chalk.yellow('\n  🧠 Last resort: trying direct LLM API fix before bail-out...'));
                const directFixed = await this.tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
                if (directFixed) {
                  this.consecutiveFailures = 0;
                  this.modelFailuresInCycle = 0;
                  this.progressThisCycle++;
                  this.stateManager.resetNoProgressCycles();  // Made progress, reset
                } else {
                  // Direct LLM also failed - execute bail-out
                  await this.executeBailOut(unresolvedIssues, comments);
                  break;  // Exit fix loop
                }
              } else if (rotated) {
                console.log(chalk.cyan('  Starting fresh with batch mode...'));
              } else {
                // Rotation failed but not at bail-out threshold yet
                console.log(chalk.yellow('\n  🧠 All tools/models exhausted, trying direct LLM API fix...'));
                const directFixed = await this.tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
                if (directFixed) {
                  this.consecutiveFailures = 0;
                  this.modelFailuresInCycle = 0;
                  this.progressThisCycle++;
                }
              }
            }
            
            // Check if we bailed out (break would have been triggered above)
            if (this.bailedOut) {
              break;  // Propagate break from bail-out
            }
            
            // After single-issue or rotation attempts, filter out any newly verified items
            // WHY: trySingleIssueFix/tryDirectLLMFix can mark items as verified
            // but we 'continue' before the normal filtering at end of verification
            // IMPORTANT: Use verifiedThisSession, not isCommentVerifiedFixed, to avoid
            // removing stale verifications that findUnresolvedIssues kept for re-checking
            const verifiedDuringRecovery = unresolvedIssues.filter(
              (i) => verifiedThisSession.has(i.comment.id)
            );
            if (verifiedDuringRecovery.length > 0) {
              debug('Filtering verified items after recovery attempt', {
                before: unresolvedIssues.length,
                verified: verifiedDuringRecovery.map(i => i.comment.id),
              });
              unresolvedIssues.splice(
                0,
                unresolvedIssues.length,
                ...unresolvedIssues.filter(
                  (i) => !verifiedThisSession.has(i.comment.id)
                )
              );
            }
            
            debug('Continuing to next iteration after no-changes recovery', {
              unresolvedCount: unresolvedIssues.length,
              consecutiveFailures: this.consecutiveFailures,
            });
            await this.stateManager.save();
            await this.lessonsManager.save();
            continue;  // Continue to next iteration instead of breaking
          }

          // Verify fixes
          debugStep('VERIFYING FIXES');
          this.stateManager.setPhase('verifying');
          setTokenPhase('Verify fixes');
          startTimer('Verify fixes');
          spinner.start('Verifying fixes...');
          const changedFiles = await getChangedFiles(git);
          debug('Changed files', changedFiles);
          let verifiedCount = 0;
          let failedCount = 0;

          // Separate issues by whether their file was changed
          const unchangedIssues: typeof unresolvedIssues = [];
          const changedIssues: typeof unresolvedIssues = [];
          
          for (const issue of unresolvedIssues) {
            if (!changedFiles.includes(issue.comment.path)) {
              unchangedIssues.push(issue);
            } else {
              changedIssues.push(issue);
            }
          }

          // Mark unchanged files as failed immediately and document as dismissed
          // NOTE: No validation needed here - we're providing an explicit, meaningful reason
          for (const issue of unchangedIssues) {
            this.stateManager.addVerificationResult(issue.comment.id, {
              passed: false,
              reason: 'File was not modified',
            });
            this.stateManager.addDismissedIssue(
              issue.comment.id,
              'File was not modified by the fixer tool, so issue could not have been addressed',
              'file-unchanged',
              issue.comment.path,
              issue.comment.line,
              issue.comment.body
            );
            failedCount++;
          }

          // Verify changed files
          if (changedIssues.length > 0) {
            // Cache diffs by file to avoid fetching same diff multiple times
            const diffCache = new Map<string, string>();
            
            const getDiff = async (path: string): Promise<string> => {
              let diff = diffCache.get(path);
              if (!diff) {
                diff = await getDiffForFile(git, path);
                diffCache.set(path, diff);
              }
              return diff;
            };

            if (this.options.noBatch) {
              // Sequential mode - one LLM call per fix
              spinner.text = `Verifying ${changedIssues.length} fixes sequentially...`;
              
              for (let i = 0; i < changedIssues.length; i++) {
                const issue = changedIssues[i];
                spinner.text = `Verifying [${i + 1}/${changedIssues.length}] ${issue.comment.path}:${issue.comment.line || '?'}`;
                
                const diff = await getDiff(issue.comment.path);
                const verification = await this.llm.verifyFix(
                  issue.comment.body,
                  issue.comment.path,
                  diff
                );

                this.stateManager.addVerificationResult(issue.comment.id, {
                  passed: verification.fixed,
                  reason: verification.explanation,
                });

                debug(`Verification for ${issue.comment.path}:${issue.comment.line}`, verification);
                
                if (verification.fixed) {
                  verifiedCount++;
                  this.stateManager.markCommentVerifiedFixed(issue.comment.id);
                  this.stateManager.addCommentToIteration(issue.comment.id);
                  verifiedThisSession.add(issue.comment.id);  // Track for session filtering
                } else {
                  failedCount++;
                  // Analyze failure to generate actionable lesson
                  const lesson = await this.llm.analyzeFailedFix(
                    {
                      comment: issue.comment.body,
                      filePath: issue.comment.path,
                      line: issue.comment.line,
                    },
                    diff,
                    verification.explanation
                  );
                  this.lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - ${lesson}`);
                }
              }
            } else {
              // Batch mode - one LLM call for all fixes
              const fixesToVerify: Array<{
                id: string;
                comment: string;
                filePath: string;
                diff: string;
              }> = [];

              for (const issue of changedIssues) {
                const diff = await getDiff(issue.comment.path);
                fixesToVerify.push({
                  id: issue.comment.id,
                  comment: issue.comment.body,
                  filePath: issue.comment.path,
                  diff,
                });
              }

              spinner.text = `Batch verifying ${fixesToVerify.length} fixes with LLM...`;
              const verificationResults = await this.llm.batchVerifyFixes(fixesToVerify);

              // Process results
              for (const issue of changedIssues) {
                const result = verificationResults.get(issue.comment.id.toLowerCase());
                
                if (!result) {
                  // LLM didn't return result for this issue, mark as needing review
                  this.stateManager.addVerificationResult(issue.comment.id, {
                    passed: false,
                    reason: 'Verification result not found in LLM response',
                  });
                  failedCount++;
                  continue;
                }

                this.stateManager.addVerificationResult(issue.comment.id, {
                  passed: result.fixed,
                  reason: result.explanation,
                });

                debug(`Verification for ${issue.comment.path}:${issue.comment.line}`, result);
                
                if (result.fixed) {
                  verifiedCount++;
                  this.stateManager.markCommentVerifiedFixed(issue.comment.id);
                  this.stateManager.addCommentToIteration(issue.comment.id);
                  verifiedThisSession.add(issue.comment.id);  // Track for session filtering
                } else {
                  failedCount++;
                  this.lessonsManager.addLesson(
                    `Fix for ${issue.comment.path}:${issue.comment.line} rejected: ${result.explanation}`
                  );
                }
              }
            }
          }

          const totalIssues = unresolvedIssues.length;
          const verifyTime = endTimer('Verify fixes');
          const progressPct = Math.round((verifiedCount / totalIssues) * 100);
          const lessonsAfterVerify = this.lessonsManager.getTotalCount();
          const newLessons = lessonsAfterVerify - lessonsBeforeFix;
          
          // Track model performance for this iteration
          // WHY: Know which models work well for this project
          // Note: currentModel already defined at start of iteration
          if (verifiedCount > 0) {
            this.stateManager.recordModelFix(this.runner.name, currentModel, verifiedCount);
            // Track progress for bail-out cycle detection
            this.progressThisCycle += verifiedCount;
          }
          if (failedCount > 0) {
            this.stateManager.recordModelFailure(this.runner.name, currentModel, failedCount);
          }
          
          spinner.succeed(`Verified: ${formatNumber(verifiedCount)}/${formatNumber(totalIssues)} fixed (${progressPct}%), ${formatNumber(failedCount)} remaining (${formatDuration(verifyTime)})`);
          
          // Show iteration summary
          console.log(chalk.gray(`\n  Iteration ${fixIteration} summary:`));
          console.log(chalk.gray(`    • Fixed: ${formatNumber(verifiedCount)} issues`));
          console.log(chalk.gray(`    • Failed: ${formatNumber(failedCount)} issues`));
          if (newLessons > 0) {
            console.log(chalk.yellow(`    • New lessons: +${newLessons} (total: ${lessonsAfterVerify})`));
          } else {
            console.log(chalk.gray(`    • Lessons: ${lessonsAfterVerify} (no new)`));
          }
          
          debug('Verification summary', { verifiedCount, failedCount, totalIssues, newLessons, totalLessons: lessonsAfterVerify, duration: verifyTime });
          await this.stateManager.save();
          await this.lessonsManager.save();
          debug('State and lessons saved');

          // Commit this iteration's verified fixes (Phase 1)
          // Only commit NEW fixes - filter out already-committed ones (Trap 3)
          if (verifiedCount > 0 && this.options.incrementalCommits) {
            const newlyVerified = Array.from(verifiedThisSession).filter(id => !alreadyCommitted.has(id));
            
            if (newlyVerified.length > 0) {
              const commitResult = await commitIteration(git, newlyVerified, fixIteration);
              if (commitResult) {
                // Mark these as committed so we don't try again
                for (const id of newlyVerified) {
                  alreadyCommitted.add(id);
                }
                console.log(chalk.green(`  Committed ${newlyVerified.length} fix(es) [${commitResult.hash.slice(0, 7)}]`));
                
                // Push immediately if auto-push enabled (Phase 3)
                if (this.options.autoPush && !this.options.noPush) {
                  try {
                    startTimer('Push iteration fixes');
                    await pushWithRetry(git, this.prInfo.branch, { githubToken: this.config.githubToken });
                    const pushTime = endTimer('Push iteration fixes');
                    console.log(chalk.green(`  Pushed to origin/${this.prInfo.branch} (${formatDuration(pushTime)})`));
                    
                    // Update expected bot response time for the new commit
                    // WHY: After pushing, bots will review - schedule when to check for new issues
                    const pushTime_now = new Date();
                    this.expectedBotResponseTime = this.calculateExpectedBotResponseTime(pushTime_now);
                    if (this.expectedBotResponseTime) {
                      const msUntil = this.expectedBotResponseTime.getTime() - Date.now();
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

          // Check if all fixed
          allFixed = failedCount === 0;
          
          if (allFixed && !this.exitReason.startsWith('all')) {
            this.exitReason = 'all_fixed';
            this.exitDetails = 'All issues fixed and verified in fix loop';
          }

          if (!allFixed) {
            // Track consecutive failures for strategy switching
            if (verifiedCount === 0) {
              this.consecutiveFailures++;
              this.modelFailuresInCycle++;
              
              // Rotation strategy:
              // 1. Batch mode (normal) - first attempt
              // 2. Single-issue focus mode - if batch fails (odd failure)
              // 3. Rotate model within current tool (even failure, has more models)
              // 4. Rotate to next tool (all models exhausted)
              // 5. Direct LLM API - after all tools exhausted
              
              const isOddFailure = this.consecutiveFailures % 2 === 1;
              
              if (isOddFailure && unresolvedIssues.length > 1) {
                // Odd failure = batch failed, try single-issue with same tool/model
                console.log(chalk.yellow('\n  🎯 Batch failed, trying single-issue focus mode...'));
                const singleIssueFixed = await this.trySingleIssueFix(unresolvedIssues, git, verifiedThisSession);
                if (singleIssueFixed) {
                  this.consecutiveFailures = 0;
                  this.modelFailuresInCycle = 0;
                  this.progressThisCycle++;  // Track progress for bail-out
                }
              }
              else if (!isOddFailure) {
                // Even failure = single-issue also failed, try rotation
                const rotated = this.tryRotation();
                
                // Check if bail-out was triggered by tryRotation()
                if (this.stateManager.getNoProgressCycles() >= this.options.maxStaleCycles) {
                  // Bail-out triggered - try direct LLM one last time before giving up
                  console.log(chalk.yellow('\n  🧠 Last resort: trying direct LLM API fix before bail-out...'));
                  const directFixed = await this.tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
                  if (directFixed) {
                    this.consecutiveFailures = 0;
                    this.modelFailuresInCycle = 0;
                    this.progressThisCycle++;
                    this.stateManager.resetNoProgressCycles();  // Made progress, reset
                  } else {
                    // Direct LLM also failed - execute bail-out
                    await this.executeBailOut(unresolvedIssues, comments);
                    break;  // Exit fix loop
                  }
                } else if (rotated) {
                  console.log(chalk.cyan('  Starting fresh with batch mode...'));
                } else {
                  // Rotation failed but not at bail-out threshold yet
                  // Try direct LLM as fallback
                  console.log(chalk.yellow('\n  🧠 All tools/models exhausted, trying direct LLM API fix...'));
                  const directFixed = await this.tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
                  if (directFixed) {
                    this.consecutiveFailures = 0;
                    this.modelFailuresInCycle = 0;
                    this.progressThisCycle++;
                  }
                }
              }
              
              // Check if we bailed out
              if (this.bailedOut) {
                break;  // Propagate break from bail-out
              }
            } else {
              // Made progress, reset failure counters
              this.consecutiveFailures = 0;
              this.modelFailuresInCycle = 0;
            }
            
            // Update unresolved list for next iteration
            // IMPORTANT: Use verifiedThisSession, not isCommentVerifiedFixed
            // WHY: isCommentVerifiedFixed includes stale items that findUnresolvedIssues
            // intentionally kept for re-checking. We only want to remove items
            // that were actually verified THIS session.
            unresolvedIssues.splice(
              0,
              unresolvedIssues.length,
              ...unresolvedIssues.filter(
                (i) => !verifiedThisSession.has(i.comment.id)
              )
            );
          }
        }

        if (!allFixed && this.options.maxFixIterations > 0) {
          console.log(chalk.yellow(`\nMax fix iterations (${formatNumber(this.options.maxFixIterations)}) reached. ${formatNumber(unresolvedIssues.length)} issues remain.`));
          this.exitReason = 'max_iterations';
          this.exitDetails = `Hit max fix iterations (${this.options.maxFixIterations}) with ${unresolvedIssues.length} issue(s) remaining`;
          
          // Store final state for after action report
          this.finalUnresolvedIssues = [...unresolvedIssues];
          this.finalComments = [...comments];
        }

        // Commit changes if we have any
        debugStep('COMMIT PHASE');
        if (await hasChanges(git)) {
          // Export lessons to repo BEFORE commit so they're included
          // WHY: Team gets lessons with the same push as fixes - single atomic update
          if (this.lessonsManager.hasNewLessonsForRepo()) {
            spinner.start('Exporting lessons to repo...');
            await this.lessonsManager.saveToRepo();
            spinner.succeed('Lessons exported');
          }

          const fixedIssues = comments
            .filter((comment) => this.stateManager.isCommentVerifiedFixed(comment.id))
            .map((comment) => ({
              filePath: comment.path,
              comment: comment.body,
            }));

          if (this.options.noCommit) {
            warn('NO-COMMIT MODE: Skipping commit. Changes are in workdir.');
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
            this.exitReason = 'no_commit_mode';
            this.exitDetails = 'No-commit mode enabled - changes left uncommitted in workdir';
            break;
          }
          
          spinner.start('Generating commit message...');
          const commitMsg = await this.llm.generateCommitMessage(fixedIssues);
          debug('Generated commit message', commitMsg);
          
          spinner.text = 'Committing changes...';
          const commit = await squashCommit(git, commitMsg);
          spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${commit.filesChanged} files)`);
          debug('Commit created', commit);

          // Push if auto-push mode AND not in no-push mode
          if (this.options.autoPush && !this.options.noPush) {
            debugStep('PUSH PHASE');
            // Log command BEFORE spinner so user can copy it if needed
            console.log(chalk.gray(`  Running: git push origin ${this.prInfo.branch}`));
            console.log(chalk.gray(`  Workdir: ${this.workdir}`));
            spinner.start('Pushing changes...');
            await pushWithRetry(git, this.prInfo.branch, {
              onPullNeeded: () => {
                spinner.text = 'Push rejected, pulling and retrying...';
              },
              githubToken: this.config.githubToken,
              onConflict: async (conflictedFiles) => {
                // Resolve rebase conflicts using LLM
                spinner.text = 'Resolving rebase conflicts...';
                const resolution = await this.resolveConflictsWithLLM(
                  git,
                  conflictedFiles,
                  `origin/${this.prInfo.branch}`
                );
                return resolution.success;
              },
            });
            spinner.succeed('Pushed to remote');

            // Check CodeRabbit status and trigger if needed
            // WHY: Some repos configure CodeRabbit to require manual trigger (@coderabbitai review)
            // We check if it has reviewed the current commit and trigger only if needed
            let latestHeadSha = this.prInfo.headSha;
            try {
              spinner.start('Checking CodeRabbit status...');
              
              // Get the latest HEAD sha after push
              const latestPR = await this.github.getPRInfo(owner, repo, number);
              latestHeadSha = latestPR.headSha;
              
              const result = await this.github.triggerCodeRabbitIfNeeded(
                owner, repo, number, this.prInfo.branch, latestHeadSha
              );
              
              if (result.mode === 'none') {
                spinner.info('CodeRabbit not detected on this PR');
              } else if (result.reviewedCurrentCommit) {
                spinner.succeed(`CodeRabbit already reviewed current commit ✓`);
              } else if (result.triggered) {
                spinner.succeed(`CodeRabbit triggered for new commit`);
              } else {
                spinner.info(`CodeRabbit (${result.mode}) - ${result.reason}`);
              }
              debug('CodeRabbit check result', result);
            } catch (err) {
              debug('Failed to check/trigger CodeRabbit', { error: err });
              spinner.warn('Could not check CodeRabbit (continuing anyway)');
            }

            // Wait for re-review using smart timing based on observed bot response times
            if (pushIteration < maxPushIterations) {
              await this.waitForBotReviews(owner, repo, number, latestHeadSha);
            }
          } else if (this.options.noPush) {
            warn('NO-PUSH MODE: Changes committed locally but not pushed.');
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
            this.exitReason = 'no_push_mode';
            this.exitDetails = 'No-push mode enabled - changes committed locally only';
            break;
          } else {
            console.log(chalk.blue('\nChanges committed locally. Use --auto-push to push automatically.'));
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
            this.exitReason = 'committed_locally';
            this.exitDetails = 'Changes committed locally - use --auto-push to push';
            break;
          }
        } else {
          console.log(chalk.yellow('\nNo changes to commit'));
          debug('Git status shows no changes');
          this.exitReason = 'no_changes';
          this.exitDetails = 'No changes to commit (fixer made no modifications)';
          
          // Store final state for after action report (unresolvedIssues might still exist)
          this.finalUnresolvedIssues = [...unresolvedIssues];
          this.finalComments = [...comments];
          break;
        }
      }

      // Final lessons export (catches any lessons from last iteration not yet committed)
      // WHY: Lessons are also exported before each commit, but this catches edge cases
      if (this.lessonsManager.hasNewLessonsForRepo()) {
        spinner.start('Exporting final lessons...');
        const saved = await this.lessonsManager.saveToRepo();
        if (saved) {
          spinner.succeed('Lessons exported (run git add/commit to include)');
        } else {
          spinner.warn('Could not export lessons to repo');
        }
      }

      // Cleanup
      if (!this.options.keepWorkdir && !this.options.dryRun) {
        spinner.start('Cleaning up workdir...');
        await cleanupWorkdir(this.workdir);
        spinner.succeed('Workdir cleaned up');
      } else {
        console.log(chalk.gray(`\nWorkdir preserved: ${this.workdir}`));
      }

      endTimer('Total');
      printTimingSummary();
      printTokenSummary();
      this.printModelPerformance();
      
      // Developer handoff prompt and after action report (if there are remaining issues)
      if (this.finalUnresolvedIssues.length > 0) {
        this.printHandoffPrompt(this.finalUnresolvedIssues);
        await this.printAfterActionReport(this.finalUnresolvedIssues, this.finalComments);
      }
      
      // Final results summary - AFTER profiling so it's visible
      this.printFinalSummary();
      
      // Ring terminal bell 3 times to notify user completion
      // WHY: Long-running processes need audio notification when done
      if (!this.options.noBell) {
        this.ringBell(3);
      }
      
      console.log(chalk.green('\nDone!'));

    } catch (error) {
      endTimer('Total');
      printTimingSummary();
      printTokenSummary();
      this.printModelPerformance();
      
      // Developer handoff prompt and after action report on error too
      if (this.finalUnresolvedIssues.length > 0) {
        this.printHandoffPrompt(this.finalUnresolvedIssues);
        await this.printAfterActionReport(this.finalUnresolvedIssues, this.finalComments);
      }
      
      this.printFinalSummary();  // Show results even on error
      spinner.fail('Error');
      
      // Clean up workdir on error if not keeping it
      if (!this.options.keepWorkdir && this.workdir) {
        try {
          await cleanupWorkdir(this.workdir);
        } catch {
          // Ignore cleanup errors to avoid masking the original error
        }
      }
      
      // Ring terminal bell on error too - user needs to know
      if (!this.options.noBell) {
        this.ringBell(3);
      }
      
      throw error;
    }
  }

  /**
   * Sets up the CLI runner tool for fixing issues.
   *
   * WHY auto-detection: Most users only have one LLM CLI tool installed.
   * Auto-detection removes friction - users don't need to know/remember which
   * tool they have or configure it explicitly. They can just run `prr` and
   * it works.
   *
   * WHY explicit mode: When users have multiple tools or want consistency
   * across environments, they can lock in a specific tool. This also provides
   * clearer error messages when the expected tool isn't available.
   *
   * WHY this order: cursor, claude-code, opencode
   * - cursor: Most common in the wild, well-established
   * - claude-code: Native Anthropic tool, often better for Claude-specific workflows
   * - opencode: Newer/less common, but still supported
   */
  private async setupRunner(): Promise<Runner> {
    // Auto-detect all available and ready runners
    const detected = await detectAvailableRunners(this.options.verbose);

    if (detected.length === 0) {
      throw new Error('No fix tools available! Install one of: cursor, claude-code, aider, opencode, codex, llm-api');
    }

    // Print summary
    printRunnerSummary(detected);

    // Find preferred runner: CLI option > PRR_TOOL env var > auto (first available)
    let primaryRunner: Runner;
    
    // Determine which tool to use: CLI option takes precedence, then config (PRR_TOOL env var)
    // 'auto' or undefined means use first available tool
    const preferredTool = this.options.tool || this.config.defaultTool;
    const isAutoSelect = !preferredTool || preferredTool === 'auto';

    if (!isAutoSelect) {
      const preferred = detected.find(d => d.runner.name === preferredTool);
      if (preferred) {
        primaryRunner = preferred.runner;
      } else {
        // Check if it exists but isn't ready
        const runner = getRunnerByName(preferredTool);
        if (runner) {
          const status = await runner.checkStatus();
          if (status.installed && !status.ready) {
            warn(`${runner.displayName} is installed but not ready: ${status.error}`);
          } else {
            warn(`${preferredTool} not available, using ${detected[0].runner.displayName}`);
          }
        }
        primaryRunner = detected[0].runner;
      }
    } else {
      // Auto-select: use first available tool
      primaryRunner = detected[0].runner;
    }

    // Build list of all ready runners for rotation
    this.runners = detected.map(d => d.runner);

    // Move primary to front
    const primaryIndex = this.runners.findIndex(r => r.name === primaryRunner.name);
    if (primaryIndex > 0) {
      this.runners.splice(primaryIndex, 1);
      this.runners.unshift(primaryRunner);
    }

    // Initialize model indices and show info
    const primaryModels = this.getModelsForRunner(primaryRunner);
    const initialModel = this.options.toolModel || primaryModels[0];

    console.log(chalk.cyan(`\nPrimary fixer: ${primaryRunner.displayName}`));
    if (initialModel) {
      console.log(chalk.gray(`  Starting model: ${initialModel}`));
    }
    if (primaryModels.length > 1 && !this.options.toolModel) {
      console.log(chalk.gray(`  Model rotation: ${primaryModels.join(' → ')}`));
    }
    if (this.runners.length > 1) {
      console.log(chalk.gray(`  Tool rotation: ${this.runners.map(r => r.displayName).join(' → ')}`));
    }

    return primaryRunner;
  }

  private buildConflictResolutionPrompt(conflictedFiles: string[], baseBranch: string): string {
    const fileList = conflictedFiles.map(f => `- ${f}`).join('\n');
    
    return `MERGE CONFLICT RESOLUTION

The following files have merge conflicts that need to be resolved:

${fileList}

These conflicts occurred while merging '${baseBranch}' into the current branch.

INSTRUCTIONS:
1. Open each conflicted file
2. Look for conflict markers: <<<<<<<, =======, >>>>>>>
3. For each conflict:
   - Understand what both sides are trying to do
   - Choose the correct resolution that preserves the intent of both changes
   - Remove all conflict markers
4. Ensure the code compiles/runs correctly after resolution
5. Save all files

IMPORTANT:
- Do NOT just pick one side blindly
- Merge the changes intelligently, combining both when possible
- Pay special attention to imports, function signatures, and data structures
- For lock files (bun.lock, package-lock.json, yarn.lock), regenerate them by running the package manager install command
- For configuration files, ensure all necessary entries from both sides are preserved

After resolving, the files should have NO conflict markers remaining.`;
  }

  /**
   * Resolve merge conflicts using LLM tools.
   * 
   * WHY THIS EXISTS: Merge conflicts block the entire fix loop. Previously, prr would
   * bail out when conflicts were detected, requiring manual intervention. This method
   * enables automatic conflict resolution using the same LLM infrastructure we use
   * for fixing review comments.
   * 
   * WHY UNIFIED: This method is called from multiple places:
   * - Initial remote conflict detection (previous interrupted merge)
   * - Pull conflicts (diverged branches)
   * - Stash pop conflicts (interrupted run with local changes)
   * - PR merge conflicts (base branch out of sync)
   * Centralizing the logic ensures consistent behavior and reduces code duplication.
   * 
   * Two-stage resolution:
   * 1. Lock files: Delete and regenerate via package manager
   *    WHY: LLMs cannot correctly merge lock files - they're machine-generated
   *    and must be regenerated from the manifest (package.json, etc.)
   * 
   * 2. Code files: Use runner tool (Cursor/Aider/etc), then fallback to direct LLM API
   *    WHY TWO ATTEMPTS: Fixer tools are good at agentic changes but sometimes
   *    miss conflict markers or make partial fixes. Direct LLM API gives precise
   *    control for targeted resolution of remaining conflicts.
   * 
   * WHY CHECK BOTH GIT STATUS AND FILE CONTENTS: Git might mark a file as resolved
   * (no longer in `status.conflicted`) but the file might still contain conflict
   * markers (<<<<<<<) if the tool staged it without fully resolving. We check both
   * to catch false positives.
   * 
   * @param git - SimpleGit instance
   * @param conflictedFiles - Array of files with conflicts
   * @param mergingBranch - Name of the branch being merged (for prompt context)
   * @returns Object with success flag and any remaining conflicts
   */
  private async resolveConflictsWithLLM(
    git: SimpleGit,
    conflictedFiles: string[],
    mergingBranch: string
  ): Promise<{ success: boolean; remainingConflicts: string[] }> {
    // Separate lock files from regular files
    const lockFiles = conflictedFiles.filter(f => isLockFile(f));
    const codeFiles = conflictedFiles.filter(f => !isLockFile(f));
    
    console.log(chalk.cyan(`  Conflicted files (${conflictedFiles.length}):`));
    for (const file of conflictedFiles) {
      const isLock = isLockFile(file);
      console.log(chalk.cyan(`    - ${file}${isLock ? chalk.gray(' (lock file - will regenerate)') : ''}`));
    }
    
    // Handle lock files first - delete and regenerate
    if (lockFiles.length > 0) {
      await this.handleLockFileConflicts(git, lockFiles);
    }
    
    // Handle code files with LLM tools
    if (codeFiles.length > 0) {
      // Build prompt for conflict resolution (only non-lock files)
      const conflictPrompt = this.buildConflictResolutionPrompt(codeFiles, mergingBranch);
      
      // Run the cursor/opencode tool to resolve conflicts
      console.log(chalk.cyan(`\n  Attempt 1: Using ${this.runner.name} to resolve conflicts...`));
      const runResult = await this.runner.run(this.workdir, conflictPrompt, { model: this.getCurrentModel() });
      
      if (!runResult.success) {
        console.log(chalk.yellow(`  ${this.runner.name} failed, will try direct API...`));
      } else {
        // Stage all code files that cursor may have resolved
        console.log(chalk.cyan('  Staging resolved files...'));
        for (const file of codeFiles) {
          try {
            await git.add(file);
          } catch {
            // File might still have conflicts, ignore
          }
        }
      }
    }
    
    // Check if conflicts remain after first attempt
    // Check both git status AND actual file contents for conflict markers
    let statusAfter = await git.status();
    let gitConflicts = statusAfter.conflicted || [];
    let markerConflicts = await findFilesWithConflictMarkers(this.workdir, codeFiles);
    let remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
    
    if (remainingConflicts.length === 0 && codeFiles.length > 0) {
      console.log(chalk.green(`  ✓ ${this.runner.name} resolved all conflicts`));
    } else if (markerConflicts.length > 0) {
      console.log(chalk.yellow(`  Files still have conflict markers: ${markerConflicts.join(', ')}`));
    }
    
    // If conflicts remain, try direct LLM API as fallback
    if (remainingConflicts.length > 0) {
      setTokenPhase('Resolve conflicts');
      console.log(chalk.cyan(`\n  Attempt 2: Using direct ${this.config.llmProvider} API to resolve ${remainingConflicts.length} remaining conflicts...`));
      
      const fs = await import('fs');
      
      for (const conflictFile of remainingConflicts) {
        // Skip lock files in case they slipped through
        if (isLockFile(conflictFile)) continue;
        
        const fullPath = join(this.workdir, conflictFile);
        
        try {
          // Read the conflicted file
          const conflictedContent = fs.readFileSync(fullPath, 'utf-8');
          
          // Check if it actually has conflict markers
          if (!conflictedContent.includes('<<<<<<<')) {
            console.log(chalk.gray(`    - ${conflictFile}: no conflict markers found`));
            continue;
          }
          
          console.log(chalk.cyan(`    Resolving: ${conflictFile}`));
          
          // Ask LLM to resolve
          const result = await this.llm.resolveConflict(
            conflictFile,
            conflictedContent,
            mergingBranch
          );
          
          if (result.resolved) {
            // Write the resolved content
            fs.writeFileSync(fullPath, result.content, 'utf-8');
            console.log(chalk.green(`    ✓ ${conflictFile}: ${result.explanation}`));
            
            // Stage the file
            await git.add(conflictFile);
          } else {
            console.log(chalk.red(`    ✗ ${conflictFile}: ${result.explanation}`));
          }
        } catch (e) {
          console.log(chalk.red(`    ✗ ${conflictFile}: Error - ${e}`));
        }
      }
      
      // Check again - both git status and file contents
      statusAfter = await git.status();
      gitConflicts = statusAfter.conflicted || [];
      markerConflicts = await findFilesWithConflictMarkers(this.workdir, codeFiles);
      remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
    }
    
    return {
      success: remainingConflicts.length === 0,
      remainingConflicts
    };
  }

  /**
   * Handle lock file conflicts by deleting and regenerating them.
   * 
   * WHY DELETE/REGENERATE: Lock files (bun.lock, package-lock.json, yarn.lock, etc.)
   * are auto-generated from manifests (package.json). Attempting to merge them is:
   * 1. Error-prone: LLMs don't understand the lock file format semantics
   * 2. Unnecessary: Fresh generation from manifest is deterministic and correct
   * 3. Safe: The manifest has already been merged, so regeneration gives correct result
   * 
   * WHY WHITELIST COMMANDS: Security. We're executing package managers with user-controlled
   * paths. Only known-safe commands are allowed to prevent arbitrary code execution.
   * 
   * WHY SPAWN WITHOUT SHELL: Prevents shell injection attacks. By using spawn() with
   * an args array instead of shell: true, special characters in paths can't be
   * interpreted as shell commands.
   * 
   * WHY DISABLE SCRIPTS: Package managers can run arbitrary scripts during install
   * (postinstall, preinstall, etc.). These scripts come from dependencies and could
   * be malicious. Disabling them makes lock file regeneration safe.
   * 
   * WHY TIMEOUT: Prevents resource exhaustion. A hung package manager should not
   * block prr indefinitely. 60 seconds is generous for a lock file regeneration.
   */
  private async handleLockFileConflicts(git: SimpleGit, lockFiles: string[]): Promise<void> {
    console.log(chalk.cyan('\n  Handling lock files...'));
    const { spawn } = await import('child_process');
    const fs = await import('fs');
    const path = await import('path');
    
    // Validate workdir using realpath to prevent symlink attacks
    // WHY: A malicious repo could create symlinks pointing outside the workdir
    let resolvedWorkdir: string;
    try {
      resolvedWorkdir = fs.realpathSync(this.workdir);
      const resolvedBase = fs.realpathSync(this.config.workdirBase);
      const relativeWorkdir = path.relative(resolvedBase, resolvedWorkdir);
      if (relativeWorkdir.startsWith('..') || path.isAbsolute(relativeWorkdir)) {
        throw new Error(`Workdir ${resolvedWorkdir} is outside base ${resolvedBase}`);
      }
    } catch (e) {
      console.log(chalk.red(`    ✗ Workdir validation failed: ${e}`));
      return;
    }
    
    // Whitelist of allowed package manager commands (command -> args)
    const ALLOWED_COMMANDS: Record<string, string[]> = {
      'bun install': ['bun', 'install'],
      'npm install': ['npm', 'install'],
      'yarn install': ['yarn', 'install'],
      'pnpm install': ['pnpm', 'install'],
      'cargo generate-lockfile': ['cargo', 'generate-lockfile'],
      'bundle install': ['bundle', 'install'],
      'poetry lock': ['poetry', 'lock'],
      'composer install': ['composer', 'install'],
    };
    
    // Minimal environment whitelist for package managers
    const ENV_WHITELIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 
                           'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT',
                           'NPM_TOKEN', 'YARN_ENABLE_IMMUTABLE_INSTALLS'];
    const safeEnv: Record<string, string> = {};
    for (const key of ENV_WHITELIST) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key]!;
      }
    }
    if (safeEnv.PATH) {
      const pathEntries = safeEnv.PATH.split(path.delimiter).filter(Boolean);
      const safePathEntries = pathEntries.filter((entry) => {
        if (!path.isAbsolute(entry)) {
          return false;
        }
        try {
          const resolvedEntry = fs.realpathSync(entry);
          return !(resolvedEntry === resolvedWorkdir || resolvedEntry.startsWith(resolvedWorkdir + path.sep));
        } catch {
          return false;
        }
      });
      safeEnv.PATH = safePathEntries.length > 0
        ? safePathEntries.join(path.delimiter)
        : '/usr/bin:/bin';
    }
    safeEnv.npm_config_ignore_scripts = 'true';
    safeEnv.YARN_ENABLE_SCRIPTS = '0';
    safeEnv.BUN_INSTALL_DISABLE_POSTINSTALL = '1';
    safeEnv.PNPM_DISABLE_SCRIPTS = 'true';
    
    // Group lock files by their regenerate command
    const regenerateCommands = new Set<string>();
    
    for (const lockFile of lockFiles) {
      const info = getLockFileInfo(lockFile);
      if (info) {
        if (!ALLOWED_COMMANDS[info.regenerateCmd]) {
          console.log(chalk.yellow(`    ⚠ Skipping ${lockFile}: command not allowed (${info.regenerateCmd})`));
          continue;
        }
        // Delete the lock file
        const fullPath = path.join(resolvedWorkdir, lockFile);
        // Verify the file path is still within workdir after join
        const resolvedFullPath = path.resolve(fullPath);
        const relativePath = path.relative(resolvedWorkdir, resolvedFullPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          console.log(chalk.yellow(`    ⚠ Skipping ${lockFile}: path traversal detected`));
          continue;
        }
        try {
          const realPath = fs.realpathSync(resolvedFullPath);
          const relativeRealPath = path.relative(resolvedWorkdir, realPath);
          if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath)) {
            console.log(chalk.yellow(`    ⚠ Skipping ${lockFile}: resolved outside workdir`));
            continue;
          }
          fs.unlinkSync(realPath);
          console.log(chalk.green(`    ✓ Deleted ${lockFile}`));
          regenerateCommands.add(info.regenerateCmd);
        } catch (e) {
          console.log(chalk.yellow(`    ⚠ Could not delete ${lockFile}: ${e}`));
        }
      }
    }
    
    // Run regenerate commands using spawn with validated args
    // Security: Only execute whitelisted commands with spawn (no shell)
    for (const cmd of regenerateCommands) {
      const cmdArgs = ALLOWED_COMMANDS[cmd];
      if (!cmdArgs) {
        console.log(chalk.yellow(`    ⚠ Skipping unknown command: ${cmd}`));
        continue;
      }
      
      const [executable, ...args] = cmdArgs;
      
      // Security: Verify executable is a simple name (no path components)
      // This ensures we use the system PATH lookup, not a potentially malicious local file
      if (executable.includes('/') || executable.includes('\\')) {
        console.log(chalk.yellow(`    ⚠ Skipping command with path in executable: ${executable}`));
        continue;
      }
      
      console.log(chalk.cyan(`    Running: ${cmd}`));
      
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(executable, args, {
            cwd: resolvedWorkdir,
            stdio: 'inherit',
            env: safeEnv,
            shell: false, // Never use shell - prevents shell injection
          });
          
          // Security: 60 second timeout prevents resource exhaustion
          const timeout = setTimeout(() => {
            proc.kill('SIGTERM');
            // Give process 5s to terminate gracefully, then SIGKILL
            setTimeout(() => proc.kill('SIGKILL'), 5000);
            reject(new Error('Timeout exceeded (60s)'));
          }, 60000);
          
          proc.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Exit code ${code}`));
            }
          });
          
          proc.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        console.log(chalk.green(`    ✓ ${cmd} completed`));
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ ${cmd} failed: ${e}, continuing...`));
      }
    }
    
    // Stage the regenerated lock files
    for (const lockFile of lockFiles) {
      try {
        await git.add(lockFile);
      } catch {
        // File might not exist if regenerate failed, ignore
      }
    }
  }

  /**
   * Parse fixer tool output to extract NO_CHANGES explanation.
   *
   * WHY: When the fixer makes zero changes, it MUST explain why.
   * This enables us to dismiss issues appropriately and document the reasoning.
   *
   * Two-stage parsing:
   * 1. Look for formal "NO_CHANGES: <explanation>" format
   * 2. Infer explanation from common patterns if no formal prefix
   *
   * WHY infer? LLMs don't always follow the exact format, but often explain
   * themselves in natural language. Capturing these explanations is better
   * than losing the information.
   */
  private parseNoChangesExplanation(output: string): string | null {
    if (!output) {
      return null;
    }

    // Stage 1: Look for formal "NO_CHANGES:" line
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/NO_CHANGES:\s*(.+)/i);
      if (match && match[1]) {
        const explanation = match[1].trim();
        if (explanation.length >= 20) {
          return explanation;
        }
      }
    }

    // Stage 2: Infer explanation from common patterns
    // WHY: LLMs often explain without using the exact format
    const inferPatterns = [
      // "already" patterns
      /(?:this|the|issue|code|fix|implementation)\s+(?:is\s+)?already\s+(?:fixed|implemented|handled|present|exists|correct)/i,
      /already\s+(?:has|have|contains?|includes?)\s+/i,
      // "exists" patterns  
      /(?:null\s+check|validation|handling|guard)\s+(?:already\s+)?exists/i,
      /(?:the\s+)?(?:code|implementation)\s+already\s+/i,
      // "no changes needed" patterns
      /no\s+(?:changes?|modifications?|updates?)\s+(?:are\s+)?(?:needed|required|necessary)/i,
      /(?:doesn't|does not|don't|do not)\s+(?:need|require)\s+(?:any\s+)?(?:changes?|fixes?)/i,
      // "correct as is" patterns
      /(?:code|implementation|current)\s+(?:is\s+)?(?:correct|fine|ok|appropriate)\s+(?:as\s+is|already)/i,
    ];

    // Look for sentences containing these patterns
    for (const pattern of inferPatterns) {
      const match = output.match(pattern);
      if (match) {
        // Extract the sentence containing the match
        const sentenceMatch = output.match(new RegExp(`[^.!?]*${pattern.source}[^.!?]*[.!?]?`, 'i'));
        if (sentenceMatch && sentenceMatch[0].length >= 20) {
          return `(inferred) ${sentenceMatch[0].trim()}`;
        }
      }
    }

    return null;
  }

  /**
   * Sanitize tool output for debug logging.
   * WHY: Raw JSON output from tools is ugly and unhelpful in logs.
   */
  private sanitizeOutputForLog(output: string | undefined, maxLength: number = 500): string {
    if (!output) return '(no output)';
    
    // If it looks like JSON, try to extract just the message/content
    if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
      try {
        // Try to parse and extract meaningful content
        const lines = output.split('\n').filter(line => {
          const trimmed = line.trim();
          // Skip lines that are pure JSON structure
          return !trimmed.startsWith('{') && 
                 !trimmed.startsWith('}') && 
                 !trimmed.startsWith('[') &&
                 !trimmed.startsWith(']') &&
                 !trimmed.startsWith('"type"') &&
                 !trimmed.startsWith('"subtype"') &&
                 trimmed.length > 0;
        });
        if (lines.length > 0) {
          return lines.slice(0, 10).join('\n').substring(0, maxLength);
        }
      } catch {
        // Fall through to default handling
      }
      return '(JSON output - see verbose logs)';
    }
    
    return output.substring(0, maxLength) + (output.length > maxLength ? '...' : '');
  }

  /**
   * Validate that an explanation is meaningful enough to justify dismissing an issue.
   *
   * WHY: We can ONLY dismiss an issue if we have a clear, documented reason.
   * Without a proper explanation, we can't create the generator-judge feedback loop.
   * If validation fails, we must treat it as a bug/error and NOT dismiss.
   */
  private validateDismissalExplanation(explanation: string, commentPath: string, commentLine: number | null): boolean {
    const MIN_EXPLANATION_LENGTH = 20; // Minimum characters for a meaningful explanation

    if (!explanation || explanation.trim().length === 0) {
      warn(`No explanation provided for dismissing ${commentPath}:${commentLine || '?'} - treating as unresolved`);
      return false;
    }

    if (explanation.length < MIN_EXPLANATION_LENGTH) {
      warn(`Explanation too short (${explanation.length} chars) for ${commentPath}:${commentLine || '?'}: "${explanation}" - treating as unresolved`);
      return false;
    }

    // Check for vague/useless explanations
    const vague = ['fixed', 'done', 'looks good', 'ok', 'resolved', 'already handled'];
    const lower = explanation.toLowerCase();
    if (vague.some(v => lower === v || lower === v + '.')) {
      warn(`Vague explanation for ${commentPath}:${commentLine || '?'}: "${explanation}" - treating as unresolved`);
      return false;
    }

    return true;
  }

  private async findUnresolvedIssues(comments: ReviewComment[], totalCount: number): Promise<UnresolvedIssue[]> {
    const unresolved: UnresolvedIssue[] = [];
    let alreadyResolved = 0;
    let skippedCache = 0;
    let staleRecheck = 0;

    // Verification expiry: re-check issues verified more than 5 iterations ago
    const VERIFICATION_EXPIRY_ITERATIONS = 5;
    const staleVerifications = this.stateManager.getStaleVerifications(VERIFICATION_EXPIRY_ITERATIONS);
    
    // First pass: filter out already-verified issues and gather code snippets
    const toCheck: Array<{
      comment: ReviewComment;
      codeSnippet: string;
    }> = [];

    for (const comment of comments) {
      const isStale = staleVerifications.includes(comment.id);
      
      // If --reverify flag is set, ignore the cache and re-check everything
      if (!this.options.reverify && !isStale && this.stateManager.isCommentVerifiedFixed(comment.id)) {
        alreadyResolved++;
        continue;
      }
      
      if (this.options.reverify && this.stateManager.isCommentVerifiedFixed(comment.id)) {
        skippedCache++;
      }
      
      if (isStale) {
        staleRecheck++;
      }

      const codeSnippet = await this.getCodeSnippet(comment.path, comment.line, comment.body);
      toCheck.push({ comment, codeSnippet });
    }

    if (this.options.reverify && skippedCache > 0) {
      console.log(chalk.yellow(`  --reverify: Re-checking ${skippedCache} previously cached as "fixed"`));
    } else if (alreadyResolved > 0) {
      console.log(chalk.gray(`  ${alreadyResolved} already verified as fixed (cached)`));
    }
    
    if (staleRecheck > 0) {
      console.log(chalk.yellow(`  ${staleRecheck} stale verifications (>${VERIFICATION_EXPIRY_ITERATIONS} iterations old) - re-checking`));
    }

    if (toCheck.length === 0) {
      return [];
    }

    if (this.options.noBatch) {
      // Sequential mode - one LLM call per comment
      console.log(chalk.gray(`  Analyzing ${toCheck.length} comments sequentially...`));
      
      for (let i = 0; i < toCheck.length; i++) {
        const { comment, codeSnippet } = toCheck[i];
        console.log(chalk.gray(`    [${i + 1}/${toCheck.length}] ${comment.path}:${comment.line || '?'}`));
        
        const result = await this.llm.checkIssueExists(
          comment.body,
          comment.path,
          comment.line,
          codeSnippet
        );
        
        if (result.exists) {
          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: result.explanation,
          });
        } else {
          // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
          if (this.validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
            // Valid explanation - document why it doesn't need fixing
            this.stateManager.markCommentVerifiedFixed(comment.id);
            this.stateManager.addDismissedIssue(
              comment.id,
              result.explanation,
              'already-fixed',
              comment.path,
              comment.line,
              comment.body
            );
          } else {
            // Invalid/missing explanation - treat as unresolved (potential bug)
            warn(`Cannot dismiss without valid explanation - marking as unresolved`);
            unresolved.push({
              comment,
              codeSnippet,
              stillExists: true,
              explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
            });
          }
        }
      }
    } else {
      // Batch mode - one LLM call for all comments
      console.log(chalk.gray(`  Batch analyzing ${toCheck.length} comments with LLM...`));
      
      const batchInput = toCheck.map((item, index) => {
        const issueId = `issue_${index + 1}`;
        return {
          id: issueId,
          comment: item.comment.body,
          filePath: item.comment.path,
          line: item.comment.line,
          codeSnippet: item.codeSnippet,
        };
      });

      // Build model context for smart model selection (unless --model-rotation is set)
      let modelContext: ModelRecommendationContext | undefined;
      if (!this.options.modelRotation) {
        const availableModels = this.getModelsForRunner(this.runner);
        modelContext = {
          availableModels,
          modelHistory: this.stateManager.getModelHistorySummary?.() || undefined,
          attemptHistory: undefined,  // TODO: Track per-issue attempts
        };
      }

      const batchResult = await this.llm.batchCheckIssuesExist(batchInput, modelContext);
      const results = batchResult.issues;
      debug('Batch analysis results', { count: results.size });
      
      // Store model recommendation for use in fix loop
      if (batchResult.recommendedModels?.length) {
        this.recommendedModels = batchResult.recommendedModels;
        this.recommendedModelIndex = 0;
        this.modelRecommendationReasoning = batchResult.modelRecommendationReasoning;
        console.log(chalk.cyan(`  📊 Model recommendation: ${this.recommendedModels.join(', ')}`));
        if (this.modelRecommendationReasoning) {
          console.log(chalk.gray(`     (${this.modelRecommendationReasoning})`));
        }
      }

      // Process results
      for (let i = 0; i < toCheck.length; i++) {
        const { comment, codeSnippet } = toCheck[i];
        const issueId = batchInput[i].id.toLowerCase();
        const result = results.get(issueId);

        if (!result) {
          // If LLM didn't return a result for this, assume it still exists
          warn(`No result for comment ${issueId}, assuming unresolved`);
          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'Unable to determine status',
          });
          continue;
        }

        if (result.exists) {
          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: result.explanation,
          });
        } else {
          // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
          if (this.validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
            // Valid explanation - document why it doesn't need fixing
            this.stateManager.markCommentVerifiedFixed(comment.id);
            this.stateManager.addDismissedIssue(
              comment.id,
              result.explanation,
              'already-fixed',
              comment.path,
              comment.line,
              comment.body
            );
          } else {
            // Invalid/missing explanation - treat as unresolved (potential bug)
            warn(`Cannot dismiss without valid explanation - marking as unresolved`);
            unresolved.push({
              comment,
              codeSnippet,
              stillExists: true,
              explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
            });
          }
        }
      }
    }

    await this.stateManager.save();
    await this.lessonsManager.save();
    return unresolved;
  }

  private async getCodeSnippet(path: string, line: number | null, commentBody?: string): Promise<string> {
    try {
      const filePath = join(this.workdir, path);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Try to extract line range from comment body (bugbot format)
      // <!-- LOCATIONS START
      // packages/rust/src/runtime.rs#L1743-L1781
      // LOCATIONS END -->
      let startLine = line;
      let endLine = line;
      
      if (commentBody) {
        const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
        if (locationsMatch) {
          const locationLines = locationsMatch[1].trim().split('\n');
          for (const loc of locationLines) {
            // Match: file.ext#L123-L456 or file.ext#L123
            const lineMatch = loc.match(/#L(\d+)(?:-L(\d+))?/);
            if (lineMatch) {
              startLine = parseInt(lineMatch[1], 10);
              endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : startLine + 20;
              debug('Extracted line range from comment', { startLine, endLine, loc });
              break;
            }
          }
        }
      }

      if (startLine === null) {
        // Return first 50 lines if no specific line
        return lines.slice(0, 50).join('\n');
      }

      // Return code from startLine to endLine (with some context)
      const contextBefore = 5;
      const contextAfter = 10;
      const start = Math.max(0, startLine - contextBefore - 1); // -1 for 0-indexed
      const end = Math.min(lines.length, (endLine || startLine) + contextAfter);
      
      return lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n');
    } catch {
      return '(file not found or unreadable)';
    }
  }

  private printUnresolvedIssues(issues: UnresolvedIssue[]): void {
    console.log(chalk.blue('\n=== Unresolved Issues (Dry Run) ===\n'));

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      console.log(chalk.yellow(`Issue ${i + 1}: ${issue.comment.path}:${issue.comment.line || '?'}`));
      console.log(chalk.gray('Comment:'), issue.comment.body.substring(0, 200));
      console.log(chalk.gray('Analysis:'), issue.explanation);
      console.log('');
    }
  }

  /**
   * Calculate when we expect bot reviews to arrive based on last commit time.
   * 
   * WHY: Instead of blocking/waiting for bot reviews, we can work on existing
   * issues and check for new reviews when we expect them to be ready.
   * 
   * @param lastCommitTime When the last commit was made
   * @returns Expected time when bot reviews should be available
   */
  private calculateExpectedBotResponseTime(lastCommitTime: Date): Date | null {
    if (this.botTimings.length === 0) {
      // No timing data - can't predict
      return null;
    }
    
    // Use average response time + 20% buffer
    const avgResponseMs = Math.round(
      this.botTimings.reduce((sum, t) => sum + t.avgResponseMs, 0) / this.botTimings.length
    );
    const bufferMs = Math.ceil(avgResponseMs * 0.2);
    const expectedMs = avgResponseMs + bufferMs;
    
    return new Date(lastCommitTime.getTime() + expectedMs);
  }

  /**
   * Check if it's time to re-fetch PR comments for new bot reviews.
   * Returns true if we should check for new comments.
   */
  private shouldCheckForNewComments(): boolean {
    if (!this.expectedBotResponseTime) {
      return false;
    }
    
    const now = new Date();
    return now >= this.expectedBotResponseTime;
  }

  /**
   * Check for new comments and integrate them into the workflow.
   * 
   * WHY: Bots may post new reviews while we're working on existing issues.
   * Instead of waiting, we work and periodically pull in new issues.
   * 
   * @returns Array of new issues to add to the workflow, or null if no new comments
   */
  private async checkForNewBotReviews(
    owner: string,
    repo: string,
    prNumber: number,
    existingCommentIds: Set<string>
  ): Promise<{ newComments: ReviewComment[]; message: string } | null> {
    if (!this.shouldCheckForNewComments()) {
      return null;
    }
    
    debug('Checking for new bot reviews (expected time reached)');
    
    try {
      const freshComments = await this.github.getReviewComments(owner, repo, prNumber);
      const newComments = freshComments.filter(c => !existingCommentIds.has(c.id));
      
      // Update last fetch time
      this.lastCommentFetchTime = new Date();
      
      if (newComments.length > 0) {
        // Calculate next expected response time (in case more reviews coming)
        // Use max observed + buffer for the next check
        if (this.botTimings.length > 0) {
          const maxResponseMs = Math.max(...this.botTimings.map(t => t.maxResponseMs));
          this.expectedBotResponseTime = new Date(Date.now() + maxResponseMs);
        } else {
          this.expectedBotResponseTime = null;  // No more predictions
        }
        
        return {
          newComments,
          message: `Found ${newComments.length} new review comment(s) from bots`,
        };
      } else {
        // No new comments - push expected time back
        // Check again in 30 seconds
        this.expectedBotResponseTime = new Date(Date.now() + 30 * 1000);
        return null;
      }
    } catch (err) {
      debug('Failed to check for new comments', { error: err });
      // On error, try again in 30 seconds
      this.expectedBotResponseTime = new Date(Date.now() + 30 * 1000);
      return null;
    }
  }

  /**
   * Calculate smart wait time after pushing based on observed bot response times.
   * 
   * WHY: Instead of a fixed poll interval, we use actual observed data:
   * 1. Bot response timing (min/avg/max from earlier commits on this PR)
   * 2. PR status (are bots actively reviewing? are checks running?)
   * 
   * This avoids both:
   * - Waiting too long when bots are fast
   * - Not waiting long enough and missing reviews
   * 
   * Returns recommended wait time in seconds.
   */
  private async calculateSmartWaitTime(
    owner: string, 
    repo: string, 
    prNumber: number,
    headSha: string
  ): Promise<{ waitSeconds: number; reason: string }> {
    const defaultWait = this.options.pollInterval;
    
    // Check PR status to see what's pending
    let prStatus: PRStatus | undefined;
    try {
      prStatus = await this.github.getPRStatus(owner, repo, prNumber, headSha);
    } catch (err) {
      debug('Could not fetch PR status for smart wait', { error: err });
    }
    
    // If bots are actively reviewing (eyes reaction or in-progress), wait longer
    const activelyReviewing = (prStatus?.activelyReviewingBots?.length ?? 0) > 0 || 
                               (prStatus?.botsWithEyesReaction?.length ?? 0) > 0;
    
    // If checks are running, factor that in too
    const checksRunning = (prStatus?.inProgressChecks?.length ?? 0) > 0 ||
                          (prStatus?.pendingChecks?.length ?? 0) > 0;
    
    // Use bot timing data if available
    if (this.botTimings.length > 0) {
      // Use max observed + 20% buffer for safety
      const maxObserved = Math.max(...this.botTimings.map(t => t.maxResponseMs));
      const avgObserved = Math.round(
        this.botTimings.reduce((sum, t) => sum + t.avgResponseMs, 0) / this.botTimings.length
      );
      
      // If actively reviewing, use max + buffer
      // Otherwise use average + smaller buffer
      let waitMs: number;
      let reason: string;
      
      if (activelyReviewing) {
        waitMs = Math.ceil(maxObserved * 1.2);  // Max + 20% buffer
        reason = `bot actively reviewing (max observed: ${formatDuration(maxObserved)})`;
      } else if (checksRunning) {
        waitMs = Math.ceil((avgObserved + maxObserved) / 2);  // Midpoint of avg and max
        reason = `CI checks running (avg: ${formatDuration(avgObserved)})`;
      } else {
        waitMs = Math.ceil(avgObserved * 1.1);  // Avg + 10% buffer
        reason = `based on avg response time (${formatDuration(avgObserved)})`;
      }
      
      // Clamp to reasonable bounds (min 30s, max 5 min)
      const minWaitMs = 30 * 1000;
      const maxWaitMs = 5 * 60 * 1000;
      waitMs = Math.max(minWaitMs, Math.min(maxWaitMs, waitMs));
      
      return { waitSeconds: Math.ceil(waitMs / 1000), reason };
    }
    
    // No timing data - use status-based heuristics
    if (activelyReviewing) {
      return { waitSeconds: Math.max(defaultWait, 90), reason: 'bot actively reviewing (no timing data)' };
    }
    
    if (checksRunning) {
      return { waitSeconds: Math.max(defaultWait, 60), reason: 'CI checks running (no timing data)' };
    }
    
    // Default: use configured poll interval
    return { waitSeconds: defaultWait, reason: 'default poll interval (no timing data)' };
  }

  /**
   * Wait for bot reviews after push with smart timing and progress feedback.
   */
  private async waitForBotReviews(
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string
  ): Promise<void> {
    const { waitSeconds, reason } = await this.calculateSmartWaitTime(owner, repo, prNumber, headSha);
    
    console.log(chalk.gray(`\nWaiting ${waitSeconds}s for re-review (${reason})...`));
    
    // Show countdown with periodic status checks
    const checkInterval = 15;  // Check every 15 seconds
    let remaining = waitSeconds;
    
    while (remaining > 0) {
      const sleepTime = Math.min(remaining, checkInterval);
      await this.sleep(sleepTime * 1000);
      remaining -= sleepTime;
      
      if (remaining > 0 && remaining % 30 === 0) {
        // Every 30s, check if bot has responded early
        try {
          const status = await this.github.getPRStatus(owner, repo, prNumber, headSha);
          const stillActive = (status.activelyReviewingBots?.length ?? 0) > 0 ||
                              (status.botsWithEyesReaction?.length ?? 0) > 0;
          
          if (!stillActive && status.ciState !== 'pending') {
            console.log(chalk.green('  Bot reviews appear complete, proceeding...'));
            return;
          } else {
            console.log(chalk.gray(`  Still waiting... (${remaining}s remaining)`));
          }
        } catch {
          // Ignore status check errors during wait
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
