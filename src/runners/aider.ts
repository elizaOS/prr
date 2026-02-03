import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';

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
    // Guard: Don't run with empty prompt
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping aider run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }
    
    // Validate model before writing sensitive prompt to disk
    if (options?.model && !isValidModel(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    const promptFile = join(tmpdir(), `prr-prompt.${process.pid}.${Date.now()}.txt`);
    writeFileSync(promptFile, prompt, { encoding: 'utf-8', mode: 0o600 });
    debug('Wrote prompt to file', { promptFile, length: prompt.length });
    debugPrompt('aider', prompt, { workdir, model: options?.model });
    const cleanupPromptFile = () => {
      try {
        unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }
    };

    return new Promise((resolve) => {
      // Build args array safely (no shell interpolation)
      const args: string[] = ['--yes-always'];
      
      // Add model if specified
      if (options?.model) {
        args.push('--model', options.model);
      }
      
      // Pass prompt file directly to avoid OS arg limits
      args.push('--message-file', promptFile);

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
        cleanupPromptFile();
        debugResponse('aider', stdout, { exitCode: code, stderrLength: stderr.length });

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({ success: false, output: stdout, error: stderr || `Process exited with code ${code}` });
        }
      });

      child.on('error', (err) => {
        cleanupPromptFile();
        resolve({ success: false, output: stdout, error: err.message });
      });
    });
  }
}
