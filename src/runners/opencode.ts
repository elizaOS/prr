import { spawn, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, createReadStream } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';
import { isValidModelName } from '../config.js';

// Validate model name to prevent injection (defense in depth)
function isValidModel(model: string): boolean {
  return isValidModelName(model);
}

// Helper to run a command without shell (prevents injection)
function execNoShell(command: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

/**
 * Runner for OpenCode CLI
 *
 * WHY: OpenCode provides an alternative/open-source option for users who
 * prefer not to use commercial tools or want different features.
 */
export class OpencodeRunner implements Runner {
  name = 'opencode';
  displayName = 'OpenCode';

  async isAvailable(): Promise<boolean> {
    try {
      await execNoShell('which', ['opencode']);
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
      const { stdout, stderr } = await execNoShell('opencode', ['--version']);
      version = (stdout || stderr).trim();
    } catch {
      // Version check might not be supported
    }

    // OpenCode typically ready if installed
    return { installed: true, ready: true, version };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    // Guard: Don't run with empty prompt
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping opencode run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }
    
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
        shell: false,
        env: { ...process.env },
      });

      // Pipe the prompt file to stdin
      const promptStream = createReadStream(promptFile);
      promptStream.pipe(child.stdin);
      promptStream.on('error', (err) => {
        debug('Error reading prompt file', { error: err.message });
        child.stdin?.destroy();
        child.kill('SIGTERM');
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
