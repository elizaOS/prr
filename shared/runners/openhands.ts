/**
 * OpenHands runner - open-source AI coding agent
 * 
 * Uses `openhands` in headless mode with --always-approve for
 * non-interactive automated code changes.
 * 
 * Install: pip install openhands-ai
 * Auth: LLM_API_KEY env var (or ANTHROPIC_API_KEY / OPENAI_API_KEY)
 * Model: LLM_MODEL env var (e.g., anthropic/claude-sonnet-4-5-20250929)
 * 
 * WHY: OpenHands ranks #31 on Terminal-Bench 2.0 (51.9% with Claude Opus 4.5).
 * Fully open source, no model lock-in, supports any LiteLLM-compatible provider.
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus, RunnerErrorType } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
import { isValidModelName } from '../config.js';

const execFile = promisify(execFileCallback);

export class OpenHandsRunner implements Runner {
  name = 'openhands';
  displayName = 'OpenHands';
  installHint = 'pip install openhands-ai';

  async isAvailable(): Promise<boolean> {
    try {
      await execFile('which', ['openhands']);
      debug('Found OpenHands CLI');
      return true;
    } catch {
      debug('OpenHands CLI not found');
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed (install: pip install openhands-ai)' };
    }

    let version: string | undefined;
    try {
      const { stdout, stderr } = await execFile('openhands', ['--version']);
      version = (stdout || stderr).trim();
    } catch {
      // Version check might fail
    }

    // OpenHands uses LLM_API_KEY or falls back to provider-specific keys
    const hasAnyKey = !!(
      process.env.LLM_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY
    );

    if (!hasAnyKey) {
      return {
        installed: true,
        ready: false,
        version,
        error: 'No API key set (LLM_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)',
      };
    }

    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping openhands run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }

    if (options?.model && !isValidModelName(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    const promptSlug = debugPrompt('openhands', prompt, { workdir, model: options?.model });

    return new Promise((resolve) => {
      // `openhands --headless --always-approve -t "prompt"` for non-interactive execution
      const args: string[] = [
        '--headless',
        '--always-approve',
      ];

      // Pass task via -t flag
      args.push('-t', prompt);

      // Build env with model override if specified
      // OpenHands uses LLM_MODEL env var (litellm format: provider/model)
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (options?.model) {
        env.LLM_MODEL = options.model;
      }

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: openhands${modelInfo} --headless --always-approve [prompt]\n`);
      debug('OpenHands command', { workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('openhands', args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      child.stdin?.end();

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        process.stdout.write(str);
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        process.stderr.write(str);
      });

      child.on('close', (code) => {
        debugResponse(promptSlug, 'openhands', stdout, { exitCode: code, stderrLength: stderr.length });

        const combinedOutput = stdout + stderr;

        if (/quota exceeded|rate.?limit|too many requests|billing|exceeded.*plan/i.test(combinedOutput)) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Quota or rate limit exceeded',
            errorType: 'quota' as RunnerErrorType,
          });
          return;
        }

        if (/model.*not found|does not exist|unauthorized|authentication|invalid.*key|api.?key/i.test(combinedOutput)) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Model or authentication error',
            errorType: 'auth' as RunnerErrorType,
          });
          return;
        }

        if (/permission.*denied|EACCES|cannot write/i.test(combinedOutput)) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Permission denied',
            errorType: 'permission' as RunnerErrorType,
          });
          return;
        }

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          let errorType: RunnerErrorType = 'tool';
          if (/auth|api.?key|unauthorized/i.test(combinedOutput)) {
            errorType = 'auth';
          }
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Process exited with code ${code}`,
            errorType,
          });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, output: stdout, error: err.message, errorType: 'tool' });
      });
    });
  }
}
