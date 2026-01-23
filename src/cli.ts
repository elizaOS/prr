import { Command } from 'commander';
import chalk from 'chalk';
import type { FixerTool } from './config.js';

export interface CLIOptions {
  tool: FixerTool;
  toolModel: string | undefined;
  autoPush: boolean;
  keepWorkdir: boolean;
  maxFixIterations: number;
  maxPushIterations: number;
  pollInterval: number;
  dryRun: boolean;
  noCommit: boolean;
  noPush: boolean;
  verbose: boolean;
  noBatch: boolean;
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
    .description('Automatically resolve PR review comments')
    .version(CAT_BANNER, '-V, --version', 'output the version number')
    .argument('<pr-url>', 'GitHub PR URL (e.g., https://github.com/owner/repo/pull/123 or owner/repo#123)')
    .option('-t, --tool <tool>', 'LLM tool to use for fixing (cursor, opencode, claude-code, aider, codex, llm-api)', 'cursor')
    .option('-m, --model <model>', 'Model for fixer tool (e.g., opus-4, sonnet-4-thinking, gpt-5)')
    .option('--auto-push', 'Automatically push after fixes are verified', false)
    .option('--keep-workdir', 'Keep work directory after completion', true)
    .option('--max-fix-iterations <n>', 'Maximum fix iterations per push cycle (0 = unlimited)', '0')
    .option('--max-push-iterations <n>', 'Maximum push/re-review cycles (0 = unlimited)', '0')
    .option('--poll-interval <seconds>', 'Seconds to wait for bot re-review (auto-push mode)', '120')
    .option('--dry-run', 'Show unresolved issues without fixing', false)
    .option('--no-commit', 'Make changes but do not commit (for testing)', true)
    .option('--commit', 'Actually commit changes (override --no-commit)')
    .option('--no-push', 'Commit locally but do not push (safer testing)', true)
    .option('-v, --verbose', 'Verbose debug output', true)
    .option('--no-batch', 'Disable batched LLM calls (one call per issue)', false);

  return program;
}

// Validate model name to prevent command injection
function validateModelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  
  // Only allow alphanumeric characters, hyphens, underscores, dots, and forward slashes
  // (forward slashes are needed for provider-prefixed names like "anthropic/claude-..." or "openrouter/anthropic/...")
  const validModelPattern = /^[A-Za-z0-9._\/-]+$/;
  if (!validModelPattern.test(model)) {
    console.error(chalk.red(`Invalid model name: "${model}"`));
    console.error(chalk.gray('Model names can only contain letters, numbers, hyphens, underscores, dots, and forward slashes.'));
    process.exit(1);
  }
  
  return model;
}

export function parseArgs(program: Command): ParsedArgs {
  program.parse();

  const args = program.args;
  const opts = program.opts();

  if (args.length === 0) {
    program.help();
    process.exit(1);
  }

  // Validate model name for security (prevent shell injection)
  const toolModel = validateModelName(opts.model);

  // --commit overrides --no-commit
  const noCommit = opts.commit ? false : (opts.noCommit ?? true);
  
  return {
    prUrl: args[0],
    options: {
      tool: opts.tool as FixerTool,
      toolModel,
      autoPush: opts.autoPush,
      keepWorkdir: opts.keepWorkdir ?? true,
      maxFixIterations: parseInt(opts.maxFixIterations, 10),
      maxPushIterations: parseInt(opts.maxPushIterations, 10),
      pollInterval: parseInt(opts.pollInterval, 10),
      dryRun: opts.dryRun,
      noCommit,
      noPush: opts.noPush ?? true,
      verbose: opts.verbose ?? true,
      noBatch: opts.noBatch ?? false,
    },
  };
}
