/**
 * split-rewrite-plan runner: read group plan, clone or use workdir, compute ordered ops per split, write rewrite plan.
 * WHY separate tool: split-plan stays clone-free; this tool does the clone and git analysis.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { parsePlanFile, type ParsedPlan, type ParsedSplit } from '../split-exec/parse-plan.js';
import { cloneOrUpdate } from '../../shared/git/git-clone-index.js';
import { loadConfig } from '../../shared/config.js';
import { debug, formatNumber } from '../../shared/logger.js';
import { stringify as stringifyYaml } from 'yaml';
import type { Config } from '../../shared/config.js';
import type { SplitRewritePlanOptions } from './cli.js';
import type { RewritePlan, RewritePlanSplit } from '../split-exec/rewrite-plan.js';

/** Normalize path for comparison: strip leading ./, use forward slashes. WHY: Plan and git may use ./ or different separators; normalize so file→split lookup matches diff-tree output. */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/').trim();
}

type SplitEntry = { branchName: string; splitIndex: number };

/** Build map: normalized file path → { branchName, splitIndex }. First occurrence wins; warn on duplicate. WHY: Each file must map to exactly one split so we don't emit the same path in two commit-from-sha ops (would duplicate changes on two branches). */
function buildFileToSplit(plan: ParsedPlan): Map<string, SplitEntry> {
  const map = new Map<string, SplitEntry>();
  for (const split of plan.splits) {
    if (!split.newBranch) continue;
    for (const file of split.files) {
      const norm = normalizePath(file);
      if (!norm) continue;
      if (map.has(norm)) {
        console.warn(chalk.yellow(`  File in multiple splits (using first): ${norm}`));
        continue;
      }
      map.set(norm, { branchName: split.newBranch, splitIndex: split.index });
    }
  }
  return map;
}

/**
 * Build a sorted array of directory prefixes → split entry, derived from the explicit file paths
 * in the plan. For each file, every ancestor directory is a candidate prefix for that split.
 * Longest prefix wins at lookup time.
 * WHY: LLMs write "All files under X" or globs; the parser only captures literal paths.
 * Directory-prefix fallback routes unlisted siblings to the split that owns the most specific
 * ancestor, so commits that touch files not explicitly listed still get assigned.
 */
