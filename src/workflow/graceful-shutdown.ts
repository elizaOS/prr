/**
 * Graceful shutdown handler
 * 
 * Handles interrupt signals (SIGINT, SIGTERM) by saving state
 * and printing final summaries before exit.
 */

import chalk from 'chalk';
import type { StateManager } from '../state/manager.js';
import { endTimer, printTimingSummary, printTokenSummary } from '../logger.js';

/**
 * Execute graceful shutdown
 * 
 * WORKFLOW:
 * 1. Check if already shutting down (prevent double shutdown)
 * 2. Save interrupted state to state manager
 * 3. Print timing and token summaries
 * 4. Print model performance and final summary
 * 
 * @returns void
 */
export async function executeGracefulShutdown(
  isShuttingDown: boolean,
  stateManager: StateManager | undefined,
  printModelPerformance: () => void,
  printFinalSummary: () => void
): Promise<boolean> {
  if (isShuttingDown) return true;
  
  console.log(chalk.yellow('\n\n⚠ Interrupted! Saving state...'));
  
  if (stateManager) {
    try {
      await stateManager.markInterrupted();
      console.log(chalk.green('✓ State saved. Run again to resume.'));
      endTimer('Total');
      printTimingSummary();
      printTokenSummary();
      printModelPerformance();
      printFinalSummary();
    } catch (e) {
      console.log(chalk.red('✗ Failed to save state:', e));
    }
  }
  
  return true; // isShuttingDown = true
}
