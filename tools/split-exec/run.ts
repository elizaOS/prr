/**
 * split-exec runner: read plan, clone repo, execute each split (cherry-pick, push, create PR).
 * WHY iterative: Process one split at a time so the user can fix conflicts or stop between splits.
 */
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import ora, { type Ora } from 'ora';
import { join } from 'path';
import type { Config } from '../../shared/config.js';
import type { SplitExecOptions } from './cli.js';
import { parsePlanFile, type ParsedPlan, type ParsedSplit } from './parse-plan.js';
import { GitHubAPI } from '../prr/github/api.js';
import { cloneOrUpdate } from '../../shared/git/git-clone-index.js';
import { pushWithRetry } from '../../shared/git/git-push.js';
import type { SimpleGit } from 'simple-git';
import { debug, formatNumber } from '../../shared/logger.js';

/** True when the error is GitHub auth failure (invalid/expired token or password auth). */
function isAuthError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    /authentication failed/i.test(msg) ||
    /invalid username or token/i.test(msg) ||
    /password authentication is not supported/i.test(msg) ||
    /bad credentials/i.test(msg)
  );
}

/** Fail fast if target branch does not exist on remote (pill-output #1). */
function ensureTargetBranchExistsOnRemote(
  cloneUrl: string,
  targetBranch: string,
  githubToken: string | undefined
): void {
  const authUrl = githubToken && cloneUrl.startsWith('https://')
    ? cloneUrl.replace('https://', `https://${githubToken}@`)
    : cloneUrl;
  try {
    const out = execFileSync('git', ['ls-remote', '--heads', authUrl, `refs/heads/${targetBranch}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!out.trim() || !out.includes(`refs/heads/${targetBranch}`)) {
      throw new Error(`Target branch ${targetBranch} does not exist on remote. Create it first or update the split plan.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('does not exist on remote')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('could not read') || msg.includes('not found') || msg.includes('does not exist')) {
      throw new Error(`Target branch ${targetBranch} does not exist on remote. Create it first or update the split plan.`);
    }
    throw new Error(`Could not verify target branch ${targetBranch} on remote: ${msg}`);
  }
}

export async function runSplitExec(
  planPath: string,
  config: Config,
  options: SplitExecOptions
): Promise<void> {
  if (!existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}. Usage: split-exec <plan-file> (e.g. .split-plan.md)`);
  }
  const spinner = ora();
  spinner.start('Parsing plan...');
  const plan: ParsedPlan = parsePlanFile(planPath);
  spinner.succeed(`Plan: ${plan.splits.length} splits (${plan.sourceBranch} → ${plan.targetBranch})`);

  const cloneUrl = `https://github.com/${plan.owner}/${plan.repo}.git`;
  const workdir = options.workdir ?? join(process.cwd(), '.split-exec-workdir');
  const github = new GitHubAPI(config.githubToken);

  if (!options.dryRun && config.githubToken) {
    spinner.start('Checking GitHub token...');
    try {
      await github.getDefaultBranch(plan.owner, plan.repo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : undefined;
      if (status === 401 || /bad credentials|invalid.*token|authentication failed/i.test(msg)) {
        throw new Error(
          `GITHUB_TOKEN rejected by GitHub (${status ?? 'auth error'}): ${msg}. ` +
            'Create a token at https://github.com/settings/tokens with "repo" scope and set GITHUB_TOKEN in .env. ' +
            'Ensure the token is not expired and the account has access to this repo.'
        );
      }
      if (status === 403 || /forbidden|resource not accessible/i.test(msg)) {
        throw new Error(
          `GITHUB_TOKEN lacks permission for ${plan.owner}/${plan.repo}: ${msg}. ` +
            'Token needs "repo" scope and the account must have access to this repository.'
        );
      }
      if (status === 404 || /not found/i.test(msg)) {
        throw new Error(
          `Repository ${plan.owner}/${plan.repo} not found or not accessible: ${msg}. ` +
            'Check the repo exists and your token has access.'
        );
      }
      throw err;
    }
    spinner.succeed('Token valid');
  }

  spinner.start('Checking target branch on remote...');
  ensureTargetBranchExistsOnRemote(cloneUrl, plan.targetBranch, config.githubToken);
  spinner.succeed(`Target branch ${plan.targetBranch} exists`);

  const splitBranches = [...new Set([plan.targetBranch, ...plan.splits.map(s => s.newBranch).filter((b): b is string => b != null)])];
  spinner.start('Cloning repository (source branch)...');
  const { git } = await cloneOrUpdate(cloneUrl, plan.sourceBranch, workdir, config.githubToken, {
    additionalBranches: splitBranches,
  });
  spinner.succeed(`Workdir: ${workdir}`);

  // Fail fast if target branch is missing in workdir (e.g. additionalBranches fetch warned but continued).
  if (!options.dryRun) {
    await ensureTargetRefOrFetch(git, plan.targetBranch, workdir);
  }

  let executedCount = 0;
  let prsCreated = 0;
  let prsReused = 0;
  let skippedNothingToPush = 0;
  const prUrls: string[] = [];
  const failedSplits: { split: ParsedSplit; index: number; error: Error }[] = [];
  for (let i = 0; i < plan.splits.length; i++) {
    const split = plan.splits[i];
    const n = i + 1;
    console.log(chalk.cyan(`\n[${n}/${plan.splits.length}] ${split.title}`));
    if (split.files.length === 0 && split.commits.length === 0) {
      console.log(chalk.yellow('  No **Files:** nor **Commits:** listed — skipping'));
      if (split.rawCommitLines.length > 0) {
        console.log(chalk.gray('  Parser saw commit section:'));
        split.rawCommitLines.forEach((l) => console.log(chalk.gray('    ' + l)));
      } else {
        console.log(chalk.gray('  Add **Files:** (recommended) or **Commits:** for this split.'));
      }
      continue;
    }
    if (options.dryRun) {
      if (split.files.length > 0) {
        console.log(chalk.gray(`  Dry run: would apply ${formatNumber(split.files.length)} file(s) from source (new commit)`));
      } else {
        console.log(chalk.gray(`  Dry run: would cherry-pick ${formatNumber(split.commits.length)} commits`));
      }
      if (split.routeToPrNumber != null) console.log(chalk.gray(`  Route to PR #${split.routeToPrNumber}`));
      if (split.newBranch != null) console.log(chalk.gray(`  New PR branch: ${split.newBranch}`));
      continue;
    }
    try {
      const outcome = await executeSplit(git, plan, split, github, config.githubToken, workdir, spinner, options.forcePush);
      executedCount++;
      if (outcome?.prCreated) prsCreated++;
      if (outcome?.prReused) prsReused++;
      if (outcome?.nothingToPush) skippedNothingToPush++;
      if (outcome?.nothingToPush) {
        console.log(chalk.blue(`  ℹ Nothing to push for split ${n} — remote already contains these commits (likely from a previous run).`));
      }
      if (outcome) {
        if (outcome.nothingToPush) {
          const prPart = outcome.prNumber != null ? ` — PR #${outcome.prNumber} (open)` : '';
          console.log(chalk.gray(`  [${n}] Already up-to-date${prPart}`));
        } else {
          const prPart = outcome.prNumber != null
            ? ` — PR #${outcome.prNumber} (${outcome.prCreated ? 'created' : 'updated'})`
            : '';
          console.log(chalk.gray(`  [${n}] Pushed${prPart}`));
        }
        if (outcome.prUrl) {
          console.log(chalk.cyan(`      ${outcome.prUrl}`));
          prUrls.push(outcome.prUrl);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      spinner.fail(`Failed: ${error.message}`);
      if (isAuthError(error)) {
        throw new Error(
          'GitHub authentication failed. Set GITHUB_TOKEN in .env (create a token at https://github.com/settings/tokens with "repo" scope). ' +
            'GitHub does not support password auth for Git operations.\n' + error.message
        );
      }
      failedSplits.push({ split, index: n, error });
      // Return to source branch so next split can create its branch from origin/target.
      await git.checkout(plan.sourceBranch).catch(() => {});
    }
  }

  if (plan.splits.length > 0 && executedCount === 0 && !options.dryRun && failedSplits.length === 0) {
    throw new Error('No splits executed (all had no commits listed). Fix the plan file or parser.');
  }
  if (failedSplits.length > 0) {
    console.log(chalk.red(`\n${formatNumber(failedSplits.length)} split(s) failed:`));
    const sameMessage = failedSplits.every(({ error }) => error.message === failedSplits[0].error.message);
    if (sameMessage && failedSplits.length > 1) {
      console.log(chalk.red(`  ${failedSplits[0].error.message}`));
      failedSplits.forEach(({ split, index }) => {
        console.log(chalk.red(`  [${index}] ${split.title}`));
      });
    } else {
      failedSplits.forEach(({ split, index, error }) => {
        console.log(chalk.red(`  [${index}] ${split.title}: ${error.message}`));
      });
    }
    const allPushFailures = failedSplits.every(({ error }) => /Push to .+ failed/i.test(error.message));
    const anyAuthFailure = failedSplits.some(({ error }) => isAuthError(error));
    if (allPushFailures && failedSplits.length > 0 && !anyAuthFailure) {
      console.log(chalk.yellow('\n  Re-run with --force-push to overwrite remote branches, or resolve conflicts in the workdir and push manually.'));
    }
    throw new Error(
      `${formatNumber(failedSplits.length)} of ${plan.splits.length} split(s) failed. Fix errors above and re-run, or edit the plan.`
    );
  }
  console.log(chalk.green('\nDone.'));
  const pushed = executedCount - skippedNothingToPush;
  const summaryParts: string[] = [];
  if (executedCount > 0) {
    if (pushed > 0) summaryParts.push(`${formatNumber(pushed)} pushed`);
    if (prsCreated > 0) summaryParts.push(`${formatNumber(prsCreated)} PR(s) created`);
    if (prsReused > 0) summaryParts.push(`${formatNumber(prsReused)} existing PR(s) updated`);
    if (skippedNothingToPush > 0) summaryParts.push(`${formatNumber(skippedNothingToPush)} already up-to-date`);
    console.log(chalk.gray(`  ${formatNumber(executedCount)}/${plan.splits.length} splits — ${summaryParts.join(', ')}`));
  }
  if (skippedNothingToPush > 0 && skippedNothingToPush === executedCount) {
    console.log(chalk.yellow(
      '  All splits were already up-to-date (remote likely had these commits from a previous run). If you expected new changes, check that the source branch has commits not yet on the split branches.'
    ));
    if (prUrls.length > 0) {
      console.log(chalk.cyan(`  Open PRs: ${prUrls.join('  ')}`));
    }
  } else if (prUrls.length > 0) {
    console.log(chalk.cyan(`  PRs: ${prUrls.join('  ')}`));
  }

  // Machine-readable exit: CI can distinguish "all up-to-date" from "pushed new changes".
  if (!options.dryRun && plan.splits.length > 0 && executedCount > 0) {
    if (skippedNothingToPush === executedCount) {
      process.exitCode = 2; // All splits already up-to-date; nothing pushed.
    }
    // Otherwise exitCode stays 0 (some or all splits pushed).
  }
}

/** Ensure origin/<targetBranch> exists; if not, add refspec and fetch. Throw with workdir hint if still missing. */
async function ensureTargetRefOrFetch(
  git: SimpleGit,
  targetBranch: string,
  workdir: string
): Promise<void> {
  const ref = `origin/${targetBranch}`;
  try {
    await git.raw(['rev-parse', '--verify', ref]);
    return;
  } catch {
    try {
      await git.raw(['remote', 'set-branches', '--add', 'origin', targetBranch]);
      await git.fetch('origin', targetBranch);
      await git.raw(['rev-parse', '--verify', ref]);
      return;
    } catch {
      throw new Error(
        `Target branch ${targetBranch} does not exist on remote. Create it first or update the split plan. Workdir: ${workdir} — to fetch manually: cd ${workdir} && git fetch origin ${targetBranch}`
      );
    }
  }
}

/**
 * Return true if origin/<branch> exists and we have no commits to push (remote already has our tip).
 * Fetches the branch first so we compare against latest. Used to skip push when re-running and remote
 * already has the commits, avoiding reject + rebase + second push.
 */
async function isBranchAlreadyUpToDate(git: SimpleGit, branch: string): Promise<boolean> {
  const ref = `origin/${branch}`;
  try {
    await git.raw(['remote', 'set-branches', '--add', 'origin', branch]);
    await git.fetch('origin', branch);
  } catch {
    // Branch may not exist on remote yet (first push); proceed to push.
    return false;
  }
  try {
    await git.raw(['rev-parse', '--verify', ref]);
  } catch {
    return false; // No ref yet
  }
  try {
    const out = await git.raw(['rev-list', '--count', `${ref}..HEAD`]);
    const n = parseInt(out.trim(), 10);
    return Number.isNaN(n) ? false : n === 0;
  } catch {
    return false;
  }
}

/** Outcome of a completed split (undefined when split was skipped without attempting push). */
type SplitOutcome = {
  prCreated: boolean;
  nothingToPush: boolean;
  prReused?: boolean;
  prUrl?: string;
  prNumber?: number;
  nothingToPushAfterRebase?: boolean;
} | undefined;

/** Verify each commit SHA exists in the repo; throw with clear message so we fail fast before cherry-pick. */
async function verifyCommitShasInRepo(git: SimpleGit, split: ParsedSplit): Promise<void> {
  for (const sha of split.commits) {
    try {
      const type = (await git.raw(['cat-file', '-t', sha])).trim();
      if (type !== 'commit') {
        throw new Error(`git cat-file returned "${type}", expected "commit"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Commit ${sha} referenced in split ${split.index} ("${split.title}") not found in repo. ${msg}`);
    }
  }
}

/** Execute one split: checkout target branch, cherry-pick commits, push, create PR if new. */
async function executeSplit(
  git: SimpleGit,
  plan: ParsedPlan,
  split: ParsedSplit,
  github: GitHubAPI,
  githubToken: string,
  workdir: string,
  spinner: Ora,
  forcePush: boolean
): Promise<SplitOutcome> {
  let branchToPush: string;

  if (split.routeToPrNumber != null) {
    // Route-to modifies an existing PR's branch (cherry-pick + force-push).
    // Disabled: too risky — if something goes wrong the existing PR is corrupted
    // and requires manual recovery. Use "New PR" splits instead and close the old PR.
    throw new Error(
      `Route-to PR #${split.routeToPrNumber} is disabled (modifying existing PR branches is too risky). ` +
      `Change the plan to use **New PR:** instead, then close the old PR after the new one is merged.`
    );
  } else if (split.newBranch != null) {
    branchToPush = split.newBranch;
    await ensureTargetRefOrFetch(git, plan.targetBranch, workdir);
    spinner.start(`Creating branch ${branchToPush} from ${plan.targetBranch}...`);
    try {
      // Delete stale local branch from a previous run so -b doesn't fail with "already exists".
      await git.raw(['branch', '-D', branchToPush]).catch(() => {});
      await git.checkout(['-b', branchToPush, `origin/${plan.targetBranch}`]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('is not a commit') || msg.includes('not found')) {
        throw new Error(
          `Could not create branch ${branchToPush} from origin/${plan.targetBranch}. Ensure the target branch exists on the remote. Workdir: ${workdir} — try: cd ${workdir} && git fetch origin ${plan.targetBranch}`
        );
      }
      throw err;
    }
    spinner.succeed(`Branch ${branchToPush} created`);
  } else {
    console.log(chalk.yellow('  Split has neither Route to nor New PR — skipping'));
    return undefined;
  }

  if (split.files.length > 0) {
    // File-based: copy only these files from source branch and make one new commit.
    // WHY: Cherry-pick is all-or-nothing per commit; a commit that touches both workflow and ticker
    // would pollute a "workflow-only" PR. Applying by file gives one clean commit per split.
    spinner.start(`Applying ${formatNumber(split.files.length)} file(s) from ${plan.sourceBranch}...`);
    try {
      await git.raw(['checkout', plan.sourceBranch, '--', ...split.files]);
      const status = await git.status();
      const staged = status.staged.length;
      if (staged === 0) {
        spinner.warn('No changes (files match target); nothing to commit');
        return { prCreated: false, nothingToPush: false };
      }
      const commitTitle = split.prTitle ?? split.title;
      await git.commit(commitTitle);
      spinner.succeed(`Committed ${formatNumber(staged)} file(s): ${commitTitle}`);
    } catch (err) {
      spinner.fail(`Apply failed`);
      throw new Error(
        `Could not apply files from ${plan.sourceBranch}. Check paths exist and resolve in ${workdir}. ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    await verifyCommitShasInRepo(git, split);
    for (let c = 0; c < split.commits.length; c++) {
      const sha = split.commits[c];
      spinner.start(`Cherry-picking ${sha.slice(0, 7)} (${c + 1}/${split.commits.length})...`);
      try {
        await git.raw(['cherry-pick', sha]);
        spinner.succeed(`Cherry-picked ${sha.slice(0, 7)}`);
      } catch (err) {
        spinner.fail(`Cherry-pick failed for ${sha}`);
        await git.raw(['cherry-pick', '--abort']).catch(() => {});
        throw new Error(
          `Conflict or error cherry-picking ${sha}. Resolve in ${workdir} and run again, or edit the plan and skip this commit.`
        );
      }
    }
  }

  console.log(chalk.gray(`  Pushing ${branchToPush}...`));
  spinner.start(`Pushing ${branchToPush}...`);
  let nothingToPush = false;
  let nothingToPushAfterRebase = false;
  let existingPRWhenNothingToPush: { number: number; url: string } | null = null;
  try {
    // When not force-pushing: if remote already has our commits, skip the push to avoid reject + rebase + second push.
    if (!forcePush) {
      const alreadyUpToDate = await isBranchAlreadyUpToDate(git, branchToPush);
      if (alreadyUpToDate) {
        nothingToPush = true;
        const existingPR = await findExistingPR(github, plan.owner, plan.repo, branchToPush, plan.targetBranch);
        existingPRWhenNothingToPush = existingPR;
        if (existingPR) {
          spinner.info(`Nothing to push (already up to date) — PR #${existingPR.number} is open: ${existingPR.url}`);
        } else {
          spinner.info(`Nothing to push — remote already has these commits (likely from a previous run).`);
        }
      }
    }
    if (!nothingToPush) {
    const pushResult = await pushWithRetry(git, branchToPush, {
      force: forcePush,
      githubToken,
      maxRetries: 2,
      onPullNeeded: () => { spinner.text = `Push rejected (remote has newer commits); rebasing on origin/${branchToPush} and retrying...`; },
      onConflict: async (conflictedFiles: string[]) => {
        const workflowFiles = conflictedFiles.filter(f => f.startsWith('.github/workflows/'));
        if (workflowFiles.length !== conflictedFiles.length) return false;
        spinner.text = 'Resolving workflow file conflicts (checkout --theirs)...';
        for (const file of workflowFiles) {
          await git.raw(['checkout', '--theirs', '--', file]);
          await git.add(file);
        }
        return true;
      },
    });
    nothingToPush = pushResult.nothingToPush === true;
    nothingToPushAfterRebase = pushResult.nothingToPushAfterRebase === true;
    if (nothingToPush) {
      const existingPR = await findExistingPR(github, plan.owner, plan.repo, branchToPush, plan.targetBranch);
      existingPRWhenNothingToPush = existingPR;
      if (existingPR) {
        spinner.info(`Nothing to push (already up to date) — PR #${existingPR.number} is open: ${existingPR.url}`);
      } else {
        const reason = nothingToPushAfterRebase
          ? 'Remote already had these commits after rebase (likely from a previous run).'
          : 'Remote already has these commits; skipping PR creation';
        spinner.info(`Nothing to push — ${reason}`);
      }
    } else {
      spinner.succeed(`Pushed ${branchToPush}`);
    }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    spinner.fail(`Push failed: ${msg}`);
    const isRejected = /rejected|newer commits|non-fast-forward|Push failed after \d+ attempts/i.test(msg);
    const hint = isRejected
      ? `Push rejected because remote branch has newer commits. Re-run with --force-push to overwrite, or pull and resolve manually in ${workdir}.`
      : `Fix in ${workdir} and push manually if needed.`;
    throw new Error(`Push to ${branchToPush} failed. ${hint}\n${msg}`);
  }

  if (split.newBranch != null && !nothingToPush) {
    const prTitle = split.prTitle ?? split.title;

    // Check for an existing open PR from this branch before creating a new one.
    spinner.start('Checking for existing PR...');
    const existingPR = await findExistingPR(github, plan.owner, plan.repo, branchToPush, plan.targetBranch);
    if (existingPR) {
      spinner.succeed(`Existing PR #${existingPR.number} updated: ${existingPR.url}`);
      return { prCreated: false, nothingToPush: false, prReused: true, prUrl: existingPR.url, prNumber: existingPR.number };
    }

    spinner.start('Creating pull request...');
    try {
      const { number, url } = await github.createPullRequest(
        plan.owner,
        plan.repo,
        branchToPush,
        plan.targetBranch,
        prTitle,
        `Split from plan (${plan.sourcePrUrl}).\n\n${prTitle}`
      );
      spinner.succeed(`PR #${number}: ${url}`);
      return { prCreated: true, nothingToPush: false, prUrl: url, prNumber: number };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.fail(`PR creation failed: ${msg}`);
      throw new Error(`PR creation failed for "${split.title}": ${msg}. Branch ${branchToPush} was pushed; create the PR manually or fix and re-run.`);
    }
  }
  return {
    prCreated: false,
    nothingToPush,
    nothingToPushAfterRebase,
    prUrl: existingPRWhenNothingToPush?.url,
    prNumber: existingPRWhenNothingToPush?.number,
  };
}

/**
 * Find an open PR whose head branch is `head`. Returns the PR number and URL if one exists.
 * Uses a single getOpenPRs(owner, repo) call (no base filter) so we find the PR even if
 * it was retargeted to a different base than the plan's target_branch.
 */
async function findExistingPR(
  github: GitHubAPI,
  owner: string,
  repo: string,
  head: string,
  _base: string
): Promise<{ number: number; url: string } | null> {
  try {
    const openPRs = await github.getOpenPRs(owner, repo);
    const match = openPRs.find(pr => pr.branch === head);
    if (match) {
      return { number: match.number, url: `https://github.com/${owner}/${repo}/pull/${match.number}` };
    }
    return null;
  } catch (err) {
    debug('Failed to check for existing PR, will create new', { err: String(err) });
    return null;
  }
}