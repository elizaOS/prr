/**
 * Commit and push workflow within the fix loop
 * 
 * Handles the commit/push phase after fixes are verified:
 * 1. Export lessons to repo before commit
 * 2. Generate commit message
 * 3. Create commit
 * 4. Push to remote (if auto-push enabled)
 * 5. Trigger CodeRabbit final review (only when all issues fixed)
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
import { debug, debugStep, warn } from '../logger.js';
import { buildCommitMessage, squashCommit, pushWithRetry } from '../git/git-commit-index.js';

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
  ) => Promise<void>,
  allFixed: boolean = false,
  /** Skip the post-push bot review wait (e.g. after bail-out when no more fix iterations will run). */
  skipBotWait: boolean = false,
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  // Export lessons to repo BEFORE commit so they're included
  // WHY: Team gets lessons with the same push as fixes - single atomic update
  if (LessonsAPI.Retrieve.hasNewLessonsForRepo(lessonsContext)) {
    spinner.start('Exporting lessons to repo...');
    try {
      await LessonsAPI.Save.saveToRepo(lessonsContext);
      spinner.succeed('Lessons exported');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      spinner.fail(`Failed exporting lessons: ${errorMessage}`);
      throw error;
    }
  }

  if (options.noCommit) {
    warn('NO-COMMIT MODE: Skipping commit. Changes are in workdir.');
    console.log(chalk.gray(`Workdir: ${workdir}`));
    return {
      shouldBreak: true,
      exitReason: 'no_commit_mode',
      exitDetails: 'No-commit mode enabled - changes left uncommitted in workdir',
    };
  }
  
  // Commit first (with placeholder message) so we know which files are staged,
  // then build the real message scoped to those files only.
  spinner.text = 'Committing changes...';
  const commit = await squashCommit(git, 'fix: address review comments');

  // No commit when only tool artifacts were staged (e.g. .prr/) or no file changes.
  if (commit === null || commit.filesChanged === 0) {
    console.log(chalk.yellow('\nNo changes to commit (only tool artifacts or no file changes)'));
    return {
      shouldBreak: true,
      exitReason: 'no_changes',
      exitDetails: 'No committable changes after excluding tool artifacts',
    };
  }

  // Scope commit message to issues whose files were actually changed in this commit
  const stagedSet = new Set(commit.stagedFiles);
  const fixedIssues = comments
    .filter((comment) => Verification.isVerified(stateContext, comment.id) && stagedSet.has(comment.path))
    .map((comment) => ({
      filePath: comment.path,
      comment: comment.body,
    }));

  const commitMsg = buildCommitMessage(fixedIssues, []);
  debug('Generated commit message', commitMsg);

  // Amend with the accurate message
  await git.raw(['commit', '--amend', '-m', commitMsg]);

  spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${commit.filesChanged} files)`);
  debug('Commit created', commit);

  // Push if auto-push mode AND not in no-push mode
  if (options.autoPush && !options.noPush) {
    debugStep('PUSH PHASE');
    // Log command BEFORE spinner so user can copy it if needed
    console.log(chalk.gray(`  Running: git push origin ${prInfo.branch}`));
    console.log(chalk.gray(`  Workdir: ${workdir}`));
    spinner.start('Pushing changes...');
    let pushNothingToPush = false;
    try {
      const pushResult = await pushWithRetry(git, prInfo.branch, {
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
      pushNothingToPush = pushResult.nothingToPush === true;
      spinner.succeed(pushNothingToPush ? 'Already up-to-date (nothing to push)' : 'Pushed to remote');
    } catch (pushErr) {
      spinner.fail('Push failed');
      throw pushErr;
    }

    // Get the latest HEAD SHA for bot review waiting
    let latestHeadSha = prInfo.headSha;
    try {
      const latestPR = await github.getPRInfo(owner, repo, number);
      latestHeadSha = latestPR.headSha;
    } catch {
      // Fall through with best-effort SHA
    }

    // Only trigger CodeRabbit on the FINAL push when all issues are resolved.
    // WHY: Triggering CR after each intermediate push generates NEW review comments
    // on a moving target, creating more issues than it resolves and preventing
    // the PR from converging. But once everything is fixed, we want CR to do a
    // final verification pass.
    if (allFixed) {
      try {
        spinner.start('Triggering CodeRabbit final review...');
        const result = await github.triggerCodeRabbitIfNeeded(
          owner, repo, number, prInfo.branch, latestHeadSha
        );
        if (result.triggered) {
          spinner.succeed('CodeRabbit triggered for final review');
        } else if (result.mode === 'none') {
          spinner.info('CodeRabbit not detected on this PR');
        } else {
          spinner.info(`CodeRabbit: ${result.reason}`);
        }
        debug('CodeRabbit final review result', result);
      } catch (err) {
        debug('Failed to trigger CodeRabbit final review', { error: err });
        spinner.warn('Could not trigger CodeRabbit final review (continuing anyway)');
      }
    }

    // Wait for re-review using smart timing based on observed bot response times.
    //
    // Skip wait when nothing was pushed (Everything up-to-date): no new commit
    // was sent, so bots have nothing new to review and 300s would be wasted.
    // HISTORY: Originally "always wait, even after bail-out" reasoning was that
    // pushed fixes may trigger new bot comments worth processing. In practice,
    // after a stalemate bail-out we've exhausted all fix strategies — new bot
    // comments won't change the outcome. The 300s wait just delays exit with
    // zero benefit. Now the caller passes skipBotWait=true on bail-out to avoid
    // this. The wait still runs for normal mid-loop pushes where re-entering
    // the fix loop with fresh bot feedback is valuable.
    const shouldWaitForBots = !skipBotWait && !pushNothingToPush && (maxPushIterations === 0 || pushIteration < maxPushIterations);
    if (shouldWaitForBots) {
      await waitForBotReviews(owner, repo, number, latestHeadSha);
    } else if (skipBotWait) {
      debug('Skipping bot review wait (bail-out — no more fix iterations will run)');
    } else if (pushNothingToPush) {
      debug('Skipping bot review wait (nothing was pushed — already up-to-date)');
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
