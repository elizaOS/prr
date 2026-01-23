import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';

const exec = promisify(execCallback);

// Validate model name to prevent injection (defense in depth - also validated in CLI)
// Allows forward slashes for provider-prefixed names like "anthropic/claude-..." or "openrouter/anthropic/..."
function isValidModel(model: string): boolean {
  return /^[A-Za-z0-9._\/-]+$/.test(model);
}

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
      // Build args array safely (no shell interpolation)
      const args: string[] = ['--yes-always'];
      
      // Validate and add model if specified
      if (options?.model) {
        if (!isValidModel(options.model)) {
          // Clean up the temp prompt file before returning
          try { unlinkSync(promptFile); } catch { /* ignore unlink errors */ }
          resolve({ success: false, output: '', error: `Invalid model name: ${options.model}` });
          return;
        }
        args.push('--model', options.model);
      }
      
      // Read prompt from file and pass via --message
      const promptContent = readFileSync(promptFile, 'utf-8');
      args.push('--message', promptContent);

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: aider${modelInfo} [prompt]\n`);
      debug('Aider command', { workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('aider', args, {
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
