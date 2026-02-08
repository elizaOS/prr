/**
 * Commit workflow functions
 * Handles committing and pushing fixes after audit passes
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
import type { Config } from '../config.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, warn, debugStep } from '../logger.js';
import { formatNumber } from '../ui/reporter.js';
import { hasChanges } from '../git/git-clone-index.js';
import { buildCommitMessage, squashCommit, pushWithRetry } from '../git/git-commit-index.js';

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
  
  // Get all comments that were fixed for commit message
  const fixedIssues = comments
    .filter((comment) => Verification.isVerified(stateContext, comment.id))
    .map((comment) => ({
      filePath: comment.path,
      comment: comment.body,
    }));
  
  // Generate commit message locally (no LLM call needed)
  // WHY: Pattern matching is fast, free, and works well for commit messages
  const commitMsg = buildCommitMessage(fixedIssues, []);
  debug('Generated commit message', commitMsg);
  
  spinner.text = 'Committing changes...';
  const commit = await squashCommit(git, commitMsg);
  spinner.succeed(`Committed: ${commit.hash.substring(0, 7)} (${formatNumber(commit.filesChanged)} files)`);
  debug('Commit created', commit);
  
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
