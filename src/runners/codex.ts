import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { createReadStream, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';
import { isValidModelName } from '../config.js';

const exec = promisify(execCallback);

// Validate model name to prevent injection (defense in depth)
function isValidModel(model: string): boolean {
  return isValidModelName(model);
}

// OpenAI Codex CLI binary names
const CODEX_BINARIES = ['codex', 'openai-codex'];

export class CodexRunner implements Runner {
  name = 'codex';
  displayName = 'OpenAI Codex';
  private binaryPath: string = 'codex';

  async isAvailable(): Promise<boolean> {
    for (const binary of CODEX_BINARIES) {
      try {
        await exec(`which ${binary}`);
        this.binaryPath = binary;
        debug(`Found Codex CLI at: ${binary}`);
        return true;
      } catch {
        // Try next binary
      }
    }
    debug('Codex CLI not found', { tried: CODEX_BINARIES });
    return false;
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await exec(`${this.binaryPath} --version 2>&1`);
      version = stdout.trim();
    } catch {
      // Version check might fail
    }

    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      return { installed: true, ready: false, version, error: 'OPENAI_API_KEY not set' };
    }

    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    // Guard: Don't run with empty prompt
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping codex run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }
    
    const promptFile = join(workdir, '.prr-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // Build args array safely (no shell interpolation)
      const args: string[] = [];
      
      // Validate and add model if specified
      if (options?.model) {
        if (!isValidModel(options.model)) {
          resolve({ success: false, output: '', error: `Invalid model name: ${options.model}` });
          return;
        }
        args.push('--model', options.model);
      }
      
      // Use "-" prompt to read from stdin (avoids command injection)
      args.push('-');

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${this.binaryPath}${modelInfo} [prompt via stdin]\n`);
      debug('Codex command', { binary: this.binaryPath, workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn(this.binaryPath, args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      
      // Pipe prompt file to stdin (safe - no shell interpolation)
      const promptStream = createReadStream(promptFile);
      promptStream.pipe(child.stdin);
      promptStream.on('error', (err) => {
        debug('Error reading prompt file', { error: err.message });
      });

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
        try { unlinkSync(promptFile); } catch { }

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({ success: false, output: stdout, error: stderr || `Process exited with code ${code}` });
        }
      });

      child.on('error', (err) => {
        try { unlinkSync(promptFile); } catch { }
        resolve({ success: false, output: stdout, error: err.message });
      });
    });
  }
}
