import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import type { Runner, RunnerResult } from './types.js';

const exec = promisify(execCallback);

/**
 * Runner for Claude Code CLI (Anthropic's official CLI tool)
 *
 * WHY: Claude Code is Anthropic's native CLI agent tool, often providing
 * better integration with Claude models and more consistent behavior than
 * third-party wrappers.
 */
export class ClaudeCodeRunner implements Runner {
  name = 'claude-code';

  async isAvailable(): Promise<boolean> {
    try {
      // WHY: Claude Code can be installed as either 'claude' or 'cc' depending
      // on installation method and user preference. We check both to maximize
      // compatibility - try the full name first since it's more explicit.
      try {
        await exec('which claude');
        return true;
      } catch {
        await exec('which cc');
        return true;
      }
    } catch {
      return false;
    }
  }

  async run(workdir: string, prompt: string): Promise<RunnerResult> {
    return new Promise(async (resolve) => {
      // WHY: We need to determine which specific command variant is available
      // since isAvailable() only tells us *if* it's available, not *which* one.
      let command = 'claude';
      try {
        await exec('which claude');
      } catch {
        command = 'cc';
      }

      // WHY: Claude Code accepts the task prompt directly as a CLI argument,
      // similar to opencode. This is simpler than Cursor's --message flag approach.
      const args = [prompt];

      console.log(`Running: ${command} [prompt] in ${workdir}`);

      const child = spawn(command, args, {
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
