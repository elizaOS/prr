/**
 * CLI argument parsing and validation for prr.
 * 
 * WHY Commander.js: Battle-tested, handles complex option parsing including
 * the special --no-* negation syntax we rely on.
 * 
 * WHY defaults are "full automation": prr is designed to run unattended.
 * --auto-push=true, commit by default, push by default.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { validateTool, isValidModelName, type FixerTool } from './config.js';

export interface CLIOptions {
  tool: FixerTool | undefined;  // undefined = use PRR_TOOL env var or default
  toolModel: string | undefined;
  autoPush: boolean;
  keepWorkdir: boolean;
  maxFixIterations: number;
  maxPushIterations: number;
  maxStaleCycles: number;
  pollInterval: number;
  dryRun: boolean;
  noCommit: boolean;
  noPush: boolean;
  verbose: boolean;
  noBatch: boolean;
  reverify: boolean;
  maxContextChars: number;
  noBell: boolean;
  mergeBase: boolean;
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
    .option('-t, --tool <tool>', 'LLM tool to use for fixing (auto, cursor, opencode, claude-code, aider, codex, llm-api)')
    .option('-m, --model <model>', 'Model for fixer tool (e.g., claude-4-opus-thinking, claude-4-sonnet-thinking, o3)', (value) => {
      validateModelName(value);
      return value;
    })
    .option('--auto-push', 'Push and wait for bot re-review in a loop (full automation)', true)
    .option('--no-auto-push', 'Disable auto-push (just push once)')
    .option('--keep-workdir', 'Keep work directory after completion', true)
    .option('--max-fix-iterations <n>', 'Maximum fix iterations per push cycle (0 = unlimited)', '0')
    .option('--max-push-iterations <n>', 'Maximum push/re-review cycles (0 = unlimited)', '0')
    .option('--max-stale-cycles <n>', 'Bail out after N complete tool/model cycles with zero progress (default: 1)', '1')
    .option('--poll-interval <seconds>', 'Seconds to wait for bot re-review (auto-push mode)', '120')
    .option('--dry-run', 'Show unresolved issues without fixing', false)
    .option('--no-commit', 'Make changes but do not commit (for testing)')
    .option('--no-push', 'Commit but do not push')
    .option('-v, --verbose', 'Verbose debug output', true)
    .option('--no-batch', 'Disable batched LLM calls (slower, but more reliable for complex issues)')
    .option('--reverify', 'Ignore verification cache, re-check all "fixed" issues from scratch', false)
    .option('--max-context <chars>', 'Max characters per LLM batch (default: 400000)', '400000')
    .option('--no-bell', 'Disable terminal bell on completion')
    .option('--merge-base', 'Auto-merge base branch (main/master) into PR when conflicts detected', false);

  return program;
}

// Validate model name to prevent command injection
function validateModelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  
  if (!isValidModelName(model)) {
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

  // Model name already validated by option parser
  const toolModel = opts.model;
  
  // Tool is optional - if not specified, resolver will use PRR_TOOL env var or default
  const validatedTool = opts.tool ? validateTool(opts.tool) : undefined;
  
  // WHY this pattern: Commander.js handles --no-X specially.
  // It does NOT create opts.noX = true.
  // Instead, it creates opts.X with default true, set to false when --no-X is passed.
  // 
  // Example:
  //   .option('--no-commit', 'description')  // No default needed
  //   - User runs: prr <url>          -> opts.commit = true  (Commander default)
  //   - User runs: prr <url> --no-commit -> opts.commit = false
  //
  // So: noCommit = !opts.commit
  //   - !true = false  (user wants commits - default behavior)
  //   - !false = true  (user passed --no-commit)
  //
  // This is non-obvious and caused bugs. See DEVELOPMENT.md for details.
  return {
    prUrl: args[0],
    options: {
      tool: validatedTool,
      toolModel,
      autoPush: opts.autoPush ?? true,        // Default: full automation
      keepWorkdir: opts.keepWorkdir ?? true,
      maxFixIterations: parseInt(opts.maxFixIterations, 10),
      maxPushIterations: parseInt(opts.maxPushIterations, 10),
      maxStaleCycles: parseInt(opts.maxStaleCycles, 10) || 1,
      pollInterval: parseInt(opts.pollInterval, 10),
      dryRun: opts.dryRun,
      noCommit: !opts.commit,                 // --no-commit sets opts.commit=false
      noPush: !opts.push,                     // --no-push sets opts.push=false
      verbose: opts.verbose ?? true,
      noBatch: !opts.batch,                   // --no-batch sets opts.batch=false
      reverify: opts.reverify ?? false,
      maxContextChars: parseInt(opts.maxContext, 10) || 400_000,
      noBell: !opts.bell,                     // --no-bell sets opts.bell=false
      mergeBase: opts.mergeBase ?? false,     // Default: don't auto-merge base branch
    },
  };
}
