/**
 * CLI for the split-plan tool: parse PR URL and options.
 * WHY Commander: Same as prr/pill/story; consistent option parsing and help output.
 * WHY PR URL only: Decomposition only makes sense for an existing PR; we need getPRInfo, getPRCommits, getPRFilesWithPatches from the GitHub PR API.
 */
import { Command } from 'commander';
import chalk from 'chalk';

export interface SplitPlanOptions {
  output?: string;
  verbose: boolean;
  /** Budget for total patch content in the prompt (chars). WHY: Prevents context overflow on large PRs. */
  maxPatchChars: number;
}

export interface SplitPlanParsedArgs {
  prUrl: string;
  options: SplitPlanOptions;
}

export function createCLI(): Command {
  const program = new Command();
  program
    .name('split-plan')
    .description(
      'Analyze a PR and output a human-editable decomposition plan (.split-plan.md). Accepts a PR URL only.'
    )
    .argument(
      '<pr-url>',
      'PR URL (e.g. https://github.com/owner/repo/pull/123 or owner/repo#123)'
    )
    .option('-o, --output <file>', 'Write plan to this file (default: .split-plan.md in cwd)')
    .option('-v, --verbose', 'Verbose logging', false)
    .option(
      '--max-patch-chars <n>',
      'Max total patch content in prompt (chars). Default 120000.',
      '120000'
    );

  return program;
}

export function parseArgs(program: Command): SplitPlanParsedArgs {
  program.parse();
  const args = program.args as string[];
  const opts = program.opts();
  if (args.length === 0) {
    program.outputHelp();
    process.exit(1);
  }
  // WHY parseInt: Commander returns option values as strings; we must parse and validate.
  const maxPatchChars = parseInt(String(opts.maxPatchChars ?? '120000'), 10);
  if (Number.isNaN(maxPatchChars) || maxPatchChars < 10000) {
    console.error(chalk.red('Error:'), '--max-patch-chars must be a number >= 10000');
    process.exit(1);
  }
  const output = opts.output ? String(opts.output).trim() : undefined;
  return {
    prUrl: args[0],
    options: {
      output: output && output.length > 0 ? output : undefined,
      verbose: opts.verbose ?? false,
      maxPatchChars,
    },
  };
}
