import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'fs/promises';
import { join } from 'path';

import type { Config } from './config.js';
import type { CLIOptions } from './cli.js';
import type { ReviewComment, PRInfo } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from './runners/types.js';

import { GitHubAPI } from './github/api.js';
import { parsePRUrl } from './github/types.js';
import { LLMClient } from './llm/client.js';
import { StateManager } from './state/manager.js';
import { LessonsManager } from './state/lessons.js';
import { buildFixPrompt } from './analyzer/prompt-builder.js';
import { getWorkdirInfo, ensureWorkdir, cleanupWorkdir } from './git/workdir.js';
import { cloneOrUpdate, getChangedFiles, getDiffForFile, hasChanges, checkForConflicts, pullLatest, abortMerge, mergeBaseBranch, startMergeForConflictResolution, markConflictsResolved, completeMerge, isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from './git/clone.js';
import type { SimpleGit } from 'simple-git';
import { squashCommit, pushWithRetry } from './git/commit.js';
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
   * Get the list of models available for a runner
   */
  private getModelsForRunner(runner: Runner): string[] {
    // Use runner's own list if provided, otherwise use defaults
    return runner.supportedModels || DEFAULT_MODEL_ROTATIONS[runner.name] || [];
  }

  /**
   * Get the current model for the active runner
   * Returns undefined if using CLI default or user-specified model
   */
  private getCurrentModel(): string | undefined {
    // If user specified a model via CLI, always use that
    if (this.options.toolModel) {
      return this.options.toolModel;
    }
    
    const models = this.getModelsForRunner(this.runner);
    if (models.length === 0) {
      return undefined;  // Let the tool use its default
    }
    
    const index = this.modelIndices.get(this.runner.name) || 0;
    return models[index];
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
      
      // All tools exhausted - reset all model indices and start fresh round
      if (exhaustedTools.size >= this.runners.length) {
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
    
    // Try rotating model within current tool
    if (this.rotateModel()) {
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
      
      // All tools exhausted - reset and start fresh
      console.log(chalk.yellow('\n  All tools exhausted their models, starting fresh round...'));
      for (const runner of this.runners) {
        this.modelIndices.set(runner.name, 0);
        this.stateManager.setModelIndex(runner.name, 0);
      }
      this.modelsTriedThisToolRound = 0;
      return true;
    }
    
    // Only one tool and it's exhausted - reset it
    const models = this.getModelsForRunner(this.runner);
    if (models.length > 0) {
      console.log(chalk.yellow('\n  Tool exhausted, restarting model rotation...'));
      this.modelIndices.set(this.runner.name, 0);
      this.stateManager.setModelIndex(this.runner.name, 0);
      this.modelsTriedThisToolRound = 0;
      return true;
    }
    
    return false;
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
          console.log(chalk.gray(`    - No changes made (tool may not understand the task)`));
          debug('Fixer made no changes', {
            targetFile: issue.comment.path,
            targetLine: issue.comment.line,
            issueComment: issue.comment.body.substring(0, 300),
            codeSnippet: issue.codeSnippet?.substring(0, 300),
            promptSent: focusedPrompt.substring(0, 500) + '...',
            toolOutput: result.output?.substring(0, 1000),
            toolError: result.error,
          });
          // Add lesson about the failed attempt
          this.lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - tool made no changes, may need clearer instructions`);
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

  private async tryDirectLLMFix(issues: UnresolvedIssue[]): Promise<boolean> {
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
            console.log(chalk.green(`    ✓ Fixed: ${issue.comment.path}`));
            anyFixed = true;
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
      this.lessonsManager = new LessonsManager(owner, repo, this.prInfo.branch);
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

      // Check for conflicts and sync with remote
      debugStep('CHECKING FOR CONFLICTS');
      spinner.start('Checking for conflicts with remote...');
      const conflictStatus = await checkForConflicts(git, this.prInfo.branch);
      spinner.stop();

      if (conflictStatus.hasConflicts) {
        console.log(chalk.red('✗ Merge conflicts detected!'));
        console.log(chalk.red('  Conflicted files:'));
        for (const file of conflictStatus.conflictedFiles) {
          console.log(chalk.red(`    - ${file}`));
        }
        console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
        await abortMerge(git);
        return;
      }

      if (conflictStatus.behindBy > 0) {
        console.log(chalk.yellow(`⚠ Branch is ${conflictStatus.behindBy} commits behind remote`));
        spinner.start('Pulling latest changes...');
        const pullResult = await pullLatest(git, this.prInfo.branch);
        
        if (!pullResult.success) {
          spinner.fail('Failed to pull');
          console.log(chalk.red(`  Error: ${pullResult.error}`));
          if (pullResult.error?.includes('conflict')) {
            console.log(chalk.yellow('  Please resolve conflicts manually before running prr.'));
            await abortMerge(git);
          }
          return;
        }
        
        if (pullResult.stashConflicts && pullResult.stashConflicts.length > 0) {
          spinner.warn('Pulled with stash conflicts');
          console.log(chalk.yellow(`  Your previous changes conflict with remote updates in: ${pullResult.stashConflicts.join(', ')}`));
          console.log(chalk.yellow('  Resolve conflicts and commit, then re-run prr.'));
          return;
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
        startTimer('Resolve conflicts');
        console.log(chalk.yellow(`⚠ PR has conflicts with ${this.prInfo.baseBranch}`));
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
              console.log(chalk.cyan('\n  Handling lock files...'));
              const { spawn } = await import('child_process');
              const fs = await import('fs');
              const path = await import('path');
              
              // Validate workdir using realpath to prevent symlink attacks
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
            
            // Handle code files with LLM tools
            if (codeFiles.length > 0) {
              // Build prompt for conflict resolution (only non-lock files)
              const conflictPrompt = this.buildConflictResolutionPrompt(codeFiles, this.prInfo.baseBranch);
              
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
                    this.prInfo.baseBranch
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
            
            // Final check
            if (remainingConflicts.length > 0) {
              console.log(chalk.yellow('\n⚠ Could not resolve all merge conflicts automatically'));
              console.log(chalk.yellow('  Remaining conflicts:'));
              for (const file of remainingConflicts) {
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
            
            // Check if we have uncommitted changes that need to be committed
            if (await hasChanges(git)) {
              debugStep('COMMIT PHASE (all resolved)');
              
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
          break;
        }

        // Skip fix loop if there are no issues to fix
        // WHY: After final audit passes or all issues are resolved, we shouldn't
        // run the fixer with an empty prompt - it wastes time and may cause errors
        if (unresolvedIssues.length === 0) {
          debug('No unresolved issues - skipping fix loop');
          console.log(chalk.green('\n✓ All issues resolved - nothing to fix'));
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

        while (fixIteration < maxFixIterations && !allFixed) {
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
                break;
              }
              // Continue with the re-populated list
              console.log(chalk.yellow(`→ Continuing with ${unresolvedIssues.length} issues`));
            } else {
              debug('No issues to fix at start of iteration - breaking');
              console.log(chalk.green('\n✓ All issues resolved'));
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
            console.log(chalk.yellow('  Lessons learned (by scope):'));
            
            if (allLessons.global.length > 0) {
              console.log(chalk.gray('    Global:'));
              for (const lesson of allLessons.global.slice(-5)) {
                console.log(chalk.gray(`      • ${lesson.substring(0, 100)}...`));
              }
            }
            
            for (const filePath of affectedFiles) {
              const fileLessons = allLessons.files[filePath];
              if (fileLessons && fileLessons.length > 0) {
                console.log(chalk.gray(`    ${filePath}:`));
                for (const lesson of fileLessons.slice(-3)) {
                  console.log(chalk.gray(`      • ${lesson.substring(0, 100)}...`));
                }
              }
            }
            console.log('');
          }
          
          debug('Fix prompt length', prompt.length);
          debug('Lessons learned count', lessonsIncluded);

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
          const result = await this.runner.run(this.workdir, prompt, { model: this.getCurrentModel() });
          const fixerTime = endTimer('Run fixer');
          debug('Runner result', { success: result.success, error: result.error, duration: fixerTime });

          if (!result.success) {
            console.log(chalk.red(`\n${this.runner.name} failed (${formatDuration(fixerTime)}):`, result.error));
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
            this.lessonsManager.addGlobalLesson(`${this.runner.name}${currentModel ? ` with ${currentModel}` : ''} made no changes - trying different approach`);
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
              }
            } else if (!isOddFailure) {
              // Try rotating model or tool
              if (this.tryRotation()) {
                console.log(chalk.cyan('  Starting fresh with batch mode...'));
              } else {
                // All models and tools exhausted
                console.log(chalk.yellow('\n  🧠 All tools/models exhausted, trying direct LLM API fix...'));
                const directFixed = await this.tryDirectLLMFix(unresolvedIssues);
                if (directFixed) {
                  this.consecutiveFailures = 0;
                  this.modelFailuresInCycle = 0;
                }
              }
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

          // Mark unchanged files as failed immediately
          for (const issue of unchangedIssues) {
            this.stateManager.addVerificationResult(issue.comment.id, {
              passed: false,
              reason: 'File was not modified',
            });
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

          // Check if all fixed
          allFixed = failedCount === 0;

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
                }
              }
              else if (!isOddFailure) {
                // Even failure = single-issue also failed, try rotation
                if (this.tryRotation()) {
                  console.log(chalk.cyan('  Starting fresh with batch mode...'));
                } else {
                  // All models and tools exhausted, try direct LLM as last resort
                  console.log(chalk.yellow('\n  🧠 All tools/models exhausted, trying direct LLM API fix...'));
                  const directFixed = await this.tryDirectLLMFix(unresolvedIssues);
                  if (directFixed) {
                    this.consecutiveFailures = 0;
                    this.modelFailuresInCycle = 0;
                  }
                }
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
        }

        // Commit changes if we have any
        debugStep('COMMIT PHASE');
        if (await hasChanges(git)) {
          const fixedIssues = comments
            .filter((comment) => this.stateManager.isCommentVerifiedFixed(comment.id))
            .map((comment) => ({
              filePath: comment.path,
              comment: comment.body,
            }));

          if (this.options.noCommit) {
            warn('NO-COMMIT MODE: Skipping commit. Changes are in workdir.');
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
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
            });
            spinner.succeed('Pushed to remote');

            // Check CodeRabbit status and trigger if needed
            // WHY: Some repos configure CodeRabbit to require manual trigger (@coderabbitai review)
            // We check if it has reviewed the current commit and trigger only if needed
            try {
              spinner.start('Checking CodeRabbit status...');
              
              // Get the latest HEAD sha after push
              const latestPR = await this.github.getPRInfo(owner, repo, number);
              
              const result = await this.github.triggerCodeRabbitIfNeeded(
                owner, repo, number, this.prInfo.branch, latestPR.headSha
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

            // Wait for re-review
            if (pushIteration < maxPushIterations) {
              console.log(chalk.gray(`\nWaiting ${this.options.pollInterval}s for re-review...`));
              await this.sleep(this.options.pollInterval * 1000);
            }
          } else if (this.options.noPush) {
            warn('NO-PUSH MODE: Changes committed locally but not pushed.');
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
            break;
          } else {
            console.log(chalk.blue('\nChanges committed locally. Use --auto-push to push automatically.'));
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
            break;
          }
        } else {
          console.log(chalk.yellow('\nNo changes to commit'));
          debug('Git status shows no changes');
          break;
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

  private async setupRunner(): Promise<Runner> {
    // Auto-detect all available and ready runners
    const detected = await detectAvailableRunners(this.options.verbose);
    
    if (detected.length === 0) {
      throw new Error('No fix tools available! Install one of: cursor, claude-code, aider, opencode, codex, llm-api');
    }

    // Print summary
    printRunnerSummary(detected);

    // Find preferred runner or use first available
    let primaryRunner: Runner;
    
    if (this.options.tool) {
      const preferred = detected.find(d => d.runner.name === this.options.tool);
      if (preferred) {
        primaryRunner = preferred.runner;
      } else {
        // Check if it exists but isn't ready
        const runner = getRunnerByName(this.options.tool);
        if (runner) {
          const status = await runner.checkStatus();
          if (status.installed && !status.ready) {
            warn(`${runner.displayName} is installed but not ready: ${status.error}`);
          } else {
            warn(`${this.options.tool} not available, using ${detected[0].runner.displayName}`);
          }
        }
        primaryRunner = detected[0].runner;
      }
    } else {
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
          this.stateManager.markCommentVerifiedFixed(comment.id);
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

      const results = await this.llm.batchCheckIssuesExist(batchInput);
      debug('Batch analysis results', { count: results.size });

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
          // Mark as fixed in state
          this.stateManager.markCommentVerifiedFixed(comment.id);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
