import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, createReadStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
import { isValidModelName } from '../config.js';

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
    child.on('error', (err) => {
      // Redact any sensitive information from error messages
      reject(new Error('Failed to start command'));
    });
  });
}

// Maximum time (ms) to wait for opencode to complete before killing it.
// 10 minutes is generous — most successful runs complete in 2-3 minutes.
// Without this, a hung opencode blocks the entire fix loop indefinitely.
const OPENCODE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runner for OpenCode CLI
 *
 * WHY: OpenCode provides an alternative/open-source option for users who
 * prefer not to use commercial tools or want different features.
 */
export class OpencodeRunner implements Runner {
  name = 'opencode';
  displayName = 'OpenCode';
  installHint = 'go install github.com/opencode-ai/opencode@latest';

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
    
    // Validate model before writing sensitive prompt to disk
    if (options?.model && !isValidModelName(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }

    // Write prompt to a temp file to avoid command line length limits
    const promptFile = join(tmpdir(), `prr-prompt.${process.pid}.${Date.now()}.txt`);
    const cleanupPromptFile = () => {
      try {
        unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }
    };

    // Register cleanup before any file operations
    try {
      writeFileSync(promptFile, prompt, { encoding: 'utf-8', mode: 0o600 });
    } catch (error) {
      cleanupPromptFile();
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, output: '', error: `Failed to write prompt file: ${errorMessage}` };
    }
    debug('Wrote prompt to file', { promptFile, length: prompt.length });
    const promptSlug = debugPrompt('opencode', prompt, { workdir, model: options?.model });

    return new Promise((resolve) => {
      // Build args array safely (no shell interpolation)
      const args: string[] = [];

      // Add model if specified
      if (options?.model) {
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
        detached: true,
        env: { ...process.env },
      });

      // Pipe the prompt file to stdin
      const promptStream = createReadStream(promptFile);
      promptStream.pipe(child.stdin);
      promptStream.on('error', (err: Error) => {
        debug('Error reading prompt file', { error: err.message });
        child.stdin?.destroy();
        child.kill('SIGTERM');
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let closed = false;

      const killTree = (signal: NodeJS.Signals) => {
        try {
          // Kill the entire process group (opencode + any children it spawned)
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          try { child.kill(signal); } catch { /* already dead */ }
        }
      };

      let sigkillFallbackHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutHandle = setTimeout(() => {
        killed = true;
        debug('OpenCode timeout reached, killing process', { timeoutMs: OPENCODE_TIMEOUT_MS });
        killTree('SIGTERM');
        sigkillFallbackHandle = setTimeout(() => {
          if (!closed) {
            debug('OpenCode still alive after SIGTERM, sending SIGKILL');
            killTree('SIGKILL');
          }
        }, 5000);
      }, OPENCODE_TIMEOUT_MS);

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
        closed = true;
        clearTimeout(timeoutHandle);
        if (sigkillFallbackHandle !== undefined) clearTimeout(sigkillFallbackHandle);
        cleanupPromptFile();
        debugResponse(promptSlug, 'opencode', stdout, { exitCode: code, stderrLength: stderr.length, timedOut: killed });

        if (killed) {
          resolve({
            success: false,
            output: stdout,
            error: `OpenCode timed out after ${OPENCODE_TIMEOUT_MS / 1000}s`,
            errorType: 'tool_timeout',
          });
        } else if (code === 0) {
          resolve({
            success: true,
            output: stdout,
          });
        } else {
          const combinedOutput = stdout + stderr;
          if (/quota exceeded|rate.?limit|too many requests|billing|exceeded.*plan/i.test(combinedOutput)) {
            resolve({ success: false, output: stdout, error: stderr || 'Quota or rate limit exceeded', errorType: 'quota' });
          } else if (/does not exist|model.*not found|you do not have access/i.test(combinedOutput)) {
            resolve({ success: false, output: stdout, error: stderr || 'Model not found or not accessible', errorType: 'auth' });
          } else if (/authentication|unauthorized|invalid.*key|api.*key/i.test(combinedOutput)) {
            resolve({ success: false, output: stdout, error: stderr || 'Authentication error', errorType: 'auth' });
          } else {
            resolve({
              success: false,
              output: stdout,
              error: stderr || `Process exited with code ${code}`,
            });
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        cleanupPromptFile();

        resolve({
          success: false,
          output: stdout,
          error: err.message,
        });
      });
    });
  }
}
