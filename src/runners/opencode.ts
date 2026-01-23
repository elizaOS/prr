import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync, createReadStream } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';

const exec = promisify(execCallback);

// Validate model name to prevent injection (defense in depth)
function isValidModel(model: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(model);
}

export class OpencodeRunner implements Runner {
  name = 'opencode';
  displayName = 'OpenCode';

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which opencode');
      return true;
    } catch {
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await exec('opencode --version 2>&1');
      version = stdout.trim();
    } catch {
      // Version check might not be supported
    }

    // OpenCode typically ready if installed
    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    // Write prompt to a temp file to avoid command line length limits
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

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`Running: opencode${modelInfo} < [prompt file] in ${workdir}`);
      debug('Opencode command', { workdir, model: options?.model, promptLength: prompt.length });

      // Use pipe for stdin to stream prompt file contents
      const child = spawn('opencode', args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // Pipe the prompt file to stdin
      const promptStream = createReadStream(promptFile);
      promptStream.pipe(child.stdin);

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
        // Clean up prompt file
        try {
          unlinkSync(promptFile);
        } catch {
          // Ignore cleanup errors
        }

        if (code === 0) {
          resolve({
            success: true,
            output: stdout,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Process exited with code ${code}`,
          });
        }
      });

      child.on('error', (err) => {
        // Clean up prompt file
        try {
          unlinkSync(promptFile);
        } catch {
          // Ignore cleanup errors
        }

        resolve({
          success: false,
          output: stdout,
          error: err.message,
        });
      });
    });
  }
}
