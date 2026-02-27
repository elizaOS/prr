#!/usr/bin/env node
/**
 * PRR entry point: CLI wiring, config load, signal handling, resolver run.
 *
 * WHY initOutputLog() at top: We tee console output to ./output.log from the
 * first line so every run has a full audit trail even if we exit early or crash.
 * WHY closeOutputLog() before every return/exit: Flush and close the log file
 * so the user can read it immediately; without it the last lines may be lost.
 * WHY API keys on process.env: Spawned fixer tools (Codex, llm-api, etc.) read
 * OPENAI_API_KEY etc. from the environment; loadConfig() may have loaded from
 * .env into config but children don't see config, so we mirror to process.env.
 */

import chalk from 'chalk';
import { loadConfig } from './config.js';
import { createCLI, parseArgs } from './cli.js';
import { validateElizaCloudKey, fetchAvailableElizaCloudModels, validateOpenAIKey } from './llm/client.js';
import { PRResolver } from './resolver.js';
import { printToolStatus, checkPrrUpdate, updateAllTools } from './upgrade.js';
import { tidyAllLessons } from './state/lessons-prune.js';
import { initOutputLog, closeOutputLog, getOutputLogPath, debug } from './logger.js';

// Start output log tee immediately — captures all console output to ./output.log in CWD
try {
  initOutputLog();
} catch (err) {
  // Non-fatal: log tee unavailable (e.g., read-only CWD), continue without it
  console.warn('Warning: Could not initialize output log:', err);
}

let resolver: PRResolver | null = null;
let isShuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    // Second signal - force exit
    console.log(chalk.red('\nForce exit.'));
    await closeOutputLog();
    process.exit(1);
  }
  
  isShuttingDown = true;
  
  if (resolver) {
    await resolver.gracefulShutdown();
  }
  
  const logPath = getOutputLogPath();
  if (logPath) {
    console.log(chalk.gray(`\n📄 Full output log: ${logPath}`));
  }
  await closeOutputLog();

  // Compute signal-specific exit code (128 + signal number)
  // SIGINT (2) -> 130, SIGTERM (15) -> 143
  const signalCodes: Record<string, number> = {
    'SIGINT': 130,   // 128 + 2
    'SIGTERM': 143,  // 128 + 15
    'SIGHUP': 129,   // 128 + 1
    'SIGQUIT': 131,  // 128 + 3
  };
  const exitCode = signalCodes[signal] ?? 128;
  
  process.exit(exitCode);
}

// Set up signal handlers
process.on('SIGINT', () => {
  handleShutdown('SIGINT').catch(err => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  handleShutdown('SIGTERM').catch(err => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});

async function main(): Promise<void> {
  try {
    // Parse CLI arguments
    const program = createCLI();
    const { prUrl, options } = parseArgs(program);

    // Handle --check-tools mode (exit after showing status)
    if (options.checkTools) {
      await printToolStatus();
      await checkPrrUpdate();
      await closeOutputLog();
      return;
    }

    // Handle --update-tools mode (update all installed tools and exit)
    if (options.updateTools) {
      await updateAllTools();
      await closeOutputLog();
      return;
    }

    // Handle --tidy-lessons mode (clean up all lesson files and exit)
    if (options.tidyLessons) {
      await tidyAllLessons();
      await closeOutputLog();
      // Review: early exits are designed to bypass further processing when specific flags are used
      return;
    }

    // Load configuration
    const config = loadConfig();

    // Ensure API keys from config are visible to child processes (e.g. Codex, llm-api).
    // WHY: Spawned fixers read OPENAI_API_KEY etc. from process.env; they don't have access to our config object.
    if (config.openaiApiKey) process.env.OPENAI_API_KEY = config.openaiApiKey;
    if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
    if (config.elizacloudApiKey) process.env.ELIZACLOUD_API_KEY = config.elizacloudApiKey;

    // Fail fast if OpenAI key is invalid (only when OpenAI is the active LLM provider)
    if (config.llmProvider === 'openai' && config.openaiApiKey) {
      await validateOpenAIKey(config.openaiApiKey);
    }

    // Fail fast if ElizaCloud key is invalid; use an available model if default isn't listed
    if (config.llmProvider === 'elizacloud' && config.elizacloudApiKey) {
      await validateElizaCloudKey(config.elizacloudApiKey);
      const available = await fetchAvailableElizaCloudModels(config.elizacloudApiKey);
      if (available.size > 0 && !available.has(config.llmModel)) {
        const PREFERRED_ELIZACLOUD_MODELS = [
          'claude-sonnet-4-5-20250929',
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
        ];
        const chosen = PREFERRED_ELIZACLOUD_MODELS.find(m => available.has(m))
          ?? Array.from(available).sort()[0];
        config.llmModel = chosen;
        if (PREFERRED_ELIZACLOUD_MODELS.some(m => available.has(m))) {
          console.log(chalk.gray(`  Using ElizaCloud model: ${chosen} (default not in available list)`));
        } else {
          console.warn(chalk.yellow(`  Auto-selected ElizaCloud model: ${chosen}. Set PRR_LLM_MODEL to avoid surprises.`));
        }
      }
    // Review: fallback behavior uses available models to ensure compatibility with user configuration
    }

    // Note: If neither options.tool nor config.defaultTool is set,
    // the resolver will auto-detect the available CLI tool.
    // We only set options.tool from config if it's explicitly configured.
    if (!options.tool && config.defaultTool) {
      options.tool = config.defaultTool;
    }

    // Create and run resolver
    resolver = new PRResolver(config, options);
    await resolver.run(prUrl);

    const logPath = getOutputLogPath();
    if (logPath) {
      console.log(chalk.gray(`\n📄 Full output log: ${logPath}`));
    }
    await closeOutputLog();

  } catch (error) {
    resolver?.abortRun();
    if (error instanceof Error) {
      console.error(chalk.red('\nError:'), error.message);
      
      if (error.message.includes('Missing required environment variable')) {
        console.error(chalk.gray('\nMake sure you have a .env file with the required variables.'));
        console.error(chalk.gray('See .env.example for reference.'));
      }
    } else {
      console.error(chalk.red('\nUnknown error:'), error);
    }
    const logPath = getOutputLogPath();
    if (logPath) {
      console.error(chalk.gray(`\n📄 Full output log: ${logPath}`));
    }
    await closeOutputLog();
    process.exit(1);
  }
}

main();
