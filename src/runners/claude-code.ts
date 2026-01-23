import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';

const exec = promisify(execCallback);

// Validate model name to prevent injection (defense in depth)
function isValidModel(model: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(model);
}

// Claude Code CLI binary names
const CLAUDE_BINARIES = ['claude', 'claude-code'];

export class ClaudeCodeRunner implements Runner {
  name = 'claude-code';
  displayName = 'Claude Code';
  private binaryPath: string = 'claude';

  async isAvailable(): Promise<boolean> {
    for (const binary of CLAUDE_BINARIES) {
      try {
        await exec(`which ${binary}`);
        this.binaryPath = binary;
        debug(`Found Claude Code CLI at: ${binary}`);
        return true;
      } catch {
        // Try next binary
      }
    }
    debug('Claude Code CLI not found', { tried: CLAUDE_BINARIES });
    return false;
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed (install: npm i -g @anthropic-ai/claude-code)' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await exec(`${this.binaryPath} --version 2>&1`);
      version = stdout.trim();
    } catch {
      // Version check might fail
    }

    // Check if authenticated
    try {
      const { stdout, stderr } = await exec(`${this.binaryPath} --help 2>&1`);
      const output = stdout + stderr;
      if (output.includes('login') || output.includes('ANTHROPIC_API_KEY')) {
        // Check if API key is set
        if (!process.env.ANTHROPIC_API_KEY) {
          return { installed: true, ready: false, version, error: 'ANTHROPIC_API_KEY not set' };
        }
      }
      return { installed: true, ready: true, version };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { installed: true, ready: false, version, error };
    }
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    const promptFile = join(workdir, '.prr-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // Build args array safely (no shell interpolation)
      const args: string[] = ['--print'];
      
      // Validate and add model if specified
      if (options?.model) {
        if (!isValidModel(options.model)) {
          resolve({ success: false, output: '', error: `Invalid model name: ${options.model}` });
          return;
        }
        args.push('--model', options.model);
      }
      
      // Read prompt from file and pass via -p
      const promptContent = readFileSync(promptFile, 'utf-8');
      args.push('-p', promptContent);

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${this.binaryPath}${modelInfo} [prompt]\n`);
      debug('Claude Code command', { binary: this.binaryPath, workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn(this.binaryPath, args, {
        cwd: workdir,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
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
