import type { Runner, RunnerStatus } from './types.js';
import { DEFAULT_MODEL_ROTATIONS } from './types.js';
import { CursorRunner } from './cursor.js';
import { OpencodeRunner } from './opencode.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { AiderRunner } from './aider.js';
import { CodexRunner } from './codex.js';
import { GeminiRunner } from './gemini.js';
import { JunieRunner } from './junie.js';
import { GooseRunner } from './goose.js';
import { OpenHandsRunner } from './openhands.js';
import { LLMAPIRunner } from './llm-api.js';
import chalk from 'chalk';

export { DEFAULT_MODEL_ROTATIONS };

// All available runners in priority order
// CLI tools first (more capable with workspace context), then direct API as fallback
const ALL_RUNNERS: Runner[] = [
  new CursorRunner(),
  new ClaudeCodeRunner(),
  new AiderRunner(),
  new OpencodeRunner(),
  new CodexRunner(),
  new GeminiRunner(),
  new JunieRunner(),
  new GooseRunner(),
  new OpenHandsRunner(),
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
    let status: RunnerStatus;
    try {
      status = await runner.checkStatus();
    } catch (err) {
      status = {
        installed: false,
        ready: false,
        error: `checkStatus failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (verbose) {
      const icon = status.ready ? chalk.green('✓') : status.installed ? chalk.yellow('○') : chalk.gray('✗');
      const statusText = status.ready
        ? chalk.green('ready')
        : status.installed
          ? chalk.yellow(`not ready: ${status.error}`)
          : chalk.gray('not installed');
      const versionText = status.version ? chalk.gray(` (${status.version})`) : '';
      console.log(`  ${icon} ${runner.displayName}${versionText}: ${statusText}`);
      // Show install hint for tools that aren't installed
      if (!status.installed && runner.installHint) {
        console.log(chalk.gray(`    → ${runner.installHint}`));
      }
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
  // 'elizacloud' is an alias for 'llm-api' with ElizaCloud backend
  if (name === 'elizacloud') {
    return ALL_RUNNERS.find(r => r.name === 'llm-api');
  }
  return ALL_RUNNERS.find(r => r.name === name);
}

/**
 * Print a summary of all detected runners
 */
export function printRunnerSummary(detected: DetectedRunner[]): void {
  if (detected.length === 0) {
    console.log(chalk.red('No fix tools available!'));
    console.log(chalk.gray('Install one of: elizacloud, cursor, claude-code, aider, opencode, codex, gemini, junie, goose, openhands, llm-api'));
    console.log(chalk.gray('Or set ELIZACLOUD_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY for direct LLM API'));
    return;
  }

  console.log(chalk.cyan(`Fix tools available (${detected.length}):`));
  for (const { runner, status } of detected) {
    const versionText = status.version ? chalk.gray(` v${status.version}`) : '';
    console.log(chalk.green(`  ✓ ${runner.displayName}${versionText}`));

    // Show discovered models if available (dynamically fetched)
    if (runner.supportedModels && runner.supportedModels.length > 0) {
      const modelList = runner.supportedModels.slice(0, 5).join(', ');
      const moreText = runner.supportedModels.length > 5 ? ` (+${runner.supportedModels.length - 5} more)` : '';
      console.log(chalk.gray(`    Models: ${modelList}${moreText}`));
    }
  }
}
