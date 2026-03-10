#!/usr/bin/env node
/**
 * split-exec — Execute a split plan produced by split-plan.
 *
 * Reads a .split-plan.md file, clones the source branch, then for each split
 * (in order): checkout the target branch (existing PR or new branch from base),
 * cherry-pick the listed commits, push, and create a new PR when the plan says
 * "New PR". Processes one split at a time so the user can fix conflicts or stop.
 *
 * WHY initOutputLog({ prefix: 'split-exec' }): Separate logs from split-plan/prr/story.
 */
import chalk from 'chalk';
import { loadConfig } from '../../shared/config.js';
import { initOutputLog, closeOutputLog, setVerbose } from '../../shared/logger.js';
import { createCLI, parseArgs, type SplitExecParsedArgs } from './cli.js';
import { runSplitExec } from './run.js';

try {
  initOutputLog({ prefix: 'split-exec', enablePill: true });
} catch (err) {
  console.warn('Warning: Could not initialize output log:', err);
}

async function main(): Promise<void> {
  const program = createCLI();
  let parsed: SplitExecParsedArgs;
  try {
    parsed = parseArgs(program);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }

  setVerbose(parsed.options.verbose);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }

  console.log(chalk.cyan('\nsplit-exec') + chalk.gray(' — execute split plan\n'));

  try {
    await runSplitExec(parsed.planPath, config, parsed.options);
    await closeOutputLog();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }
}

main();
