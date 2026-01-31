#!/usr/bin/env node

import chalk from 'chalk';
import { loadConfig } from './config.js';
import { createCLI, parseArgs } from './cli.js';
import { PRResolver } from './resolver.js';

let resolver: PRResolver | null = null;
let isShuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    // Second signal - force exit
    console.log(chalk.red('\nForce exit.'));
    process.exit(1);
  }
  
  isShuttingDown = true;
  
  if (resolver) {
    await resolver.gracefulShutdown();
  }
  
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

    // Load configuration
    const config = loadConfig();

    // Note: If neither options.tool nor config.defaultTool is set,
    // the resolver will auto-detect the available CLI tool.
    // We only set options.tool from config if it's explicitly configured.
    if (!options.tool && config.defaultTool) {
      options.tool = config.defaultTool;
    }

    // Create and run resolver
    resolver = new PRResolver(config, options);
    await resolver.run(prUrl);

  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red('\nError:'), error.message);
      
      if (error.message.includes('Missing required environment variable')) {
        console.error(chalk.gray('\nMake sure you have a .env file with the required variables.'));
        console.error(chalk.gray('See .env.example for reference.'));
      }
    } else {
      console.error(chalk.red('\nUnknown error:'), error);
    }
    process.exit(1);
  }
}

main();
