/**
 * Repository workflow functions
 * Handles cloning, updating, state recovery, and conflict resolution
 */

import type { SimpleGit } from 'simple-git';
import type { Ora } from 'ora';
import type { PRInfo } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase, getState } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import * as Rotation from '../state/state-rotation.js';
import type { Runner } from '../../../shared/runners/types.js';
import chalk from 'chalk';
import { debug, debugStep, startTimer, endTimer, pluralize, formatNumber } from '../../../shared/logger.js';
import {
  cloneOrUpdate,
  checkForConflicts,
  pullLatest,
  abortMerge,
  completeMerge,
  cleanupGitState,
  continueRebase,
  ensureForkBaseRemote,
  FORK_PR_BASE_REMOTE,
} from '../../../shared/git/git-clone-index.js';
import { scanCommittedFixes } from '../../../shared/git/git-commit-index.js';

/**
 * Restore runner and model rotation state from previous session
 */
export function restoreRunnerRotationState(
  stateContext: StateContext,
  runners: Runner[],
  modelIndices: Map<string, number>,
  getCurrentModel: () => string | null | undefined
): {
  runner: Runner | null;
  runnerIndex: number;
} {
  const savedRunnerIndex = Rotation.getCurrentRunnerIndex(stateContext);
  const savedModelIndices = Rotation.getModelIndices(stateContext);
  
  let runner: Runner | null = null;
  let runnerIndex = 0;
  
  if (savedRunnerIndex > 0 && savedRunnerIndex < runners.length) {
    runnerIndex = savedRunnerIndex;
    runner = runners[savedRunnerIndex];
    console.log(chalk.gray(`  Resuming at tool: ${runner.displayName} (from previous session)`));
  }
  
  if (Object.keys(savedModelIndices).length > 0) {
    for (const [runnerName, index] of Object.entries(savedModelIndices)) {
      modelIndices.set(runnerName, index);
    }
    const currentModel = getCurrentModel();
    if (currentModel) {
      console.log(chalk.gray(`  Resuming at model: ${currentModel} (from previous session)`));
    }
  }
  
  return { runner, runnerIndex };
}

