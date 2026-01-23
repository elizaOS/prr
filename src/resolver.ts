import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'fs/promises';
import { join } from 'path';

import type { Config } from './config.js';
import type { CLIOptions } from './cli.js';
import type { BotComment, PRInfo } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from './runners/types.js';

import { GitHubAPI } from './github/api.js';
import { parsePRUrl } from './github/types.js';
import { LLMClient } from './llm/client.js';
import { StateManager } from './state/manager.js';
import { buildFixPrompt } from './analyzer/prompt-builder.js';
import { getWorkdirInfo, ensureWorkdir, cleanupWorkdir } from './git/workdir.js';
import { cloneOrUpdate, getChangedFiles, getDiffForFile, hasChanges } from './git/clone.js';
import { squashCommit, push, buildCommitMessage } from './git/commit.js';
import { CursorRunner } from './runners/cursor.js';
import { OpencodeRunner } from './runners/opencode.js';

export class PRResolver {
  private config: Config;
  private options: CLIOptions;
  private github: GitHubAPI;
  private llm: LLMClient;
  private stateManager!: StateManager;
  private runner!: Runner;
  private prInfo!: PRInfo;
  private workdir!: string;

  constructor(config: Config, options: CLIOptions) {
    this.config = config;
    this.options = options;
    this.github = new GitHubAPI(config.githubToken, config.botUsers);
    this.llm = new LLMClient(config);
  }

