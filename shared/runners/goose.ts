/**
 * Goose runner - Block's open-source AI coding agent
 * 
 * Uses `goose run` in non-interactive mode with --no-session
 * to execute one-off coding tasks without persisting session state.
 * 
 * Install: brew install block/tap/goose  (or pipx install goose-ai)
 * Auth: Provider-specific env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 * 
 * WHY: Goose ranks #27 on Terminal-Bench 2.0 (54.3% with Claude Opus 4.5).
 * Open source, supports multiple LLM providers, and has a clean CLI interface.
 * The --provider and --model flags allow direct model control.
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus, RunnerErrorType } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
import { isValidModelName } from '../config.js';

const execFile = promisify(execFileCallback);

/**
 * Map model names to goose provider names.
 * Goose requires --provider alongside --model.
 */
function inferProvider(model: string): string | undefined {
  if (/^claude|^anthropic/i.test(model)) return 'anthropic';
  if (/^gpt|^o[0-9]|^openai/i.test(model)) return 'openai';
  if (/^gemini|^google/i.test(model)) return 'google';
  return undefined;
}

export class GooseRunner implements Runner {
  name = 'goose';
  displayName = 'Goose';
  installHint = 'brew install block/tap/goose';

  async isAvailable(): Promise<boolean> {
    try {
      await execFile('which', ['goose']);
      debug('Found Goose CLI');
      return true;
    } catch {
      debug('Goose CLI not found');
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed (install: brew install block/tap/goose)' };
    }

    let version: string | undefined;
    try {
      const { stdout, stderr } = await execFile('goose', ['version']);
      version = (stdout || stderr).trim();
    } catch {
      try {
        const { stdout, stderr } = await execFile('goose', ['--version']);
        version = (stdout || stderr).trim();
      } catch {
        // Version check might fail
      }
    }

    // Goose works with any supported provider's API key
    const hasAnyKey = !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY
    );

    if (!hasAnyKey) {
      return {
        installed: true,
        ready: false,
        version,
        error: 'No API key set (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)',
      };
    }

    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping goose run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }

    if (options?.model && !isValidModelName(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    const promptSlug = debugPrompt('goose', prompt, { workdir, model: options?.model });

    return new Promise((resolve) => {
      // `goose run --no-session -t "prompt"` for one-off non-interactive execution
      const args: string[] = ['run', '--no-session'];

      if (options?.model) {
        args.push('--model', options.model);
        const provider = inferProvider(options.model);
        if (provider) {
          args.push('--provider', provider);
        }
      }

      // Pass prompt via -t flag
      args.push('-t', prompt);

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: goose run${modelInfo} --no-session [prompt]\n`);
      debug('Goose command', { workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('goose', args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
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
        debugResponse(promptSlug, 'goose', stdout, { exitCode: code, stderrLength: stderr.length });

        const combinedOutput = stdout + stderr;

        if (code === 0) {
          resolve({ success: true, output: stdout });
          return;
        }

        if (/quota exceeded|rate.?limit|too many requests|billing|exceeded.*plan/i.test(combinedOutput)) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Quota or rate limit exceeded',
            errorType: 'quota' as RunnerErrorType,
          });
          return;
        }

        if (/unauthorized|authentication|invalid.*key|api.?key/i.test(combinedOutput)) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Authentication error',
            errorType: 'auth' as RunnerErrorType,
          });
          return;
        }

        if (/model.*not found|does not exist/i.test(combinedOutput)) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Model not found',
            errorType: 'model' as RunnerErrorType,
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
      });

      child.on('error', (err) => {
        resolve({ success: false, output: stdout, error: err.message, errorType: 'tool' });
      });
    });
  }
}
