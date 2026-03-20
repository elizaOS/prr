/**
 * CLI for split-rewrite-plan: parse group plan path and options.
 * WHY Commander: Same as split-exec/split-plan; consistent option parsing across tools.
 */
import { Command } from 'commander';

export interface SplitRewritePlanOptions {
  workdir?: string;
  output?: string;
  verbose: boolean;
}

export interface SplitRewritePlanParsedArgs {
  planPath: string;
  options: SplitRewritePlanOptions;
}

export function createCLI(): Command {
  const program = new Command();
  program
    .name('split-rewrite-plan')
    .description(
      'Generate a rewrite plan from a group plan (.split-plan.md) and repo: ordered ops per split (cherry-pick or commit-from-sha) for split-exec.'
    )
    .argument('[plan-file]', 'Path to .split-plan.md (from split-plan)')
    .option('-p, --plan-file <path>', 'Path to .split-plan.md (alternative to positional)')
    .option('-w, --workdir <dir>', 'Git workdir (clone here if not a repo; otherwise use existing repo)')
    .option('-o, --output <path>', 'Output path for rewrite plan (default: .split-rewrite-plan.yaml beside group plan)')
    .option('-v, --verbose', 'Verbose logging', false);

  return program;
}

export function parseArgs(program: Command): SplitRewritePlanParsedArgs {
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
      output: opts.output ? String(opts.output).trim() : undefined,
      verbose: opts.verbose ?? false,
    },
  };
}
