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
    .option('--force-push', 'On push rejection (remote has newer commits), force-push to overwrite (use when re-running a plan)', false);

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
    },
  };
}
