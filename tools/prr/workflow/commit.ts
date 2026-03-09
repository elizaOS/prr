/**
 * Commit workflow: commit and push after all issues are resolved.
 *
 * WHY scope commit message to staged files: We amend the initial commit with a
 * message built only from issues in files that were actually changed in this
 * commit. Listing every verified issue on the PR (including untouched files)
 * was misleading in git history. WHY export lessons before commit: So the
 * commit includes updated .prr/lessons.md and CLAUDE.md when we have new
 * lessons; otherwise they'd be left uncommitted in the workdir.
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import type { Ora } from 'ora';
import type { ReviewComment } from '../github/types.js';
import type { PRInfo } from '../github/types.js';
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
import type { Config } from '../../../shared/config.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, warn, debugStep } from '../../../shared/logger.js';
import { formatNumber } from '../ui/reporter.js';
import { hasChanges } from '../../../shared/git/git-clone-index.js';
import { buildCommitMessage, squashCommit, pushWithRetry } from '../../../shared/git/git-commit-index.js';
import { resolveTrackedPath } from './helpers/solvability.js';

/**
 * Commit and push changes after all issues are resolved
 * Returns whether the commit/push was successful
 */
export async function commitAndPushChanges(
  git: SimpleGit,
  prInfo: PRInfo,
  comments: ReviewComment[],
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  options: CLIOptions,
  config: Config,
  workdir: string,
  spinner: Ora,
  resolveConflicts: (git: SimpleGit, files: string[], source: string) => Promise<{success: boolean; remainingConflicts: string[]}>
): Promise<{
  committed: boolean;
}> {
  const verifiedThisSession = stateContext.verifiedThisSession ?? new Set<string>();
  if (verifiedThisSession.size === 0) {
    debug('Skipping final commit: no fixes were verified in this session');
    return { committed: false };
  }

  // Check if we have uncommitted changes that need to be committed
  if (!(await hasChanges(git))) {
    return { committed: false };
  }
  
  debugStep('COMMIT PHASE (all resolved)');
  
  // Export lessons to repo BEFORE commit so they're included
  if (LessonsAPI.Retrieve.hasNewLessonsForRepo(lessonsContext)) {
    spinner.start('Exporting lessons to repo...');
    await LessonsAPI.Save.saveToRepo(lessonsContext);
    spinner.succeed('Lessons exported');
  }
  
  if (options.noCommit) {
    warn('NO-COMMIT MODE: Skipping commit. Changes are in workdir.');
    console.log(chalk.gray(`Workdir: ${workdir}`));
    return { committed: false };
  }
  
  spinner.text = 'Committing changes...';
  const commit = await squashCommit(git, 'fix: address review comments');
  if (commit === null || commit.filesChanged === 0) {
    console.log(chalk.yellow('\nNo changes to commit (only tool artifacts or no file changes)'));
    return { committed: false };
  }

  // Build message only from issues in files that were actually committed.
  // WHY: Listing all verified issues (including untouched files) was misleading in git log.
  const stagedSet = new Set(commit.stagedFiles);
  const fixedIssues = comments
    .filter((comment) => verifiedThisSession.has(comment.id) && Verification.isVerified(stateContext, comment.id))
    .map((comment) => ({
      filePath: resolveTrackedPath(workdir, comment.path) ?? comment.path,
      comment: comment.body,
    }))
    .filter((issue) => stagedSet.has(issue.filePath));

  const commitMsg = buildCommitMessage(fixedIssues, []);
  debug('Generated commit message', commitMsg);

  await git.raw(['commit', '--amend', '-m', commitMsg]);
  const headCommit = await git.log({ maxCount: 1 });
  const actualMessage = headCommit.latest?.message ?? commitMsg;
  spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${formatNumber(commit.filesChanged)} files)`);
  debug('Commit created', { hash: commit.hash, message: actualMessage, filesChanged: commit.filesChanged, stagedFiles: commit.stagedFiles });

  if (options.autoPush && !options.noPush) {
    // Log command BEFORE spinner so user can copy it if needed
    console.log(chalk.gray(`  Running: git push origin ${prInfo.branch}`));
    console.log(chalk.gray(`  Workdir: ${workdir}`));
    spinner.start('Pushing changes...');
    await pushWithRetry(git, prInfo.branch, {
      onPullNeeded: () => {
        spinner.text = 'Push rejected, pulling and retrying...';
      },
      githubToken: config.githubToken,
      onConflict: async (conflictedFiles: string[]) => {
        // Resolve rebase conflicts using LLM
        spinner.text = 'Resolving rebase conflicts...';
        const resolution = await resolveConflicts(
          git,
          conflictedFiles,
          `origin/${prInfo.branch}`
        );
        return resolution.success;
      },
    });
    spinner.succeed('Pushed to remote');
  } else if (!options.noPush) {
    console.log(chalk.blue('\nChanges committed locally. Use --auto-push to push automatically.'));
  } else {
    warn('NO-PUSH MODE: Changes committed locally but not pushed.');
  }
  console.log(chalk.gray(`Workdir: ${workdir}`));
  
  return { committed: true };
}
