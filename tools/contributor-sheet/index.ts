#!/usr/bin/env node
/**
 * contributor-sheet — PR history + heuristic / LLM "character sheet" for a GitHub author in one repo.
 *
 * Uses the same GitHub token and optional LLM stack as PRR (`loadConfig`, `LLMClient`).
 */
import chalk from 'chalk';
import { loadConfig } from '../../shared/config.js';
import { initOutputLog, closeOutputLog, setVerbose, getOutputLogPath } from '../../shared/logger.js';
import { createCLI, parseArgs } from './cli.js';
import { parseRepoSpec, normalizeGithubLogin } from './parse-input.js';
import { runContributorSheet } from './run.js';

try {
  initOutputLog({ prefix: 'contributor-sheet' });
} catch (err) {
  console.warn('Warning: Could not initialize output log:', err);
}

async function main(): Promise<void> {
  const program = createCLI();
  let parsed;
  try {
    parsed = parseArgs(program);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }

  setVerbose(parsed.options.verbose);
  if (parsed.options.verbose) {
    process.env.DEBUG = process.env.DEBUG || 'prr:*';
  }

  let owner: string;
  let repo: string;
  let author: string;
  try {
    ({ owner, repo } = parseRepoSpec(parsed.repoRaw));
    author = normalizeGithubLogin(parsed.author);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
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

  console.log(chalk.cyan('\ncontributor-sheet') + chalk.gray(' — PR history & author profile\n'));

  try {
    const content = await runContributorSheet(owner, repo, author, config, parsed.options);
    if (!parsed.options.output) {
      console.log(content);
    }
    const logPath = getOutputLogPath();
    if (logPath) console.log(chalk.gray(`\nOutput log: ${logPath}`));
    await closeOutputLog();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }
}

main();
