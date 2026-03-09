/**
 * Spawn a child process. No shell (shell: false). Capture stdout/stderr. Optional timeout.
 */
import { spawn } from 'child_process';

export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export function spawnTool(
  binary: string,
  args: string[],
  options?: SpawnOptions
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        resolve({
          code: null,
          stdout,
          stderr,
          timedOut: true,
        });
      }, options.timeout);
    }

    child.on('close', (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      resolve({
        code: code ?? null,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      resolve({
        code: null,
        stdout,
        stderr: err.message,
      });
    });
  });
}
