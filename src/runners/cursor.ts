import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';

const exec = promisify(execCallback);

// Cursor CLI can be installed as 'cursor' or 'cursor-agent'
const CURSOR_BINARIES = ['cursor-agent', 'cursor', 'agent'];

export class CursorRunner implements Runner {
  name = 'cursor';
  displayName = 'Cursor Agent';
  private binaryPath: string = 'cursor-agent';

  async isAvailable(): Promise<boolean> {
    for (const binary of CURSOR_BINARIES) {
      try {
        await exec(`which ${binary}`);
        this.binaryPath = binary;
        debug(`Found cursor CLI at: ${binary}`);
        return true;
      } catch {
        // Try next binary
      }
    }
    debug('Cursor CLI not found', { tried: CURSOR_BINARIES });
    return false;
  }

  async checkStatus(): Promise<RunnerStatus> {
    // Check if installed
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'Not installed' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await exec(`${this.binaryPath} --version`);
      version = stdout.trim();
    } catch {
      // Version check failed, but might still work
    }

    // Check if logged in by trying a simple command
    try {
      const { stdout } = await exec(`${this.binaryPath} --list-models 2>&1`);
      if (stdout.includes('Available models') || stdout.includes('auto')) {
        return { installed: true, ready: true, version };
      }
      if (stdout.includes('login') || stdout.includes('auth') || stdout.includes('unauthorized')) {
        return { installed: true, ready: false, version, error: 'Not logged in (run: cursor-agent login)' };
      }
      return { installed: true, ready: true, version };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (error.includes('login') || error.includes('auth')) {
        return { installed: true, ready: false, version, error: 'Not logged in (run: cursor-agent login)' };
      }
      return { installed: true, ready: false, version, error };
    }
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    // Write prompt to a temp file for reference and to pass via env var for long prompts
    const promptFile = join(workdir, '.prr-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // cursor-agent options:
      // --print: Output to console (for scripts)
      // --output-format stream-json: Stream JSON chunks for live output
      // --stream-partial-output: Stream partial text as it's generated
      // --workspace: Working directory
      // --model: Model to use (e.g., opus-4, sonnet-4-thinking)
      // prompt: Positional argument at the end
      
      // Build model flag if specified
      const modelFlag = options?.model ? `--model ${options.model}` : '';
      
      // For long prompts, we use a shell trick: read from file and pass as argument
      // Using $() to read file content as the prompt argument
      const shellCommand = `${this.binaryPath} --print --output-format stream-json --stream-partial-output ${modelFlag} --workspace "${workdir}" "$(cat "${promptFile}")"`;
      
      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${this.binaryPath}${modelInfo} --workspace ${workdir} [prompt]\n`);
      debug('Cursor command', { binary: this.binaryPath, workdir, model: options?.model, promptLength: prompt.length });

      const child = spawn('sh', ['-c', shellCommand], {
        cwd: workdir,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let lastContent = '';

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        
        // Parse stream-json output and display nicely
        const lines = str.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            // Handle different event types from stream-json
            if (json.type === 'text' && json.content) {
              // Incremental text output
              process.stdout.write(json.content);
              lastContent += json.content;
            } else if (json.type === 'tool_use') {
              // Tool being used
              console.log(`\n🔧 ${json.name || 'tool'}: ${json.input?.path || json.input?.command || ''}`);
            } else if (json.type === 'tool_result') {
              // Tool result - usually verbose, skip or summarize
              if (json.is_error) {
                console.log(`   ❌ Error: ${json.content?.slice(0, 100)}...`);
              }
            } else if (json.type === 'message_start' || json.type === 'content_block_start') {
              // Message starting, ignore
            } else if (json.type === 'message_stop' || json.type === 'content_block_stop') {
              // Message ended
              if (lastContent) {
                process.stdout.write('\n');
                lastContent = '';
              }
            } else if (json.content) {
              // Fallback: if there's content, print it
              process.stdout.write(json.content);
            }
          } catch {
            // Not JSON, print raw (might be plain text mode)
            if (line.trim() && !line.includes('"type"')) {
              process.stdout.write(line + '\n');
            }
          }
        }
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        // Show stderr but filter out noise
        if (!str.includes('Debugger') && !str.includes('DevTools')) {
          process.stderr.write(str);
        }
      });

      child.on('close', (code) => {
        // Clean up prompt file
        try {
          unlinkSync(promptFile);
        } catch {
          // Ignore cleanup errors
        }

        console.log('\n'); // Clean line after streaming output

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
