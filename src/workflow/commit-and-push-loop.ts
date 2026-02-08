/**
 * Commit and push workflow within the fix loop
 * 
 * Handles the commit/push phase after fixes are verified:
 * 1. Export lessons to repo before commit
 * 2. Generate commit message
 * 3. Create commit
 * 4. Push to remote (if auto-push enabled)
 * 5. Check and trigger CodeRabbit
 * 6. Wait for bot reviews
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { SimpleGit } from 'simple-git';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';

/**
 * Handle commit and push after fixes are verified
 * 
 * WORKFLOW:
 * 1. Export lessons to repo (included in commit)
 * 2. Build list of fixed issues for commit message
 * 3. Generate commit message using pattern matching
 * 4. Create squash commit
 * 5. If auto-push enabled:
 *    - Push to remote with retry on conflicts
 *    - Check CodeRabbit status and trigger if needed
 *    - Wait for bot reviews using smart timing
 * 
 * @returns Control flow signals (should break) and exit state
 */
export async function handleCommitAndPush(
  git: SimpleGit,
  prInfo: PRInfo,
  owner: string,
  repo: string,
  number: number,
  comments: ReviewComment[],
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  options: CLIOptions,
  githubToken: string,
  github: GitHubAPI,
  workdir: string,
  spinner: Ora,
  pushIteration: number,
  maxPushIterations: number,
  resolveConflictsWithLLM: (
    git: SimpleGit,
    conflictedFiles: string[],
    mergingBranch: string
  ) => Promise<{ success: boolean; remainingConflicts: string[] }>,
  waitForBotReviews: (
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string
  ) => Promise<void>
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  const { debug, debugStep, warn } = await import('../logger.js');
  const { squashCommit, pushWithRetry } = await import('../git/git-commit-index.js');
  
  // Export lessons to repo BEFORE commit so they're included
  // WHY: Team gets lessons with the same push as fixes - single atomic update
  if (LessonsAPI.Retrieve.hasNewLessonsForRepo(lessonsContext)) {
    spinner.start('Exporting lessons to repo...');
    await LessonsAPI.Save.saveToRepo(lessonsContext);
    spinner.succeed('Lessons exported');
  }

  const fixedIssues = comments
    .filter((comment) => Verification.isVerified(stateContext, comment.id))
    .map((comment) => ({
      filePath: comment.path,
      comment: comment.body,
    }));

  if (options.noCommit) {
    warn('NO-COMMIT MODE: Skipping commit. Changes are in workdir.');
    console.log(chalk.gray(`Workdir: ${workdir}`));
    return {
      shouldBreak: true,
      exitReason: 'no_commit_mode',
      exitDetails: 'No-commit mode enabled - changes left uncommitted in workdir',
    };
  }
  
  // Generate commit message locally (no LLM call needed)
  // WHY: Pattern matching is fast, free, and works well for commit messages
  const { buildCommitMessage } = await import('../git/git-commit-index.js');
  const commitMsg = buildCommitMessage(fixedIssues, []);
  debug('Generated commit message', commitMsg);
  
  spinner.text = 'Committing changes...';
  const commit = await squashCommit(git, commitMsg);
  spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${commit.filesChanged} files)`);
  debug('Commit created', commit);

  // Push if auto-push mode AND not in no-push mode
  if (options.autoPush && !options.noPush) {
    debugStep('PUSH PHASE');
    // Log command BEFORE spinner so user can copy it if needed
    console.log(chalk.gray(`  Running: git push origin ${prInfo.branch}`));
    console.log(chalk.gray(`  Workdir: ${workdir}`));
    spinner.start('Pushing changes...');
    await pushWithRetry(git, prInfo.branch, {
      onPullNeeded: () => {
        spinner.text = 'Push rejected, pulling and retrying...';
      },
      githubToken: githubToken,
      onConflict: async (conflictedFiles) => {
        // Resolve rebase conflicts using LLM
        spinner.text = 'Resolving rebase conflicts...';
        const resolution = await resolveConflictsWithLLM(
          git,
          conflictedFiles,
          `origin/${prInfo.branch}`
        );
        return resolution.success;
      },
    });
    spinner.succeed('Pushed to remote');

    // Check CodeRabbit status and trigger if needed
    // WHY: Some repos configure CodeRabbit to require manual trigger (@coderabbitai review)
    // We check if it has reviewed the current commit and trigger only if needed
    let latestHeadSha = prInfo.headSha;
    try {
      spinner.start('Checking CodeRabbit status...');
      
      // Get the latest HEAD sha after push
      const latestPR = await github.getPRInfo(owner, repo, number);
      latestHeadSha = latestPR.headSha;
      
      const result = await github.triggerCodeRabbitIfNeeded(
        owner, repo, number, prInfo.branch, latestHeadSha
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
      await waitForBotReviews(owner, repo, number, latestHeadSha);
    }
    
    return { shouldBreak: false };
  } else if (options.noPush) {
    warn('NO-PUSH MODE: Changes committed locally but not pushed.');
    console.log(chalk.gray(`Workdir: ${workdir}`));
    return {
      shouldBreak: true,
      exitReason: 'no_push_mode',
      exitDetails: 'No-push mode enabled - changes committed locally only',
    };
  } else {
    console.log(chalk.blue('\nChanges committed locally. Use --auto-push to push automatically.'));
    console.log(chalk.gray(`Workdir: ${workdir}`));
    return {
      shouldBreak: true,
      exitReason: 'committed_locally',
      exitDetails: 'Changes committed locally - use --auto-push to push',
    };
  }
}
