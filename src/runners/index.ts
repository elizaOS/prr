import type { Runner, RunnerStatus } from './types.js';
import { CursorRunner } from './cursor.js';
import { OpencodeRunner } from './opencode.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { AiderRunner } from './aider.js';
import { CodexRunner } from './codex.js';
import { LLMAPIRunner } from './llm-api.js';
import chalk from 'chalk';

export { CursorRunner } from './cursor.js';
export { OpencodeRunner } from './opencode.js';
export { ClaudeCodeRunner } from './claude-code.js';
export { AiderRunner } from './aider.js';
export { CodexRunner } from './codex.js';
export { LLMAPIRunner } from './llm-api.js';
export type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';

// All available runners in priority order
// CLI tools first (more capable with workspace context), then direct API as fallback
export const ALL_RUNNERS: Runner[] = [
  new CursorRunner(),
  new ClaudeCodeRunner(),
  new AiderRunner(),
  new OpencodeRunner(),
  new CodexRunner(),
  new LLMAPIRunner(),  // Direct API fallback - always available with API key
];

export interface DetectedRunner {
  runner: Runner;
  status: RunnerStatus;
}

/**
 * Auto-detect all available and ready runners
 */
export async function detectAvailableRunners(verbose = false): Promise<DetectedRunner[]> {
  const detected: DetectedRunner[] = [];
  
  if (verbose) {
    console.log(chalk.gray('\nDetecting available fix tools...'));
  }

  for (const runner of ALL_RUNNERS) {
    const status = await runner.checkStatus();
    
    if (verbose) {
      const icon = status.ready ? chalk.green('✓') : status.installed ? chalk.yellow('○') : chalk.gray('✗');
      const statusText = status.ready 
        ? chalk.green('ready')
        : status.installed 
          ? chalk.yellow(`not ready: ${status.error}`)
          : chalk.gray('not installed');
      const versionText = status.version ? chalk.gray(` (${status.version})`) : '';
      console.log(`  ${icon} ${runner.displayName}${versionText}: ${statusText}`);
    }

    if (status.ready) {
      detected.push({ runner, status });
    }
  }

  if (verbose) {
    console.log('');
  }

  return detected;
}

/**
 * Get a runner by name
 */
export function getRunnerByName(name: string): Runner | undefined {
  return ALL_RUNNERS.find(r => r.name === name);
}

/**
 * Print a summary of all detected runners
 */
export function printRunnerSummary(detected: DetectedRunner[]): void {
  if (detected.length === 0) {
    console.log(chalk.red('No fix tools available!'));
    console.log(chalk.gray('Install one of: cursor, claude-code, aider, opencode, codex'));
    console.log(chalk.gray('Or set ANTHROPIC_API_KEY / OPENAI_API_KEY for direct LLM API'));
    return;
  }

  console.log(chalk.cyan(`Fix tools available (${detected.length}):`));
  for (const { runner, status } of detected) {
    const versionText = status.version ? chalk.gray(` v${status.version}`) : '';
    console.log(chalk.green(`  ✓ ${runner.displayName}${versionText}`));
  }
}
