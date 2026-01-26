import { Command } from 'commander';
import chalk from 'chalk';
import type { FixerTool } from './config.js';

export interface CLIOptions {
  tool?: FixerTool;
  autoPush: boolean;
  keepWorkdir: boolean;
  maxFixIterations: number;
  maxPushIterations: number;
  pollInterval: number;
  dryRun: boolean;
  verbose: boolean;
}

export interface ParsedArgs {
  prUrl: string;
  options: CLIOptions;
}

const CAT_BANNER = `
    /\\_____/\\
   /  o   o  \\
  ( ==  ^  == )
   )         (
  (           )
 ( (  )   (  ) )
(__(__)___(__)__)

  ${chalk.cyan.bold('prr')} ${chalk.gray('v1.0.0')}
  ${chalk.dim("sits on your PR and won't get up until it's ready")}
`;

export function createCLI(): Command {
  const program = new Command();

  program
    .name('prr')
    .description('Automatically resolve LLM review bot comments on PRs')
    .version(CAT_BANNER, '-V, --version', 'output the version number')
    .argument('<pr-url>', 'GitHub PR URL (e.g., https://github.com/owner/repo/pull/123 or owner/repo#123)')
    .option('-t, --tool <tool>', 'LLM tool to use for fixing (auto-detects if not specified)')
    .option('--auto-push', 'Automatically push after fixes are verified', false)
    .option('--keep-workdir', 'Keep work directory after completion', false)
    .option('--max-fix-iterations <n>', 'Maximum fix iterations per push cycle', '10')
    .option('--max-push-iterations <n>', 'Maximum push/re-review cycles (auto-push mode)', '3')
    .option('--poll-interval <seconds>', 'Seconds to wait for bot re-review (auto-push mode)', '120')
    .option('--dry-run', 'Show unresolved issues without fixing', false)
    .option('-v, --verbose', 'Verbose output', false);

  return program;
}

export function parseArgs(program: Command): ParsedArgs {
  program.parse();

  const args = program.args;
  const opts = program.opts();

  if (args.length === 0) {
    program.help();
    process.exit(1);
  }

  return {
    prUrl: args[0],
    options: {
      tool: opts.tool as FixerTool | undefined,
      autoPush: opts.autoPush,
      keepWorkdir: opts.keepWorkdir,
      maxFixIterations: parseInt(opts.maxFixIterations, 10),
      maxPushIterations: parseInt(opts.maxPushIterations, 10),
      pollInterval: parseInt(opts.pollInterval, 10),
      dryRun: opts.dryRun,
      verbose: opts.verbose,
    },
  };
}
