/**
 * Junie CLI runner - JetBrains AI coding agent
 * 
 * Uses the Junie CLI in headless/non-interactive mode.
 * The prompt is passed as a positional argument.
 * 
 * Install: npm install -g @jetbrains/junie-cli
 * Auth: JUNIE_AUTH_TOKEN env var or junie auth
 * 
 * WHY: Junie ranks #8 on Terminal-Bench 2.0 (64.3%) - the highest-ranked
 * CLI agent we don't already support. JetBrains backend with Gemini/Claude models.
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus, RunnerErrorType } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
import { isValidModelName } from '../config.js';

const exec = promisify(execCallback);

export class JunieRunner implements Runner {
  name = 'junie';
  displayName = 'Junie CLI';
  installHint = 'npm install -g @jetbrains/junie-cli';

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which junie');
      debug('Found Junie CLI');
      return true;
    } catch {
      debug('Junie CLI not found');
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed (install: npm i -g @jetbrains/junie-cli)' };
    }

    let version: string | undefined;
    try {
      const { stdout } = await exec('junie --version 2>&1');
      version = stdout.trim();
    } catch {
      // Version check might fail
    }

    // Junie authenticates via JUNIE_AUTH_TOKEN or interactive junie auth
    const hasToken = !!process.env.JUNIE_AUTH_TOKEN;
    if (!hasToken) {
      // Try running help to see if it is authenticated via stored credentials
      try {
        await exec('junie --help 2>&1');
        return { installed: true, ready: true, version };
      } catch {
        return { installed: true, ready: false, version, error: 'JUNIE_AUTH_TOKEN not set (or run: junie auth)' };
      }
    }

    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping junie run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }

    if (options?.model && !isValidModelName(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    debugPrompt('junie', prompt, { workdir, model: options?.model });

    return new Promise((resolve) => {
      // Junie uses --project for workdir and prompt as positional arg
      const args: string[] = [
        '--project=' + workdir,
      ];

      if (options?.model) {
        args.push('--model', options.model);
      }

      // Prompt is positional argument
      args.push(prompt);

      const modelInfo = options?.model ? ' (model: ' + options.model + ')' : '';
      console.log('\nRunning: junie' + modelInfo + ' --project=... [prompt]\n');
      debug('Junie CLI command', { workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('junie', args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      child.stdin?.end();

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        stdout += str;
        process.stdout.write(str);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        stderr += str;
        process.stderr.write(str);
      });

      child.on('close', (code: number | null) => {
        debugResponse('junie', stdout, { exitCode: code, stderrLength: stderr.length });

        const combinedOutput = stdout + stderr;

        if (/model.*not found|does not exist|unauthorized|authentication|invalid.*token/i.test(combinedOutput)) {
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
          if (/auth|token|unauthorized|quota|rate.?limit/i.test(combinedOutput)) {
            errorType = 'auth';
          }
          resolve({
            success: false,
            output: stdout,
            error: stderr || 'Process exited with code ' + code,
            errorType,
          });
        }
      });

      child.on('error', (err: Error) => {
        resolve({ success: false, output: stdout, error: err.message, errorType: 'tool' });
      });
    });
  }
}
