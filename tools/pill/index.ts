#!/usr/bin/env node
/**
 * pill - Program Improvement Log Looker.
 * Entry: parse CLI, init logger to target dir, load config, run orchestrator.
 * Signal handling: graceful shutdown, close log, exit with 128+signal.
 */
import path from 'path';
import { existsSync, statSync } from 'fs';
import chalk from 'chalk';
import { createCLI, parseArgs, getBanner, type ParsedArgs } from './cli.js';
import { loadConfig } from './config.js';
import { initOutputLog, closeOutputLog, getOutputLogPath, getPromptLogPath } from './logger.js';
import { runPillAnalysis } from './orchestrator.js';

let isShuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(chalk.red('\nForce exit.'));
    await closeOutputLog();
    process.exit(1);
  }
  isShuttingDown = true;
  const outPath = getOutputLogPath();
  const promptPath = getPromptLogPath();
  if (outPath) console.log(chalk.gray(`\nOutput log: ${outPath}`));
  if (promptPath) console.log(chalk.gray(`Prompts log: ${promptPath}`));
  await closeOutputLog();
  const signalCodes: Record<string, number> = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
    SIGQUIT: 131,
  };
  process.exit(signalCodes[signal] ?? 128);
}

process.on('SIGINT', () => {
  handleShutdown('SIGINT').catch((err) => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  handleShutdown('SIGTERM').catch((err) => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});

async function main(): Promise<void> {
  const program = createCLI();
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(program);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Error:'), msg);
    process.exit(1);
  }

  if (!existsSync(parsed.directory) || !statSync(parsed.directory).isDirectory()) {
    console.error(chalk.red('Error:'), `Target directory does not exist: ${parsed.directory}`);
    process.exit(1);
  }

  initOutputLog(parsed.directory);

  try {
    const config = loadConfig({
      targetDir: parsed.directory,
      auditModel: parsed.options.auditModel,
      outputOnly: parsed.options.outputOnly,
      promptsOnly: parsed.options.promptsOnly,
      dryRun: parsed.options.dryRun,
      verbose: parsed.options.verbose,
      instructionsOut: parsed.options.instructionsOut,
    });
    console.log(getBanner());
    if (config.verbose) {
      console.log(chalk.gray('Options:'), {
        directory: config.targetDir,
        auditModel: config.auditModel,
        dryRun: config.dryRun,
      });
    }
    const out = await runPillAnalysis(config);
    if (out.result) {
      console.log(chalk.cyan('\n' + out.result.pitch));
      console.log(chalk.gray('\n  Instructions:'), out.result.instructionsPath);
      console.log(chalk.gray('  Summary log:'), out.result.summaryPath);
    } else {
      const fc = (out as { filteredCount?: number }).filteredCount;
      const reasonMsg =
        out.reason === 'no_logs'
          ? 'No logs to analyze.'
          : out.reason === 'no_api_key'
            ? 'No API key configured.'
            : out.reason === 'api_call_failed'
              ? `API call failed${(out as { errorMessage?: string }).errorMessage ? `: ${(out as { errorMessage?: string }).errorMessage}` : ''}.`
              : out.reason === 'all_filtered_tool_scope'
                ? `All suggestions filtered (outside tool-repo paths${fc != null ? `; ${fc.toLocaleString()} omitted` : ''}). Set PILL_TOOL_REPO_SCOPE_FILTER=0 to disable.`
                : 'LLM returned zero improvements.';
      console.log(chalk.gray('\nNo improvements to record: ' + reasonMsg));
    }
    const outPath = getOutputLogPath();
    const promptPath = getPromptLogPath();
    if (outPath) console.log(chalk.gray('\nOutput log:'), outPath);
    if (promptPath) console.log(chalk.gray('Prompts log:'), promptPath);
    await closeOutputLog();
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red('\nError:'), error.message);
      if (error.message.includes('Missing required') || error.message.includes('environment')) {
        console.error(chalk.gray('\nEnsure .env exists with required keys. See .env.example.'));
      }
    } else {
      console.error(chalk.red('\nError:'), error);
    }
    const outPath = getOutputLogPath();
    const promptPath = getPromptLogPath();
    if (outPath) console.error(chalk.gray('\nOutput log:'), outPath);
    if (promptPath) console.error(chalk.gray('Prompts log:'), promptPath);
    await closeOutputLog();
    process.exit(1);
  }
}

main();
