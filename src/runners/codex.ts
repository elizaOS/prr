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
  private scriptAvailable?: boolean;

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
    
    // Build args array safely (no shell interpolation)
    const args: string[] = [];
    
    // Add model if specified
    if (options?.model) {
      args.push('--model', options.model);
    }
    
    // Use "-" prompt to read from stdin (avoids command injection)
    if (options?.codexAddDirs && options.codexAddDirs.length > 0) {
      for (const dir of options.codexAddDirs) {
        if (!dir) continue;
        args.push('--add-dir', dir);
      }
    }
    args.push('-');

    const runOnce = (useScript: boolean): Promise<RunnerResult> => {
      return new Promise((resolve) => {
        const modelInfo = options?.model ? ` (model: ${options.model})` : '';
        const scriptInfo = useScript ? ' via script' : '';
        console.log(`\nRunning: ${this.binaryPath}${modelInfo} [prompt via stdin]${scriptInfo}\n`);
        debug('Codex command', { binary: this.binaryPath, workdir, model: options?.model, promptLength: prompt.length, useScript });

        let child: ReturnType<typeof spawn>;
        if (useScript) {
          const codexCommand = [this.binaryPath, ...args].map(shellEscape).join(' ');
          // Use script to provide a PTY, with environment vars to minimize TUI behavior
          child = spawn('script', ['-q', '/dev/null', '-c', `stty -echo 2>/dev/null; ${codexCommand}`], {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              CI: '1',
              // Use xterm-256color which supports cursor queries
              TERM: 'xterm-256color',
              // Disable colors to reduce TUI complexity
              NO_COLOR: '1',
              FORCE_COLOR: '0',
              // Try to hint non-interactive mode
              DEBIAN_FRONTEND: 'noninteractive',
              // Some tools check these
              NONINTERACTIVE: '1',
              PRR_RUNNER: '1',
            },
          });
        } else {
          child = spawn(this.binaryPath, args, {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { 
              ...process.env,
              CI: '1',
              NO_COLOR: '1',
              FORCE_COLOR: '0',
            },
          });
        }
        
        // Pipe prompt file to stdin (safe - no shell interpolation)
        const promptStream = createReadStream(promptFile);
        if (!child.stdin) {
          const error = 'Codex process stdin is unavailable';
          debug(error);
          promptStream.destroy();
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
          const str = sanitizeOutput(data.toString(), useScript);
          stdout += str;
          process.stdout.write(str);
        });

        child.stderr?.on('data', (data) => {
          const str = sanitizeOutput(data.toString(), useScript);
          stderr += str;
          process.stderr.write(str);
        });

        child.on('close', (code) => {
          debugResponse('codex', stdout, { exitCode: code, stderrLength: stderr.length });

          if (code === 0) {
            resolve({ success: true, output: stdout });
          } else {
            resolve({ success: false, output: stdout, error: stderr || `Process exited with code ${code}` });
          }
        });

        child.on('error', (err) => {
          resolve({ success: false, output: stdout, error: err.message });
        });
      });
    };

    try {
      // Always try with script wrapper first if available
      // WHY: Codex's TUI requires a proper PTY for cursor position queries
      // Running without script almost always fails with "cursor position could not be read"
      const useScriptFirst = await this.isScriptAvailable();
      
      let result = await runOnce(useScriptFirst);
      
      // If script wrapper failed with TTY issues, try without (unlikely to help but worth a shot)
      if (!result.success && useScriptFirst) {
        const hasTTYIssue = isStdinNotTerminal(result.error) || 
                            isCursorPositionError(result.output) || 
                            isCursorPositionError(result.error);
        if (hasTTYIssue) {
          debug('Script wrapper failed with TTY issue, trying direct spawn');
          result = await runOnce(false);
        }
      }
      
      // If direct spawn failed with TTY issues and we didn't try script yet, try it
      if (!useScriptFirst && (await this.isScriptAvailable())) {
        const hasTTYIssue = isStdinNotTerminal(result.error) || 
                            isCursorPositionError(result.output) || 
                            isCursorPositionError(result.error);
        if (hasTTYIssue) {
          debug('Direct spawn failed with TTY issue, trying script wrapper');
          result = await runOnce(true);
        }
      }
      
      return result;
    } finally {
      cleanupPromptFile();
    }
  }

  private async isScriptAvailable(): Promise<boolean> {
    if (this.scriptAvailable !== undefined) {
      return this.scriptAvailable;
    }
    try {
      await exec('which script');
      this.scriptAvailable = true;
    } catch {
      this.scriptAvailable = false;
    }
    return this.scriptAvailable;
  }
}

function isStdinNotTerminal(error?: string): boolean {
  return Boolean(error && /stdin is not a terminal/i.test(error));
}

function isCursorPositionError(output?: string): boolean {
  // Codex throws this when it can't query terminal cursor position
  // WHY: Codex uses TUI elements that need cursor position, which fails in non-interactive terminals
  // Strip ANSI escape codes before checking (output may have formatting)
  if (!output) return false;
  const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f]/g, ' ');
  return /cursor.{0,10}position.{0,10}could.{0,10}not.{0,10}be.{0,10}read/i.test(cleaned);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeOutput(value: string, useScript: boolean): string {
  if (!useScript) {
    return value;
  }
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-_]/g, ''); // 2-char sequences
}
