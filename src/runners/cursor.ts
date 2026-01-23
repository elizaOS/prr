import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { Runner, RunnerResult } from './types.js';

const exec = promisify(execCallback);

export class CursorRunner implements Runner {
  name = 'cursor';

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which cursor');
      return true;
    } catch {
      return false;
    }
  }

  async run(workdir: string, prompt: string): Promise<RunnerResult> {
    return new Promise((resolve) => {
      // Write prompt to a temp file to avoid shell escaping issues
      const args = [
        'agent',
        '--message', prompt,
        '--directory', workdir,
      ];

      console.log(`Running: cursor ${args.slice(0, 3).join(' ')} [prompt] --directory ${workdir}`);

      const child = spawn('cursor', args, {
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