function formatRepoSize(sizeKb: number): string {
  if (sizeKb < 1024) return `${sizeKb} KB`;
  const mb = sizeKb / 1024;
  if (mb < 1024) return `~${Math.round(mb)} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Clone or update repository
 */
export async function cloneOrUpdateRepository(
  prInfo: PRInfo,
  workdir: string,
  githubToken: string,
  hasVerifiedFixes: boolean,
  spinner: Ora,
  github?: GitHubAPI
): Promise<SimpleGit> {
  debugStep('CLONING/UPDATING REPOSITORY');
  if (github) {
    const sizeKb = await github.getRepoSizeKb(prInfo.owner, prInfo.repo);
    if (sizeKb != null) {
      console.log(chalk.gray(`  Repository size: ${formatRepoSize(sizeKb)}`));
    }
  }
  // No spinner during clone — WHY: git streams clone/fetch progress to the TTY; ora redraws the line and interferes. Post-clone uses ora.
  const additionalBranches = prInfo.baseBranch && prInfo.baseBranch !== prInfo.branch
    ? [prInfo.baseBranch]
    : undefined;
  const { git } = await cloneOrUpdate(
    prInfo.cloneUrl,
    prInfo.branch,
    workdir,
    githubToken,
    {
      preserveChanges: hasVerifiedFixes,
      additionalBranches,
      baseRepoCloneUrl: prInfo.baseRepoCloneUrl,
    },
  );
  spinner.succeed('Repository ready');
  debug('Repository cloned/updated at', workdir);

  return git;
}

/**
 * Recover verification state from git commit messages.
 * Dedup siblings are expanded on the first `findUnresolvedIssues` pass when **`state.dedupCache`**
 * matches the current PR comment id set — see **`expandGitRecoveredVerificationFromDedupCache`** (`duplicate-cluster-verify.ts`).
 */
export async function recoverVerificationState(
  git: SimpleGit,
  branch: string,
  stateContext: StateContext,
  workdir: string,
  options?: { prBaseBranch?: string; useUpstreamPrBaseForGitRecovery?: boolean }
): Promise<void> {
  debugStep('RECOVERING STATE FROM GIT');
  let headSha = '';
  try {
    headSha = (await git.revparse(['HEAD'])).trim();
  } catch {
    /* fall through — scan without cache */
  }
  const committedFixes = await scanCommittedFixes(git, branch, {
    workdir,
    headSha: headSha || undefined,
    prBaseBranch: options?.prBaseBranch,
    useUpstreamPrBaseForGitRecovery: options?.useUpstreamPrBaseForGitRecovery,
  });
  if (committedFixes.length > 0) {
    const n = committedFixes.length;
    stateContext.gitRecoveredVerificationCount = n;
    console.log(chalk.cyan(`Recovered ${formatNumber(n)} previously committed ${pluralize(n, 'fix', 'fixes')} from git history`));
    let skippedAlreadyVerified = 0;
    for (const commentId of committedFixes) {
      if (!Verification.isVerified(stateContext, commentId)) {
        Verification.markVerified(stateContext, commentId, Verification.PRR_GIT_RECOVERY_VERIFIED_MARKER, {
          skipSessionTracking: true,
        });
      } else {
        skippedAlreadyVerified += 1;
      }
    }
    if (skippedAlreadyVerified > 0) {
      console.log(
        chalk.gray(
          `  (${formatNumber(skippedAlreadyVerified)} id(s) already verified in state — skipped re-mark from git recovery)`,
        ),
      );
    }
    // WHY: So the first analysis skips stale re-check and unmark for these IDs (output.log audit).
    getState(stateContext).recoveredFromGitCommentIds = [...committedFixes];
    await State.saveState(stateContext);
    debug('Recovered verifications from git', { count: committedFixes.length });
  }
}

const LATENT_CONFLICT_LIST_MAX = 25;

function logLatentConflictWarning(
  label: string,
  files: string[],
  footer: string
): void {
  if (files.length === 0) return;
  const n = files.length;
  console.log(chalk.yellow(`${label} ${formatNumber(n)} file(s):`));
  for (const f of files.slice(0, LATENT_CONFLICT_LIST_MAX)) {
    console.log(chalk.yellow(`    - ${f}`));
  }
  if (files.length > LATENT_CONFLICT_LIST_MAX) {
    console.log(
      chalk.gray(`    … and ${formatNumber(files.length - LATENT_CONFLICT_LIST_MAX)} more`),
    );
  }
  console.log(chalk.gray(`  ${footer}`));
}

/** Same signature as **`resolveConflictsWithLLM`** passed into **`checkAndSyncWithRemote`**. */
export type ResolveConflictsWithLLMFn = (
  git: SimpleGit,
  files: string[],
  source: string,
) => Promise<{ success: boolean; remainingConflicts: string[] }>;

const MAX_REBASE_CONFLICT_ROUNDS = 50;

export interface ResolvePullRebaseConflictsOptions {
  /** When true, skip push after successful resolution (fix loop defers to **commit-and-push**). */
  noPush?: boolean;
  githubToken?: string;
}

export function isPullConflictErrorMessage(error?: string): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return e.includes('conflict') || e.includes('rebase conflicts');
}

/**
 * After **`pullLatest`** failed with conflicts (or left rebase/merge conflict markers), run LLM
 * conflict resolution and **`completeMerge`** / **`rebase --continue`** in a loop — same behavior
 * as the setup sync path (**`checkAndSyncWithRemote`**). Used at **top of each fix iteration**
 * when the remote moved (**`checkAndPullRemoteCommits`**).
 */
export async function resolvePullRebaseConflictsAfterFailedPull(
  git: SimpleGit,
  branch: string,
  resolveConflicts: ResolveConflictsWithLLMFn,
  options?: ResolvePullRebaseConflictsOptions,
): Promise<{ ok: true; resolvedRounds: number } | { ok: false; error: string }> {
  const noPush = options?.noPush === true;
  const githubToken = options?.githubToken;

  console.log(chalk.cyan('  Attempting to resolve pull/rebase conflicts automatically...'));
  startTimer('Resolve pull conflicts');
  let resolvedRounds = 0;

  for (let round = 0; round < MAX_REBASE_CONFLICT_ROUNDS; round++) {
    const status = await git.status();
    const conflictedFiles = status.conflicted || [];

    if (conflictedFiles.length === 0) {
      const { getResolvedGitDir } = await import('../../../shared/git/git-merge.js');
      const { existsSync: fsExists } = await import('fs');
      const { join: pathJoin } = await import('path');
      const resolvedGitDir = await getResolvedGitDir(git);
      const inRebase =
        fsExists(pathJoin(resolvedGitDir, 'rebase-merge')) || fsExists(pathJoin(resolvedGitDir, 'rebase-apply'));
      if (!inRebase) break;
      try {
        await continueRebase(git);
      } catch {
        break;
      }
      continue;
    }

    debug('Pull/rebase deconflict round', { round: round + 1, conflictedFiles: conflictedFiles.length });
    console.log(
      chalk.cyan(
        `  Deconflict round ${formatNumber(round + 1)}: ${formatNumber(conflictedFiles.length)} file(s)`,
      ),
    );

    const resolution = await resolveConflicts(git, conflictedFiles, `origin/${branch}`);
    debug('Pull conflict resolution result', {
      round: round + 1,
      success: resolution.success,
      remaining: resolution.remainingConflicts.length,
    });

    if (!resolution.success) {
      console.log(chalk.red('\n✗ Could not resolve pull/rebase conflicts automatically'));
      console.log(chalk.red('  Remaining conflicts:'));
      for (const file of resolution.remainingConflicts) {
        console.log(chalk.red(`    - ${file}`));
      }
      console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
      await cleanupGitState(git);
      endTimer('Resolve pull conflicts');
      return { ok: false, error: 'Unresolved pull conflicts' };
    }

    resolvedRounds++;

    const commitResult = await completeMerge(git, `Merge remote-tracking branch 'origin/${branch}'`);

    if (!commitResult.success) {
      const errMsg = commitResult.error || '';
      if (errMsg.includes('CONFLICT') || errMsg.includes('conflict')) {
        debug('Rebase --continue / merge commit hit another conflict, looping', { error: errMsg.slice(0, 120) });
        continue;
      }
      console.log(chalk.red(`✗ Failed to complete merge/rebase: ${commitResult.error}`));
      await cleanupGitState(git);
      endTimer('Resolve pull conflicts');
      return { ok: false, error: commitResult.error ?? 'merge/rebase failed' };
    }
  }

  if (resolvedRounds === 0) {
    console.log(chalk.yellow('  No conflicted files found to resolve.'));
    await cleanupGitState(git);
    endTimer('Resolve pull conflicts');
    return { ok: false, error: 'Manual conflict resolution required' };
  }

  console.log(
    chalk.green(
      `✓ Pull/rebase conflicts resolved (${formatNumber(resolvedRounds)} round${resolvedRounds === 1 ? '' : 's'})`,
    ),
  );
  if (!noPush) {
    const { push } = await import('../../../shared/git/git-push.js');
    const pushResult = await push(git, branch, false, githubToken);
    if (pushResult.success && !pushResult.nothingToPush) {
      console.log(chalk.green('  Pushed after rebase conflict resolution'));
    } else if (pushResult.success && pushResult.nothingToPush) {
      console.log(chalk.green('  Already up-to-date'));
    } else {
      console.log(chalk.yellow(`  Push failed after rebase conflict resolution: ${pushResult.error ?? 'Unknown'}`));
    }
  }
  endTimer('Resolve pull conflicts');
  return { ok: true, resolvedRounds };
}

/**
 * **`pullLatest`** stash pop left conflict markers — same LLM resolution as setup (**`checkAndSyncWithRemote`**).
 * Returns whether all listed files were cleaned (false = caller may proceed with warning).
 */
export async function resolveStashPopConflictsWithLLM(
  git: SimpleGit,
  resolveConflicts: ResolveConflictsWithLLMFn,
  stashConflicts: string[],
): Promise<boolean> {
  if (stashConflicts.length === 0) return true;
  console.log(chalk.cyan(`  Stash conflicts in: ${stashConflicts.join(', ')}`));
  console.log(chalk.cyan('  Attempting to resolve stash conflicts automatically...'));
  startTimer('Resolve stash conflicts');
  const resolution = await resolveConflicts(git, stashConflicts, 'stashed changes');
  if (!resolution.success) {
    console.log(chalk.red('\n✗ Could not resolve stash conflicts automatically'));
    console.log(chalk.red('  Remaining conflicts:'));
    for (const file of resolution.remainingConflicts) {
      console.log(chalk.red(`    - ${file}`));
    }
    console.log(chalk.yellow('\n  Stash conflicts remain - proceeding anyway'));
    endTimer('Resolve stash conflicts');
    return false;
  }
  console.log(chalk.green('✓ Stash conflicts resolved'));
  endTimer('Resolve stash conflicts');
  return true;
}

/**
 * Check for conflicts and sync with remote, auto-resolving if possible.
 * Pass githubToken when the remote is not configured with credentials so fetch/pull use one-shot auth.
 * **`prBaseBranch`:** GitHub PR base ref name (e.g. `main`); enables second **`merge-tree`** probe vs **`origin/<prBase>`** (GitHub dirty / mergeable).
 * **`baseRepoCloneUrl`:** When set (fork PR), configures **`upstream`** and probes / materializes vs **`upstream/<prBase>`** so latent conflicts match GitHub’s upstream base.
 */
export async function checkAndSyncWithRemote(
  git: SimpleGit,
  branch: string,
  spinner: Ora,
  resolveConflicts: (git: SimpleGit, files: string[], source: string) => Promise<{success: boolean; remainingConflicts: string[]}>,
  githubToken?: string,
  /** When true, skip pushing after resolving conflicts (e.g. user passed --no-push). */
  noPush?: boolean,
  prBaseBranch?: string,
  baseRepoCloneUrl?: string
): Promise<{success: boolean; error?: string}> {
  // Check for conflicts and sync with remote
  // WHY CHECK EARLY: Conflict markers in files will cause fixer tools to fail confusingly.
  // Better to detect and resolve conflicts upfront before entering the fix loop.
  // WHY fetchOpts: when remote has no credentials, fetch would prompt for password and hang; token unblocks.
  const fetchOpts = githubToken ? { githubToken } : undefined;
  if (baseRepoCloneUrl?.trim()) {
    await ensureForkBaseRemote(git, baseRepoCloneUrl.trim());
  }
  const prBaseRemote = baseRepoCloneUrl?.trim() ? FORK_PR_BASE_REMOTE : 'origin';
  debugStep('CHECKING FOR CONFLICTS');
  spinner.start('Fetching from origin and checking git status...');
  let conflictStatus: Awaited<ReturnType<typeof checkForConflicts>>;
  try {
    conflictStatus = await checkForConflicts(git, branch, {
      ...fetchOpts,
      prBaseBranch: prBaseBranch?.trim() || undefined,
      prBaseRemote: baseRepoCloneUrl?.trim() ? prBaseRemote : undefined,
    });
  } catch (err) {
    // WHY catch here: fetch can timeout or fail with message that includes git stdout/stderr; show it and return cleanly.
    spinner.fail('Checking for conflicts failed');
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  ${msg}`));
    return { success: false, error: msg };
  }
  spinner.stop();

  if (!conflictStatus.hasConflicts && conflictStatus.latentConflictWithOrigin && conflictStatus.latentConflictedFiles.length > 0) {
    logLatentConflictWarning(
      `⚠ Dry-merge probe (PR vs remote tip): merging origin/${branch} would conflict in`,
      conflictStatus.latentConflictedFiles,
      'Pull/rebase will surface these conflicts next. Set PRR_MATERIALIZE_LATENT_MERGE=1 to merge --no-commit now for early auto-resolve. PRR_DISABLE_LATENT_MERGE_PROBE=1 skips this probe.',
    );
  }

  const pb = prBaseBranch?.trim();
  const prBaseRefRemote = baseRepoCloneUrl?.trim() ? FORK_PR_BASE_REMOTE : 'origin';
  if (
    pb &&
    pb !== branch.trim() &&
    !conflictStatus.hasConflicts &&
    conflictStatus.latentConflictWithPrBase &&
    conflictStatus.latentConflictedFilesWithPrBase.length > 0
  ) {
    logLatentConflictWarning(
      `⚠ Dry-merge probe (PR vs base — GitHub mergeable/dirty): merging ${prBaseRefRemote}/${pb} into HEAD would conflict in`,
      conflictStatus.latentConflictedFilesWithPrBase,
      'This aligns with GitHub “not mergeable / dirty” more than the PR-tip probe alone. Set PRR_MATERIALIZE_LATENT_MERGE_BASE=1 to merge --no-commit now for early auto-resolve. PRR_DISABLE_LATENT_MERGE_PROBE_BASE=1 skips this probe.',
    );
  } else if (pb && pb !== branch.trim() && conflictStatus.latentProbePrBaseNote) {
    debug('PR-base latent probe note', { prBase: pb, note: conflictStatus.latentProbePrBaseNote });
  }

  /** Passed to LLM conflict resolution (`origin/…` label). Base merge uses `<prBaseRefRemote>/<prBase>` when materialized here. */
  let mergeConflictSourceLabel = `origin/${branch}`;

  const mat = process.env.PRR_MATERIALIZE_LATENT_MERGE?.trim().toLowerCase();
  if (mat === '1' || mat === 'true' || mat === 'yes' || mat === 'on') {
    if (!conflictStatus.hasConflicts && conflictStatus.latentConflictWithOrigin) {
      spinner.start(`Materializing merge with origin/${branch} (latent conflicts)...`);
      try {
        await git.raw(['merge', `origin/${branch}`, '--no-commit', '--no-ff']);
      } catch {
        /* non-zero exit when Git stops on conflicts */
      }
      const st = await git.status();
      const nowConflicted = st.conflicted || [];
      if (nowConflicted.length > 0) {
        conflictStatus = {
          ...conflictStatus,
          hasConflicts: true,
          conflictedFiles: nowConflicted,
        };
      } else {
        let mergeHead = '';
        try {
          mergeHead = (await git.raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).trim();
        } catch {
          mergeHead = '';
        }
        if (mergeHead) {
          try {
            await git.raw(['merge', '--abort']);
          } catch {
            await cleanupGitState(git);
          }
        }
      }
      spinner.stop();
    }
  }

  const matBase = process.env.PRR_MATERIALIZE_LATENT_MERGE_BASE?.trim().toLowerCase();
  if (matBase === '1' || matBase === 'true' || matBase === 'yes' || matBase === 'on') {
    if (
      pb &&
      pb !== branch.trim() &&
      !conflictStatus.hasConflicts &&
      conflictStatus.latentConflictWithPrBase
    ) {
      spinner.start(`Materializing merge with ${prBaseRefRemote}/${pb} (PR vs base latent conflicts)...`);
      try {
        await git.raw(['merge', `${prBaseRefRemote}/${pb}`, '--no-commit', '--no-ff']);
      } catch {
        /* non-zero exit when Git stops on conflicts */
      }
      const st = await git.status();
      const nowConflicted = st.conflicted || [];
      if (nowConflicted.length > 0) {
        conflictStatus = {
          ...conflictStatus,
          hasConflicts: true,
          conflictedFiles: nowConflicted,
        };
        mergeConflictSourceLabel = `${prBaseRefRemote}/${pb}`;
      } else {
        let mergeHead = '';
        try {
          mergeHead = (await git.raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).trim();
        } catch {
          mergeHead = '';
        }
        if (mergeHead) {
          try {
            await git.raw(['merge', '--abort']);
          } catch {
            await cleanupGitState(git);
          }
        }
      }
      spinner.stop();
    }
  }

  if (conflictStatus.hasConflicts) {
    // WHY AUTO-RESOLVE: Previously, prr would bail out here with "resolve manually".
    // This was frustrating because the same LLM tools that fix review comments can
    // also resolve merge conflicts. Auto-resolution keeps the workflow seamless.
    console.log(chalk.yellow('⚠ Merge conflicts detected from previous operation'));
    console.log(chalk.cyan('  Attempting to resolve conflicts automatically...'));
    
    startTimer('Resolve remote conflicts');
    const resolution = await resolveConflicts(
      git,
      conflictStatus.conflictedFiles,
      mergeConflictSourceLabel
    );
    
    if (!resolution.success) {
      console.log(chalk.red('\n✗ Could not resolve all merge conflicts automatically'));
      console.log(chalk.red('  Remaining conflicts:'));
      for (const file of resolution.remainingConflicts) {
        console.log(chalk.red(`    - ${file}`));
      }
      console.log(chalk.yellow('\n  Please resolve conflicts manually before running prr.'));
      await cleanupGitState(git);
      endTimer('Resolve remote conflicts');
      return { success: false, error: 'Unresolved merge conflicts' };
    }
    
    // All conflicts resolved - complete the merge
    const commitResult = await completeMerge(git, `Merge remote-tracking branch '${mergeConflictSourceLabel}'`);
    
    if (!commitResult.success) {
      console.log(chalk.red(`✗ Failed to complete merge: ${commitResult.error}`));
      await cleanupGitState(git);
      endTimer('Resolve remote conflicts');
      return { success: false, error: commitResult.error };
    }
    
    console.log(chalk.green('✓ Conflicts resolved and merge completed'));
    endTimer('Resolve remote conflicts');
    if (!noPush) {
      spinner.start('Pushing after conflict resolution...');
      const { push } = await import('../../../shared/git/git-push.js');
      const pushResult = await push(git, branch, false, githubToken);
      if (pushResult.success && !pushResult.nothingToPush) {
        spinner.succeed('Pushed after conflict resolution');
      } else if (pushResult.success && pushResult.nothingToPush) {
        spinner.succeed('Already up-to-date');
      } else {
        spinner.fail('Push failed after conflict resolution');
        console.log(chalk.yellow(`  ${pushResult.error ?? 'Unknown'}. Push manually from workdir if needed.`));
      }
    }
  }

  if (conflictStatus.behindBy > 0) {
    console.log(chalk.yellow(`⚠ Branch is ${formatNumber(conflictStatus.behindBy)} commits behind remote`));
    spinner.start('Pulling latest changes...');
    const pullResult = await pullLatest(git, branch, fetchOpts);

    let pullSucceeded = pullResult.success;

    if (!pullResult.success) {
      spinner.fail('Failed to pull');
      console.log(chalk.red(`  Error: ${pullResult.error}`));

      if (isPullConflictErrorMessage(pullResult.error)) {
        const dr = await resolvePullRebaseConflictsAfterFailedPull(git, branch, resolveConflicts, {
          noPush,
          githubToken: fetchOpts?.githubToken,
        });
        if (!dr.ok) {
          return { success: false, error: dr.error };
        }
        pullSucceeded = true;
      } else {
        return { success: false, error: pullResult.error };
      }
    }

    if (pullSucceeded) {
      if (pullResult.stashConflicts && pullResult.stashConflicts.length > 0) {
        spinner.warn('Pulled with stash conflicts');
        await resolveStashPopConflictsWithLLM(git, resolveConflicts, pullResult.stashConflicts);
      }
      spinner.succeed('Pulled latest changes');
    }
  }
  
  if (conflictStatus.aheadBy > 0 && !noPush) {
    console.log(chalk.yellow(`  Branch is ${formatNumber(conflictStatus.aheadBy)} commits ahead of remote — pushing unpushed commits`));
    const { push } = await import('../../../shared/git/git-push.js');
    const pushResult = await push(git, branch, false, fetchOpts?.githubToken);
    if (pushResult.success && !pushResult.nothingToPush) {
      console.log(chalk.green(`  ✓ Pushed ${formatNumber(conflictStatus.aheadBy)} unpushed commit(s)`));
    } else if (pushResult.success && pushResult.nothingToPush) {
      debug('Ahead commits already on remote (tracking mismatch)', { aheadBy: conflictStatus.aheadBy });
    } else {
      console.log(chalk.yellow(`  ⚠ Push failed: ${pushResult.error ?? 'Unknown'}. Will retry after fixes.`));
      debug('Push of ahead commits failed', { error: pushResult.error, aheadBy: conflictStatus.aheadBy });
    }
  }
  
  return { success: true };
}
