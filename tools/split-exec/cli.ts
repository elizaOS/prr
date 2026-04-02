/**
 * CLI for split-exec: parse plan file path and options.
 * WHY Commander: Same as prr/pill/story/split-plan; consistent option parsing.
 */
import { Command } from 'commander';
import chalk from 'chalk';

export interface SplitExecOptions {
  workdir?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  forcePush: boolean;
  /** Run pill analysis on output log when the run finishes. */
  pill: boolean;
  /** Path to rewrite plan (.split-rewrite-plan.md/.yaml/.json). If unset, looked up beside group plan. */
  rewritePlan?: string;
  /** Suffix for rebuild branch (e.g. -rebuild). When using rewrite plan, push to newBranch+suffix first. */
  rebuildSuffix: string;
  /** When true and rewrite plan was used, force-push each rebuild branch over the original branch. */
  promote: boolean;
}

export interface SplitExecParsedArgs {
  planPath: string;
  options: SplitExecOptions;
}

export function createCLI(): Command {
  const program = new Command();
  program
    .name('split-exec')
    .description(
      'Execute a split plan: clone repo, cherry-pick commits per split, push branches, create new PRs. Processes one split at a time (iterative).'
    )
    .argument('[plan-file]', 'Path to .split-plan.md (from split-plan); can also use --plan-file')
    .option('-p, --plan-file <path>', 'Path to .split-plan.md (alternative to positional)')
    .option('-w, --workdir <dir>', 'Git workdir for clone and cherry-picks (default: .split-exec-workdir in cwd)')
    .option('-n, --dry-run', 'Only parse plan and print what would be done; do not clone, cherry-pick, or push', false)
    .option('-y, --yes', 'Skip confirmation prompts (not used yet; for future per-split confirm)', false)
    .option('-v, --verbose', 'Verbose logging', false)
    .option('--force-push', 'On push rejection (remote has newer commits), force-push to overwrite (use when re-running a plan)', false)
    .option('--pill', 'Run pill analysis on the output log when the run finishes', false)
    .option('--rewrite-plan <path>', 'Path to rewrite plan (.split-rewrite-plan.md/.yaml/.json). If unset, looked up beside group plan.')
    .option('--rebuild-suffix <suffix>', 'Suffix for rebuild branch when using rewrite plan (default: -rebuild)', '-rebuild')
    .option('--promote', 'After building rebuild branches, force-push each over the original branch (use when satisfied)', false);

  return program;
}

export function parseArgs(program: Command): SplitExecParsedArgs {
  program.parse();
  const args = program.args as string[];
  const opts = program.opts();
  const planPath = (opts.planFile ?? args[0])?.trim();
  if (!planPath) {
    program.outputHelp();
    process.exit(1);
  }
  return {
    planPath,
    options: {
      workdir: opts.workdir ? String(opts.workdir).trim() : undefined,
      dryRun: opts.dryRun ?? false,
      yes: opts.yes ?? false,
      verbose: opts.verbose ?? false,
      forcePush: opts.forcePush ?? false,
      pill: opts.pill ?? false,
      rewritePlan: opts.rewritePlan ? String(opts.rewritePlan).trim() : undefined,
      rebuildSuffix: opts.rebuildSuffix != null ? String(opts.rebuildSuffix) : '-rebuild',
      promote: opts.promote ?? false,
    },
  };
}