  async run(prUrl: string): Promise<void> {
    const spinner = ora();

    try {
      // Parse PR URL
      const { owner, repo, number } = parsePRUrl(prUrl);
      console.log(chalk.blue(`\nProcessing PR: ${owner}/${repo}#${number}\n`));

      // Get PR info
      spinner.start('Fetching PR information...');
      this.prInfo = await this.github.getPRInfo(owner, repo, number);
      spinner.succeed(`PR branch: ${this.prInfo.branch}`);

      // Setup workdir
      const workdirInfo = getWorkdirInfo(this.config.workdirBase, owner, repo, number);
      this.workdir = workdirInfo.path;
      
      if (workdirInfo.exists) {
        console.log(chalk.gray(`Reusing existing workdir: ${this.workdir}`));
      } else {
        console.log(chalk.gray(`Creating workdir: ${this.workdir}`));
      }

      await ensureWorkdir(this.workdir);

      // Initialize state manager
      this.stateManager = new StateManager(this.workdir);
      await this.stateManager.load(`${owner}/${repo}#${number}`, this.prInfo.branch);

      // Setup runner
      this.runner = await this.setupRunner();

      // Clone or update repo
      spinner.start('Setting up repository...');
      const { git } = await cloneOrUpdate(
        this.prInfo.cloneUrl,
        this.prInfo.branch,
        this.workdir,
        this.config.githubToken
      );
      spinner.succeed('Repository ready');

      // Main loop
      let pushIteration = 0;
      const maxPushIterations = this.options.autoPush ? this.options.maxPushIterations : 1;

      while (pushIteration < maxPushIterations) {
        pushIteration++;
        
        if (this.options.autoPush && pushIteration > 1) {
          console.log(chalk.blue(`\n--- Push iteration ${pushIteration}/${maxPushIterations} ---\n`));
        }

        // Fetch bot comments
        spinner.start('Fetching LLM review bot comments...');
        const comments = await this.github.getBotComments(owner, repo, number);
        spinner.succeed(`Found ${comments.length} bot comments`);

        if (comments.length === 0) {
          console.log(chalk.green('\nNo LLM review bot comments found. Nothing to do!'));
          break;
        }

        // Check which issues still exist
        spinner.start('Analyzing which issues still exist...');
        const unresolvedIssues = await this.findUnresolvedIssues(comments);
        spinner.succeed(`Found ${unresolvedIssues.length} unresolved issues`);

        if (unresolvedIssues.length === 0) {
          console.log(chalk.green('\nAll issues have been resolved!'));
          break;
        }

        // Dry run - just show issues
        if (this.options.dryRun) {
          this.printUnresolvedIssues(unresolvedIssues);
          break;
        }

        // Inner fix loop
        let fixIteration = 0;
        let allFixed = false;

        while (fixIteration < this.options.maxFixIterations && !allFixed) {
          fixIteration++;
          console.log(chalk.blue(`\n--- Fix iteration ${fixIteration}/${this.options.maxFixIterations} ---\n`));

          // Start new iteration in state
          this.stateManager.startIteration();

          // Build fix prompt
          const { prompt, issues } = buildFixPrompt(
            unresolvedIssues,
            this.stateManager.getLessons()
          );

          console.log(chalk.gray('Generated fix prompt with', issues.length, 'issues'));

          // Run fixer tool
          spinner.start(`Running ${this.runner.name} to fix issues...`);
          spinner.stop();
          
          const result = await this.runner.run(this.workdir, prompt);

          if (!result.success) {
            console.log(chalk.red(`\n${this.runner.name} failed:`, result.error));
            this.stateManager.addLesson(`${this.runner.name} failed: ${result.error}`);
            await this.stateManager.save();
            continue;
          }

          // Check for changes
          if (!(await hasChanges(git))) {
            console.log(chalk.yellow('\nNo changes made by fixer tool'));
            this.stateManager.addLesson('Fixer tool made no changes - issue may require manual intervention');
            await this.stateManager.save();
            break;
          }

          // Verify fixes
          spinner.start('Verifying fixes...');
          const changedFiles = await getChangedFiles(git);
          let verifiedCount = 0;
          let failedCount = 0;

          for (const issue of unresolvedIssues) {
            if (!changedFiles.includes(issue.comment.path)) {
              // File not changed, issue not addressed
              this.stateManager.addVerificationResult(issue.comment.id, {
                passed: false,
                reason: 'File was not modified',
              });
              failedCount++;
              continue;
            }

            // Get diff for this file
            const diff = await getDiffForFile(git, issue.comment.path);
            
            // Verify with LLM
            const verification = await this.llm.verifyFix(
              issue.comment.body,
              issue.comment.path,
              diff
            );

            this.stateManager.addVerificationResult(issue.comment.id, {
              passed: verification.fixed,
              reason: verification.explanation,
            });

            if (verification.fixed) {
              verifiedCount++;
              this.stateManager.markCommentVerifiedFixed(issue.comment.id);
              this.stateManager.addCommentToIteration(issue.comment.id);
            } else {
              failedCount++;
              this.stateManager.addLesson(
                `Fix for ${issue.comment.path}:${issue.comment.line} rejected: ${verification.explanation}`
              );
            }
          }

          spinner.succeed(`Verified: ${verifiedCount} fixed, ${failedCount} remaining`);
          await this.stateManager.save();

          // Check if all fixed
          allFixed = failedCount === 0;

          if (!allFixed && fixIteration < this.options.maxFixIterations) {
            // Update unresolved list for next iteration
            unresolvedIssues.splice(
              0,
              unresolvedIssues.length,
              ...unresolvedIssues.filter(
                (i) => !this.stateManager.isCommentVerifiedFixed(i.comment.id)
              )
            );
          }
        }

        if (!allFixed) {
          console.log(chalk.yellow(`\nMax fix iterations reached. ${unresolvedIssues.length} issues remain.`));
        }

        // Commit changes if we have any
        if (await hasChanges(git)) {
          const fixedIssues = unresolvedIssues
            .filter((i) => this.stateManager.isCommentVerifiedFixed(i.comment.id))
            .map((i) => `${i.comment.path}: ${i.comment.body.substring(0, 50)}...`);

          const commitMsg = buildCommitMessage(fixedIssues, []);
          
          spinner.start('Committing changes...');
          const commit = await squashCommit(git, 'fix: address LLM review bot comments', commitMsg);
          spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${commit.filesChanged} files)`);

          // Push if auto-push mode
          if (this.options.autoPush) {
            spinner.start('Pushing changes...');
            await push(git, this.prInfo.branch);
            spinner.succeed('Pushed to remote');

            // Wait for bot re-review
            if (pushIteration < maxPushIterations) {
              console.log(chalk.gray(`\nWaiting ${this.options.pollInterval}s for Copilot to re-review...`));
              await this.sleep(this.options.pollInterval * 1000);
            }
          } else {
            console.log(chalk.blue('\nChanges committed locally. Use --auto-push to push automatically.'));
            console.log(chalk.gray(`Workdir: ${this.workdir}`));
            break;
          }
        } else {
          console.log(chalk.yellow('\nNo changes to commit'));
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

      console.log(chalk.green('\nDone!'));

    } catch (error) {
      spinner.fail('Error');
      throw error;
    }
  }

  private async setupRunner(): Promise<Runner> {
    const runners: Record<string, Runner> = {
      cursor: new CursorRunner(),
      opencode: new OpencodeRunner(),
    };

    const runner = runners[this.options.tool];
    if (!runner) {
      throw new Error(`Unknown tool: ${this.options.tool}`);
    }

    const available = await runner.isAvailable();
    if (!available) {
      throw new Error(`Tool '${this.options.tool}' is not installed or not in PATH`);
    }

    return runner;
  }

  private async findUnresolvedIssues(comments: BotComment[]): Promise<UnresolvedIssue[]> {
    const unresolved: UnresolvedIssue[] = [];

    for (const comment of comments) {
      // Skip if already verified as fixed
      if (this.stateManager.isCommentVerifiedFixed(comment.id)) {
        continue;
      }

      // Get current code at the comment location
      const codeSnippet = await this.getCodeSnippet(comment.path, comment.line);

      // Ask LLM if issue still exists
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
        // Mark as fixed in state
        this.stateManager.markCommentVerifiedFixed(comment.id);
      }
    }

    await this.stateManager.save();
    return unresolved;
  }

  private async getCodeSnippet(path: string, line: number | null): Promise<string> {
    try {
      const filePath = join(this.workdir, path);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      if (line === null) {
        // Return first 50 lines if no specific line
        return lines.slice(0, 50).join('\n');
      }

      // Return context around the line (10 lines before and after)
      const start = Math.max(0, line - 10);
      const end = Math.min(lines.length, line + 10);
      
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
