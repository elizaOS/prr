#!/usr/bin/env node

import chalk from 'chalk';
import { loadConfig } from './config.js';
import { createCLI, parseArgs } from './cli.js';
import { PRResolver } from './resolver.js';

async function main(): Promise<void> {
  try {
    // Parse CLI arguments
    const program = createCLI();
    const { prUrl, options } = parseArgs(program);

    // Load configuration
    const config = loadConfig();

    // Override tool from CLI if specified
    if (options.tool) {
      // Already set from CLI
    } else {
      options.tool = config.defaultTool;
    }

    // Create and run resolver
    const resolver = new PRResolver(config, options);
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