function buildPrefixIndex(fileToSplit: Map<string, SplitEntry>): Array<{ prefix: string; entry: SplitEntry }> {
  const prefixToEntry = new Map<string, SplitEntry>();
  for (const [filePath, entry] of fileToSplit) {
    const parts = filePath.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/') + '/';
      if (!prefixToEntry.has(prefix)) {
        prefixToEntry.set(prefix, entry);
      }
    }
  }
  const index = [...prefixToEntry.entries()]
    .map(([prefix, entry]) => ({ prefix, entry }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return index;
}

/** Look up a path: exact match first, then longest directory prefix. */
function resolvePathToSplit(
  path: string,
  fileToSplit: Map<string, SplitEntry>,
  prefixIndex: Array<{ prefix: string; entry: SplitEntry }>
): SplitEntry | undefined {
  const exact = fileToSplit.get(path);
  if (exact) return exact;
  for (const { prefix, entry } of prefixIndex) {
    if (path.startsWith(prefix)) return entry;
  }
  return undefined;
}

/** Get commit SHAs in source..target order (oldest first). Uses first-parent for linear order. WHY first-parent: Merge commits would duplicate or reorder; first-parent gives one linear sequence. WHY reverse: git log is newest-first; we need oldest-first so replay order matches PR history. */
async function getCommitShasInOrder(
  git: { raw: (args: string[]) => Promise<string> },
  targetBranch: string,
  sourceBranch: string
): Promise<string[]> {
  const refTarget = `origin/${targetBranch}`;
  const refSource = sourceBranch === 'HEAD' ? 'HEAD' : sourceBranch;
  const out = await git.raw(['log', `${refTarget}..${refSource}`, '--first-parent', '--format=%H']);
  const shas = out.trim().split('\n').filter(Boolean);
  return shas.reverse();
}

/** Get changed paths for a commit (relative to repo root, as returned by git). */
async function getChangedPaths(
  git: { raw: (args: string[]) => Promise<string> },
  sha: string
): Promise<string[]> {
  const out = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-only', sha]);
  return out.trim().split('\n').filter(Boolean);
}

/** Get first line of commit message for a SHA. */
async function getCommitSubject(git: { raw: (args: string[]) => Promise<string> }, sha: string): Promise<string> {
  const out = await git.raw(['log', '-1', '--format=%s', sha]);
  return out.trim();
}

export async function runSplitRewritePlan(
  planPath: string,
  config: Config,
  options: SplitRewritePlanOptions
): Promise<void> {
  if (!existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }
  const spinner = ora();
  spinner.start('Parsing group plan...');
  const plan: ParsedPlan = parsePlanFile(planPath);
  spinner.succeed(`Plan: ${plan.splits.length} splits (${plan.sourceBranch} → ${plan.targetBranch})`);

  const workdir = options.workdir ?? join(process.cwd(), '.split-rewrite-plan-workdir');
  const cloneUrl = `https://github.com/${plan.owner}/${plan.repo}.git`;
  spinner.start('Cloning or updating repository...');
  const { git } = await cloneOrUpdate(cloneUrl, plan.sourceBranch, workdir, config.githubToken, {
    additionalBranches: [plan.targetBranch],
  });
  spinner.succeed(`Workdir: ${workdir}`);

  const sourceTipSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
  spinner.start('Computing commit order...');
  const commitShas = await getCommitShasInOrder(git, plan.targetBranch, plan.sourceBranch);
  spinner.succeed(`${formatNumber(commitShas.length)} commit(s) on source since target`);

  const fileToSplit = buildFileToSplit(plan);
  const prefixIndex = buildPrefixIndex(fileToSplit);

  const splitsByBranch = new Map<string, RewritePlanSplit>();
  for (const split of plan.splits) {
    if (!split.newBranch) continue;
    splitsByBranch.set(split.newBranch, {
      branchName: split.newBranch,
      splitIndex: split.index,
      ops: [],
    });
  }

  const planFilesSet = new Set(fileToSplit.keys());
  const touchedByCommits = new Set<string>();
  let skippedCommits = 0;
  let prefixFallbackCount = 0;

  for (const sha of commitShas) {
    const paths = await getChangedPaths(git, sha);
    const pathToBranch = new Map<string, string>();
    for (const p of paths) {
      const norm = normalizePath(p);
      touchedByCommits.add(norm);
      const entry = resolvePathToSplit(norm, fileToSplit, prefixIndex);
      if (entry) {
        pathToBranch.set(norm, entry.branchName);
        if (!fileToSplit.has(norm)) prefixFallbackCount++;
      }
    }

    const assignedByBranch = new Map<string, string[]>();
    for (const p of paths) {
      const norm = normalizePath(p);
      const branch = pathToBranch.get(norm);
      if (!branch) continue;
      let list = assignedByBranch.get(branch);
      if (!list) {
        list = [];
        assignedByBranch.set(branch, list);
      }
      list.push(p);
    }

    const assignedBranches = [...assignedByBranch.keys()];
    if (assignedBranches.length === 0) {
      skippedCommits++;
      if (options.verbose) {
        console.log(chalk.yellow(`  Skipped commit ${sha.slice(0, 7)} (no paths in any split)`));
      }
      continue;
    }

    // Exactly one split and all changed paths belong to it → single cherry-pick. Else → commit-from-sha per split with that split's paths (mixed commit or multiple splits).
    if (assignedBranches.length === 1 && assignedByBranch.get(assignedBranches[0])!.length === paths.length) {
      const branch = assignedBranches[0];
      const split = splitsByBranch.get(branch)!;
      split.ops.push({ type: 'cherry-pick', sha });
    } else {
      const subject = await getCommitSubject(git, sha);
      const shortSha = sha.slice(0, 7);
      const message = `From ${shortSha}: ${subject}`;
      for (const branch of assignedBranches) {
        const pathsForSplit = assignedByBranch.get(branch)!;
        const split = splitsByBranch.get(branch)!;
        split.ops.push({
          type: 'commit-from-sha',
          sha,
          paths: pathsForSplit,
          message,
        });
      }
    }
  }

  if (prefixFallbackCount > 0) {
    console.log(chalk.gray(`  ${formatNumber(prefixFallbackCount)} path(s) assigned via directory-prefix fallback`));
  }
  if (skippedCommits > 0) {
    console.log(chalk.yellow(`  ${formatNumber(skippedCommits)} commit(s) skipped (only unassigned paths)`));
  }

  const splitsWithNoOps = [...splitsByBranch.values()].filter((s) => s.ops.length === 0);
  if (splitsWithNoOps.length > 0) {
    console.log(chalk.yellow(`  ${formatNumber(splitsWithNoOps.length)} split(s) have no ops: ${splitsWithNoOps.map((s) => s.branchName).join(', ')}`));
  }

  for (const file of planFilesSet) {
    if (!touchedByCommits.has(file)) {
      debug('split-rewrite-plan: file in plan not touched by any commit', { file });
    }
  }

  const rewritePlan: RewritePlan = {
    source_branch: plan.sourceBranch,
    source_tip_sha: sourceTipSha,
    target_branch: plan.targetBranch,
    generated_at: new Date().toISOString(),
    splits: [...splitsByBranch.values()].sort((a, b) => a.splitIndex - b.splitIndex),
  };

  const outputPath = options.output ?? join(dirname(planPath), '.split-rewrite-plan.yaml'); // WHY beside group plan: Same dir as .split-plan.md so split-exec can resolve rewrite plan by convention.
  const isJson = outputPath.endsWith('.json');
  const content = isJson
    ? JSON.stringify(rewritePlan, null, 2)
    : stringifyYaml(rewritePlan, { lineWidth: 0 });
  writeFileSync(outputPath, content, 'utf-8');
  console.log(chalk.green(`Wrote rewrite plan: ${outputPath}`));
}
