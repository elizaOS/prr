import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus, RunnerErrorType } from './types.js';
import { debug } from '../logger.js';
import { isValidModelName } from '../config.js';

const exec = promisify(execCallback);

// Validate model name to prevent injection (defense in depth)
function isValidModel(model: string): boolean {
  return isValidModelName(model);
}

// Claude Code CLI binary names
const CLAUDE_BINARIES = ['claude', 'claude-code'];

// Permission error patterns to detect
// These indicate claude-code is blocked from writing and we should bail out immediately
const PERMISSION_ERROR_PATTERNS = [
  /requested permissions? to write/i,
  /haven't granted it yet/i,
  /permission.*denied/i,
  /Unable to write.*permission/i,
  /persistent permission error/i,
];

/**
 * Check if output contains permission errors
 * Returns true if claude-code is blocked from making changes due to permissions
 */
function hasPermissionError(output: string): boolean {
  return PERMISSION_ERROR_PATTERNS.some(pattern => pattern.test(output));
}

/**
 * Check if --dangerously-skip-permissions should be used
 * 
 * Always returns true for prr because:
 * - prr is an automated fixer tool that needs to write files
 * - Without this flag, Claude Code waits for interactive permission approval
 * - Non-interactive execution makes Claude Code useless without this flag
 * 
 * Can be disabled via PRR_CLAUDE_SKIP_PERMISSIONS=0 if needed
 */
function shouldSkipPermissions(): boolean {
  const envValue = process.env.PRR_CLAUDE_SKIP_PERMISSIONS;
  // Default to true (enabled), only disable if explicitly set to '0' or 'false'
  return envValue !== '0' && envValue !== 'false';
}

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
    // Guard: Don't run with empty prompt
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping claude-code run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }

    const promptFile = join(workdir, '.prr-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // Build args array safely (no shell interpolation)
      const args: string[] = ['--print'];

      // Add --dangerously-skip-permissions if enabled via env var
      // This allows fully non-interactive operation (CI/CD, automated workflows)
      const skipPermissions = shouldSkipPermissions();
      if (skipPermissions) {
        args.push('--dangerously-skip-permissions');
        debug('Using --dangerously-skip-permissions mode');
      }

      // Validate and add model if specified
      if (options?.model) {
        if (!isValidModel(options.model)) {
          resolve({ success: false, output: '', error: `Invalid model name: ${options.model}` });
          return;
        }
        args.push('--model', options.model);
      }

      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      const permInfo = skipPermissions ? ' [skip-permissions]' : '';
      console.log(`\nRunning: ${this.binaryPath}${modelInfo}${permInfo} [prompt]\n`);
      debug('Claude Code command', { binary: this.binaryPath, workdir, model: options?.model, skipPermissions, promptLength: prompt.length });

      // Pass prompt via stdin to avoid E2BIG error with large prompts
      const child = spawn(this.binaryPath, args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // Write prompt to stdin
      const promptContent = readFileSync(promptFile, 'utf-8');
      child.stdin?.write(promptContent);
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
        try { unlinkSync(promptFile); } catch { }

        // Check for permission errors in output (even on success exit code)
        // This catches cases where claude-code "succeeded" but couldn't actually write
        const combinedOutput = stdout + stderr;
        if (hasPermissionError(combinedOutput)) {
          debug('Permission error detected in output', { exitCode: code });
          resolve({
            success: false,
            output: stdout,
            error: 'Permission denied - claude-code cannot write to files. Set PRR_CLAUDE_SKIP_PERMISSIONS=1 to bypass permission prompts.',
            errorType: 'permission',
          });
          return;
        }

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          // Determine error type for non-permission failures
          let errorType: RunnerErrorType = 'tool';
          const errorText = (stderr || '').toLowerCase();
          if (errorText.includes('api key') || errorText.includes('unauthorized') || errorText.includes('authentication')) {
            errorType = 'auth';
          }
          resolve({ success: false, output: stdout, error: stderr || `Process exited with code ${code}`, errorType });
        }
      });

      child.on('error', (err) => {
        try { unlinkSync(promptFile); } catch { }
        // Spawn errors (e.g., EACCES on binary) are tool errors
        resolve({ success: false, output: stdout, error: err.message, errorType: 'tool' });
      });
    });
  }
}
