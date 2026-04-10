#!/usr/bin/env node
/**
 * split-rewrite-plan — Generate a rewrite plan from a group plan and repo.
 *
 * Reads a .split-plan.md file, clones (or uses) the repo, analyzes commits on
 * source since target, and writes a .split-rewrite-plan.yaml (or .json) with
 * ordered ops per split (cherry-pick or commit-from-sha) for split-exec.
 * WHY separate from split-plan: split-plan stays clone-free; this tool needs a clone to run git log / diff-tree.
 */
import chalk from 'chalk';
import { loadConfig } from '../../shared/config.js';
import { createCLI, parseArgs, type SplitRewritePlanParsedArgs } from './cli.js';
import { runSplitRewritePlan } from './run.js';

async function main(): Promise<void> {
  const program = createCLI();
  let parsed: SplitRewritePlanParsedArgs;
  try {
    parsed = parseArgs(program);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    process.exit(1);
  }

  console.log(chalk.cyan('\nsplit-rewrite-plan') + chalk.gray(' — generate rewrite plan from group plan\n'));

  try {
    await runSplitRewritePlan(parsed.planPath, config, parsed.options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    process.exit(1);
  }
}

main();
