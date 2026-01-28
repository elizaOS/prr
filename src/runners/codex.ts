import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { createReadStream, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
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
    
    // Validate model before writing sensitive prompt to disk
    if (options?.model && !isValidModel(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    // Write prompt to temp file for stdin piping
    const promptFile = join(tmpdir(), `prr-prompt.${process.pid}.${Date.now()}.txt`);
    writeFileSync(promptFile, prompt, { encoding: 'utf-8', mode: 0o600 });
    debug('Wrote prompt to file', { promptFile, length: prompt.length });
    debugPrompt('codex', prompt, { workdir, model: options?.model });
    
    const cleanupPromptFile = () => {
      try {
        unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }
    };
    
    // Build args for `codex exec` - the non-interactive mode
    // WHY: Interactive mode requires TTY for cursor position queries, which fails in automation.
    // `codex exec` is designed for non-interactive/CI use and doesn't need a TTY.
    const args: string[] = ['exec'];
    
    // Full auto mode: automatic approval, workspace write sandbox
    args.push('--full-auto');
    
    // Set working directory
    args.push('-C', workdir);
    
    // Add model if specified
    if (options?.model) {
      args.push('--model', options.model);
    }
    
    // Add extra directories if specified
    if (options?.codexAddDirs && options.codexAddDirs.length > 0) {
      for (const dir of options.codexAddDirs) {
        if (!dir) continue;
        args.push('--add-dir', dir);
      }
    }
    
    // Read prompt from stdin
    args.push('-');

    return new Promise((resolve) => {
      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${this.binaryPath} exec${modelInfo} --full-auto [prompt via stdin]\n`);
      debug('Codex exec command', { 
        binary: this.binaryPath, 
        args: args.filter(a => a !== '-'), // Don't log the stdin marker
        workdir, 
        model: options?.model, 
        promptLength: prompt.length,
      });

      const child = spawn(this.binaryPath, args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { 
          ...process.env,
          // Hint that we're in CI/automation
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      });
      
      // Pipe prompt to stdin
      const promptStream = createReadStream(promptFile);
      if (!child.stdin) {
        const error = 'Codex process stdin is unavailable';
        debug(error);
        promptStream.destroy();
        cleanupPromptFile();
        resolve({ success: false, output: '', error });
        return;
      }
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
        cleanupPromptFile();
        debugResponse('codex', stdout, { exitCode: code, stderrLength: stderr.length });

        // Safety check: detect cursor position error even in exec mode (shouldn't happen, but just in case)
        const hasCursorError = isCursorPositionError(stdout) || isCursorPositionError(stderr);
        if (hasCursorError) {
          debug('Codex cursor position error detected in exec mode - unexpected environment issue');
          resolve({ 
            success: false, 
            output: stdout, 
            error: 'Codex cursor position error: TTY/PTY environment issue. This is unexpected in exec mode.',
            errorType: 'environment'
          });
          return;
        }

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          // Check for common error patterns
          const combinedOutput = stdout + stderr;
          if (/authentication|unauthorized|invalid.*key|api.*key/i.test(combinedOutput)) {
            resolve({ success: false, output: stdout, error: stderr || `Authentication error`, errorType: 'auth' });
          } else if (/permission denied|cannot write|read-only/i.test(combinedOutput)) {
            resolve({ success: false, output: stdout, error: stderr || `Permission error`, errorType: 'permission' });
          } else {
            resolve({ success: false, output: stdout, error: stderr || `Process exited with code ${code}` });
          }
        }
      });

      child.on('error', (err) => {
        cleanupPromptFile();
        resolve({ success: false, output: stdout, error: err.message });
      });
    });
  }
}

function isCursorPositionError(output?: string): boolean {
  // Codex throws this when it can't query terminal cursor position
  // WHY: Interactive mode uses TUI elements that need cursor position
  // This shouldn't happen in exec mode, but we check as a safety measure
  if (!output) return false;
  const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f]/g, ' ');
  return /cursor.{0,10}position.{0,10}could.{0,10}not.{0,10}be.{0,10}read/i.test(cleaned);
}
