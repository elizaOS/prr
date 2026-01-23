import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';

const exec = promisify(execCallback);

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
    const promptFile = join(workdir, '.prr-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // Codex CLI typically uses positional prompt argument
      const modelFlag = options?.model ? `--model ${options.model}` : '';
      const shellCommand = `${this.binaryPath} ${modelFlag} "$(cat "${promptFile}")"`;

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${this.binaryPath}${modelInfo} [prompt]\n`);
      debug('Codex command', { binary: this.binaryPath, workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('sh', ['-c', shellCommand], {
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
