/**
 * Gemini CLI runner - Google's AI coding agent
 * 
 * Uses the Gemini CLI (`gemini`) in non-interactive/headless mode
 * with --yolo for auto-approval of file edits and shell commands.
 * 
 * Install: npm install -g @google/gemini-cli
 * Auth: GEMINI_API_KEY env var or `gemini auth login`
 * 
 * WHY: Gemini 2.5 Pro and Flash models show strong coding performance
 * on Terminal-Bench 2.0 and provide an alternative provider (Google)
 * that doesn't depend on OpenAI or Anthropic.
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus, RunnerErrorType } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
import { isValidModelName } from '../config.js';

const exec = promisify(execCallback);

function isValidModel(model: string): boolean {
  return isValidModelName(model);
}

export class GeminiRunner implements Runner {
  name = 'gemini';
  displayName = 'Gemini CLI';
  installHint = 'npm install -g @google/gemini-cli';

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which gemini');
      debug('Found Gemini CLI');
      return true;
    } catch {
      debug('Gemini CLI not found');
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed (install: npm i -g @google/gemini-cli)' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await exec('gemini --version 2>&1');
      version = stdout.trim();
    } catch {
      // Version check might fail
    }

    // Check if API key is available
    // Gemini CLI uses GEMINI_API_KEY or GOOGLE_API_KEY, or Google Cloud auth
    const hasApiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_CLOUD_API_KEY);
    
    if (!hasApiKey) {
      // Try running a quick check - gemini might be authenticated via gcloud
      try {
        await exec('gemini --help 2>&1');
        // If help works, assume it's usable (might be using gcloud auth)
        return { installed: true, ready: true, version };
      } catch {
        return { installed: true, ready: false, version, error: 'No GEMINI_API_KEY or GOOGLE_API_KEY set' };
      }
    }

    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    // Guard: Don't run with empty prompt
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping gemini run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }

    if (options?.model && !isValidModel(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    debugPrompt('gemini', prompt, { workdir, model: options?.model });

    return new Promise((resolve) => {
      // Build args for non-interactive headless mode
      const args: string[] = [
        '--yolo',    // Auto-approve all file edits and shell commands
      ];

      // Add model if specified
      if (options?.model) {
        args.push('--model', options.model);
      }

      // Add the prompt as a positional argument via --prompt flag
      args.push('--prompt', prompt);

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: gemini${modelInfo} --yolo [prompt]\n`);
      debug('Gemini CLI command', { workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('gemini', args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // Close stdin since we're using --prompt flag
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
        debugResponse('gemini', stdout, { exitCode: code, stderrLength: stderr.length });

        const combinedOutput = stdout + stderr;

        // Check for model/auth errors
        if (/model.*not found|does not exist|you do not have access|not_found_error|invalid.*api.?key|unauthorized|authentication/i.test(combinedOutput)) {
          debug('Auth/model error detected', { exitCode: code });
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Model or authentication error',
            errorType: 'auth' as RunnerErrorType,
          });
          return;
        }

        // Check for permission errors
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
          if (/api.?key|unauthorized|authentication|quota|rate.?limit/i.test(combinedOutput)) {
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
