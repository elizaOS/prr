#!/usr/bin/env node
/**
 * split-plan — PR decomposition planner.
 *
 * Analyzes a large PR (diffs, commits, dependencies), discovers open PRs as buckets,
 * and outputs a human-editable .split-plan.md for decomposition. Default output is
 * a file; the plan is consumed by split-exec (future) or edited manually.
 *
 * WHY initOutputLog({ prefix: 'split-plan' }): Writes split-plan-output.log and
 * split-plan-prompts.log so split-plan and prr/story/pill don't overwrite each other when run from the same dir.
 * WHY closeOutputLog() in every exit path: Parse error, config error, and runtime error all call it so the log is flushed and the pill hook (if enabled) runs exactly once; missing it leaves truncated logs or duplicate hook runs.
 */
import { writeFileSync } from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../../shared/config.js';
import { initOutputLog, closeOutputLog, setVerbose, setPillEnabled, getOutputLogPath, getDebugLogDir } from '../../shared/logger.js';
import { createCLI, parseArgs, type SplitPlanParsedArgs } from './cli.js';
import { runSplitPlan } from './run.js';

try {
  initOutputLog({ prefix: 'split-plan' });
} catch (err) {
  console.warn('Warning: Could not initialize output log:', err);
}

async function main(): Promise<void> {
  const program = createCLI();
  let parsed: SplitPlanParsedArgs;
  try {
    parsed = parseArgs(program);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }

  setVerbose(parsed.options.verbose);
  setPillEnabled(parsed.options.pill);
  if (parsed.options.verbose) {
    process.env.DEBUG = process.env.DEBUG || 'prr:*';
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }

  console.log(chalk.cyan('\nsplit-plan') + chalk.gray(' — PR decomposition planner\n'));

  // WHY default .split-plan.md: Plan is meant to be edited then fed to split-exec; file is primary, not stdout.
  const outputPath = parsed.options.output ?? '.split-plan.md';

  try {
    const content = await runSplitPlan(parsed.prUrl, config, parsed.options);
    writeFileSync(outputPath, content, 'utf-8');
    console.log(chalk.gray(`Plan written to ${outputPath}`));
    const logPath = getOutputLogPath();
    if (logPath) console.log(chalk.gray(`Output log: ${logPath}`));
    const debugDir = getDebugLogDir();
    if (parsed.options.verbose && debugDir) console.log(chalk.gray(`Debug logs: ${debugDir}`));
    await closeOutputLog();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }
}

main();
