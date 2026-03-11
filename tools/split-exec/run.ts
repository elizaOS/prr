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
import { push } from '../../shared/git/git-push.js';
import type { SimpleGit } from 'simple-git';
import { debug, formatNumber } from '../../shared/logger.js';

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

  spinner.start('Checking target branch on remote...');
  ensureTargetBranchExistsOnRemote(cloneUrl, plan.targetBranch, config.githubToken);
  spinner.succeed(`Target branch ${plan.targetBranch} exists`);

  spinner.start('Cloning repository (source branch)...');
  const { git } = await cloneOrUpdate(cloneUrl, plan.sourceBranch, workdir, config.githubToken, {
    additionalBranches: [plan.targetBranch],
  });
  spinner.succeed(`Workdir: ${workdir}`);

  const github = new GitHubAPI(config.githubToken);

  // Fail fast if target branch is missing in workdir (e.g. additionalBranches fetch warned but continued).
  if (!options.dryRun) {
    await ensureTargetRefOrFetch(git, plan.targetBranch, workdir);
  }

  let executedCount = 0;
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
      await executeSplit(git, plan, split, github, config.githubToken, workdir, spinner);
      executedCount++;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      spinner.fail(`Failed: ${error.message}`);
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
    throw new Error(
      `${formatNumber(failedSplits.length)} of ${plan.splits.length} split(s) failed. Fix errors above and re-run, or edit the plan.`
    );
  }
  console.log(chalk.green('\nDone.'));
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

/** Execute one split: checkout target branch, cherry-pick commits, push, create PR if new. */
async function executeSplit(
  git: SimpleGit,
  plan: ParsedPlan,
  split: ParsedSplit,
  github: GitHubAPI,
  githubToken: string,
  workdir: string,
  spinner: Ora
): Promise<void> {
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
    return;
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
        return;
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

  spinner.start(`Pushing ${branchToPush}...`);
  const pushResult = await push(git, branchToPush, false, githubToken);
  if (!pushResult.success) {
    spinner.fail(`Push failed: ${pushResult.error ?? 'unknown'}`);
    throw new Error(`Push to ${branchToPush} failed. Fix in ${workdir} and push manually if needed.`);
  }
  if (pushResult.nothingToPush) {
    spinner.info('Nothing to push (already up to date)');
  } else {
    spinner.succeed(`Pushed ${branchToPush}`);
  }

  if (split.newBranch != null) {
    spinner.start('Creating pull request...');
    const prTitle = split.prTitle ?? split.title;
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.fail(`PR creation failed: ${msg}`);
      throw new Error(`PR creation failed for "${split.title}": ${msg}. Branch ${branchToPush} was pushed; create the PR manually or fix and re-run.`);
    }
  }
}