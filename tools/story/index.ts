#!/usr/bin/env node
/**
 * story - PR history → narrative, feature catalog, and changelog.
 *
 * Usage: story <pr-url> [--output file] [--verbose]
 * Fetches PR metadata, commits, and files; uses an LLM to build a coherent
 * story and a proper changelog (Added/Changed/Fixed).
 */
import chalk from 'chalk';
import { loadConfig } from '../../shared/config.js';
import { initOutputLog, closeOutputLog, setVerbose, getOutputLogPath, getDebugLogDir } from '../../shared/logger.js';
import { createCLI, parseArgs, type StoryParsedArgs } from './cli.js';
import { runStory, writeOutput } from './run.js';

try {
  initOutputLog({ prefix: 'story' });
} catch (err) {
  console.warn('Warning: Could not initialize output log:', err);
}

async function main(): Promise<void> {
  const program = createCLI();
  let parsed: StoryParsedArgs;
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

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    await closeOutputLog();
    process.exit(1);
  }

  console.log(chalk.cyan('\nstory') + chalk.gray(' — PR narrative & changelog\n'));

  try {
    const content = await runStory(parsed.input, config, parsed.options);
    if (parsed.options.output) {
      writeOutput(content, parsed.options.output);
    } else {
      console.log('\n' + content);
    }
    const logPath = getOutputLogPath();
    if (logPath) console.log(chalk.gray(`\nOutput log: ${logPath}`));
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
