import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';

const exec = promisify(execCallback);

export class AiderRunner implements Runner {
  name = 'aider';
  displayName = 'Aider';

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which aider');
      debug('Found Aider CLI');
      return true;
    } catch {
      debug('Aider CLI not found');
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed (install: pip install aider-chat)' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await exec('aider --version 2>&1');
      version = stdout.trim();
    } catch {
      // Version check might fail
    }

    // Aider needs API keys - check for common ones
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    
    if (!hasAnthropicKey && !hasOpenAIKey) {
      return { installed: true, ready: false, version, error: 'No API key set (ANTHROPIC_API_KEY or OPENAI_API_KEY)' };
    }

    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    const promptFile = join(workdir, '.prr-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // Aider uses --message for non-interactive prompts, --yes-always to auto-accept
      const modelFlag = options?.model ? `--model ${options.model}` : '';
      const shellCommand = `aider --yes-always ${modelFlag} --message "$(cat "${promptFile}")"`;

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: aider${modelInfo} [prompt]\n`);
      debug('Aider command', { workdir, model: options?.model, promptLength: prompt.length });

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
        if (!str.includes('Warning')) {
          process.stderr.write(str);
        }
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
