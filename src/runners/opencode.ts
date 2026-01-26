import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { Runner, RunnerResult } from './types.js';

const exec = promisify(execCallback);

/**
 * Runner for OpenCode CLI
 *
 * WHY: OpenCode provides an alternative/open-source option for users who
 * prefer not to use commercial tools or want different features.
 */
export class OpencodeRunner implements Runner {
  name = 'opencode';

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which opencode');
      return true;
    } catch {
      return false;
    }
  }

  async run(workdir: string, prompt: string): Promise<RunnerResult> {
    return new Promise((resolve) => {
      // WHY: opencode takes the prompt as a direct argument (simpler than Cursor's
      // --message flag approach). Working directory is set via cwd in spawn options.
      const args = [prompt];

      console.log(`Running: opencode [prompt] in ${workdir}`);

      const child = spawn('opencode', args, {
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
        process.stderr.write(str);
      });

      child.on('close', (code) => {
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
        resolve({
          success: false,
          output: stdout,
          error: err.message,
        });
      });
    });
  }
}
