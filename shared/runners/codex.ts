import { spawn } from 'child_process';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import { createReadStream, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import dotenv from 'dotenv';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus, TokenUsage } from './types.js';
import { debug, debugPrompt, debugResponse } from '../logger.js';
import { isValidModelName } from '../config.js';

const execFile = promisify(execFileCallback);

// Validate model name to prevent injection (defense in depth)
// OpenAI Codex CLI binary names
const CODEX_BINARIES = ['codex', 'openai-codex'];

export class CodexRunner implements Runner {
  name = 'codex';
  displayName = 'OpenAI Codex';
  installHint = 'npm install -g @openai/codex';
  private binaryPath: string = 'codex';

  async isAvailable(): Promise<boolean> {
    for (const binary of CODEX_BINARIES) {
      try {
        await execFile('which', [binary]);
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
      const { stdout, stderr } = await execFile(this.binaryPath, ['--version']);
      version = (stdout || stderr).trim();
    } catch {
      // Version check might fail
    }

    // Check for OpenAI API key (load .env from cwd if not set)
    if (!process.env.OPENAI_API_KEY) {
      dotenv.config({ path: join(process.cwd(), '.env') });
    }
    if (!process.env.OPENAI_API_KEY) {
      return { installed: true, ready: false, version, error: 'OPENAI_API_KEY not set (set in .env or environment)' };
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
    if (options?.model && !isValidModelName(options.model)) {
      return { success: false, output: '', error: `Invalid model name: ${options.model}` };
    }
    
    // Guard: Reject non-OpenAI models — Codex only supports OpenAI models.
    // WHY: If model rotation recommends an Anthropic/Google model (e.g., after
    // a runner switch), sending it to the OpenAI API wastes a retry cycle and
    // triggers a confusing "model does not exist" auth error.
    if (options?.model && /^(claude|anthropic|gemini)/i.test(options.model)) {
      const msg = `Model "${options.model}" is not an OpenAI model — skipping for Codex`;
      debug(msg);
      return { success: false, output: '', error: msg, errorType: 'model' };
    }

    // Write prompt to temp file for stdin piping
    const promptFile = join(tmpdir(), `prr-prompt.${process.pid}.${Date.now()}.txt`);
    writeFileSync(promptFile, prompt, { encoding: 'utf-8', mode: 0o600 });
    debug('Wrote prompt to file', { promptFile, length: prompt.length });
    const promptSlug = debugPrompt('codex', prompt, { workdir, model: options?.model });
    
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
    // Force API key auth so Codex uses OPENAI_API_KEY instead of cached ChatGPT/Teams login.
    // See https://github.com/openai/codex/issues/2733 — when a Teams subscription login is active,
    // Codex can ignore OPENAI_API_KEY and use the session (which may 401 for API calls).
    args.push('--config', 'forced_login_method=api');
    // Bypass sandbox and approvals - prr controls the execution environment
    // WHY: Codex's landlock sandbox can fail in some environments (containers, etc.)
    // prr already isolates work in a cloned workdir, so external sandboxing is sufficient
    args.push('--dangerously-bypass-approvals-and-sandbox');
    
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
    
    // JSONL stdout so we can parse turn.completed (token usage) and item.completed agent_message (final output)
    args.push('--json');
    // Read prompt from stdin
    args.push('-');

    return new Promise((resolve) => {
      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${this.binaryPath} exec${modelInfo} [prompt via stdin]\n`);
      debug('Codex exec command', { 
        binary: this.binaryPath, 
        args: args.filter(a => a !== '-'), // Don't log the stdin marker
        workdir, 
        model: options?.model, 
        promptLength: prompt.length,
      });

      // Prefer key from options (config), then process.env, then .env from cwd
      let apiKey = options?.openaiApiKey?.trim();
      if (!apiKey && !process.env.OPENAI_API_KEY) {
        dotenv.config({ path: join(process.cwd(), '.env') });
      }
      if (!apiKey) {
        apiKey = process.env.OPENAI_API_KEY?.trim();
      }
      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      };
      if (apiKey) {
        spawnEnv.OPENAI_API_KEY = apiKey;
        // codex exec uses CODEX_API_KEY for implicit login, not OPENAI_API_KEY (openai/codex#7323).
        spawnEnv.CODEX_API_KEY = apiKey;
      }
      // Force Codex to use the real OpenAI API so our key works (see openai/codex#9153).
      // If OPENAI_BASE_URL is set (e.g. to a proxy or api.z.ai), Codex may call that URL and get 401.
      delete spawnEnv.OPENAI_BASE_URL;
      delete spawnEnv.OPENAI_API_BASE;
      const child = spawn(this.binaryPath, args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
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
      let lineBuffer = '';
      const aggregatedUsage: TokenUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
      let lastAgentMessage = '';

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        lineBuffer += str;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as { type?: string; usage?: TokenUsage; item?: { type?: string; text?: string } };
            if (obj.type === 'turn.completed' && obj.usage) {
              aggregatedUsage.input_tokens += obj.usage.input_tokens ?? 0;
              aggregatedUsage.cached_input_tokens = (aggregatedUsage.cached_input_tokens ?? 0) + (obj.usage.cached_input_tokens ?? 0);
              aggregatedUsage.output_tokens += obj.usage.output_tokens ?? 0;
            } else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') {
              lastAgentMessage = obj.item.text;
            }
          } catch {
            // Not JSON or malformed; ignore line
          }
        }
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        process.stderr.write(str);
      });

      child.on('close', (code) => {
        cleanupPromptFile();
        // Parse any remaining line (no trailing newline)
        if (lineBuffer.trim()) {
          try {
            const obj = JSON.parse(lineBuffer.trim()) as { type?: string; usage?: TokenUsage; item?: { type?: string; text?: string } };
            if (obj.type === 'turn.completed' && obj.usage) {
              aggregatedUsage.input_tokens += obj.usage.input_tokens ?? 0;
              aggregatedUsage.cached_input_tokens = (aggregatedUsage.cached_input_tokens ?? 0) + (obj.usage.cached_input_tokens ?? 0);
              aggregatedUsage.output_tokens += obj.usage.output_tokens ?? 0;
            } else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') {
              lastAgentMessage = obj.item.text;
            }
          } catch {
            // ignore
          }
        }
        const output = lastAgentMessage || stdout;
        debugResponse(promptSlug, 'codex', output, { exitCode: code, stderrLength: stderr.length, usage: aggregatedUsage });

        // Safety check: detect cursor position error even in exec mode (shouldn't happen, but just in case)
        const hasCursorError = isCursorPositionError(stdout) || isCursorPositionError(stderr);
        if (hasCursorError) {
          debug('Codex cursor position error detected in exec mode - unexpected environment issue');
          resolve({
            success: false,
            output,
            error: 'Codex cursor position error: TTY/PTY environment issue. This is unexpected in exec mode.',
            errorType: 'environment',
          });
          return;
        }

        const usage = (aggregatedUsage.input_tokens || aggregatedUsage.output_tokens) ? aggregatedUsage : undefined;

        if (code === 0) {
          resolve({ success: true, output, usage });
        } else {
          // Check for common error patterns
          const combinedOutput = stdout + stderr;
          // AUTH (401 / missing key) FIRST — so we don't misclassify as quota.
          // 401 Unauthorized / Missing bearer = API key not set or invalid; user needs to fix env, not rotate.
          if (/\b401\b|unauthorized|missing bearer|basic authentication in header/i.test(combinedOutput)) {
            const authMsg = /missing bearer|basic authentication/i.test(combinedOutput)
              ? 'OpenAI API key missing or invalid (401 Unauthorized). For codex exec we set CODEX_API_KEY from your key; ensure OPENAI_API_KEY (or config) is set so we can pass it. If OPENAI_BASE_URL is set, unset it (see github.com/openai/codex/issues/9153). See also #7323 (codex exec needs CODEX_API_KEY).'
              : (stderr || 'Authentication error');
            debug('Codex auth error (401 or missing key)');
            resolve({ success: false, output, error: authMsg, errorType: 'auth', usage });
          } else if (/authentication|invalid.*key|api.*key.*rejected/i.test(combinedOutput)) {
            resolve({ success: false, output, error: stderr || `Authentication error`, errorType: 'auth', usage });
          } else if (/quota exceeded|rate.?limit|too many requests|billing|exceeded.*plan|tokens?.used/i.test(combinedOutput)) {
            const tokensMatch = combinedOutput.match(/tokens?\s*used\s*[\n:]*\s*([\d,]+)/i);
            const tokenInfo = tokensMatch ? ` (${tokensMatch[1]} tokens used)` : '';
            const errorMsg = `Quota/rate limit exceeded${tokenInfo}`;
            debug('Quota exceeded - will rotate to next tool/model', { error: errorMsg });
            resolve({ success: false, output, error: errorMsg, errorType: 'quota', usage });
          } else if (/does not exist|model.*not found|you do not have access/i.test(combinedOutput)) {
            // Model doesn't exist or API key lacks access - bail immediately
            // WHY: Retrying won't help. Need different model or API access.
            const modelError = combinedOutput.match(/The model [`'"]?([^`'"]+)[`'"]? does not exist/i);
            const errorMsg = modelError 
              ? `Model "${modelError[1]}" does not exist or is not accessible`
              : stderr || 'Model not found or not accessible';
            debug('Model access error - bailing immediately', { error: errorMsg });
            resolve({ success: false, output, error: errorMsg, errorType: 'auth', usage });
          } else if (/permission denied|cannot write|read-only/i.test(combinedOutput)) {
            resolve({ success: false, output, error: stderr || `Permission error`, errorType: 'permission', usage });
          } else {
            resolve({ success: false, output, error: stderr || `Process exited with code ${code}`, usage });
          }
        }
      });

      child.on('error', (err) => {
        cleanupPromptFile();
        resolve({ success: false, output: lastAgentMessage || stdout, error: err.message });
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
