import { spawn, execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';
import { isValidModelName } from '../config.js';

const execFile = promisify(execFileCallback);

// Validate model name to prevent injection (defense in depth)
// Allows forward slashes for provider-prefixed names like "anthropic/claude-..."
function isValidModel(model: string): boolean {
  return isValidModelName(model);
}

function isSafePath(value: string): boolean {
  return value.length > 0 && !/[\0\r\n]/.test(value);
}

// Cursor Agent CLI binary - DO NOT include 'cursor' as that's the IDE, not the CLI agent
const CURSOR_AGENT_BINARY = 'cursor-agent';

// Fallback model list if dynamic discovery fails
const FALLBACK_MODELS = [
  'claude-4-sonnet-thinking',
  'gpt-5.2',
  'claude-4-opus-thinking',
  'gpt-5.2-codex',
  'o3',
];

/**
 * Model family priority for sorting discovered models
 * WHY: We want to try Claude first (best reasoning), then GPT (good coding),
 * then Gemini, then others. Within families, prefer thinking variants and higher tiers.
 */
const MODEL_FAMILY_PRIORITY: Array<{ pattern: RegExp; priority: number; subPriority?: (model: string) => number }> = [
  // Claude models - highest priority
  { 
    pattern: /^(?:claude-\d+-)?(opus|sonnet|haiku)/i, 
    priority: 1,
    subPriority: (m) => {
      if (m.includes('opus')) return 1;
      if (m.includes('sonnet')) return 2;
      if (m.includes('haiku')) return 3;
      return 10;
    }
  },
  // GPT models - second priority  
  { 
    pattern: /^(gpt-|o\d)/i, 
    priority: 2,
    subPriority: (m) => {
      if (/^o\d/i.test(m)) return 1;
      // Prefer higher versions, codex variants, and high tiers
      if (m.includes('5.2') && m.includes('codex') && m.includes('high')) return 1;
      if (m.includes('5.2') && m.includes('codex')) return 2;
      if (m.includes('5.2') && m.includes('high')) return 3;
      if (m.includes('5.2')) return 4;
      if (m.includes('5.1')) return 5;
      return 10;
    }
  },
  // Gemini models - third priority
  { 
    pattern: /^gemini-/i, 
    priority: 3,
    subPriority: (m) => m.includes('pro') ? 1 : 2
  },
  // Others (grok, etc) - lowest priority
  { pattern: /.*/, priority: 99 },
];

/**
 * Parse `cursor-agent models` output and return prioritized model list
 */
function parseAndPrioritizeModels(output: string): string[] {
  const models: string[] = [];
  const lines = output.split('\n');
  
  for (const line of lines) {
    // Format: "model-id - Model Description" or "model-id - Description (current, default)"
    const match = line.match(/^([a-zA-Z0-9._-]+)\s+-\s+/);
    if (match) {
      const modelId = match[1];
      // Skip 'auto' and 'composer-1' as they're meta-models
      if (modelId !== 'auto' && modelId !== 'composer-1') {
        models.push(modelId);
      }
    }
  }
  
  // Sort by family priority
  models.sort((a, b) => {
    let aPriority = 99, bPriority = 99;
    let aSubPriority = 99, bSubPriority = 99;
    
    for (const { pattern, priority, subPriority } of MODEL_FAMILY_PRIORITY) {
      if (pattern.test(a) && priority < aPriority) {
        aPriority = priority;
        aSubPriority = subPriority?.(a) ?? 99;
      }
      if (pattern.test(b) && priority < bPriority) {
        bPriority = priority;
        bSubPriority = subPriority?.(b) ?? 99;
      }
    }
    
    if (aPriority !== bPriority) return aPriority - bPriority;
    if (aSubPriority !== bSubPriority) return aSubPriority - bSubPriority;
    return a.localeCompare(b);
  });
  
  // Group models by family
  const byFamily: Record<string, string[]> = {
    claude: [],
    gpt: [],
    gemini: [],
    other: [],
  };
  
  for (const model of models) {
    if (/^(?:claude-\d+-)?(opus|sonnet|haiku)/i.test(model)) byFamily.claude.push(model);
    else if (/^(gpt-|o\d)/i.test(model)) byFamily.gpt.push(model);
    else if (/^gemini-/i.test(model)) byFamily.gemini.push(model);
    else byFamily.other.push(model);
  }
  
  // Interleave families: switch providers before trying another model from same provider
  // WHY: If Claude sonnet can't solve it, GPT might have better luck than Claude opus
  // Different providers have different strengths/weaknesses
  const selected: string[] = [];
  const familyOrder = ['claude', 'gpt', 'gemini', 'other'];
  const maxPerFamily = 2;
  
  for (let round = 0; round < maxPerFamily; round++) {
    for (const family of familyOrder) {
      if (byFamily[family][round]) {
        selected.push(byFamily[family][round]);
      }
    }
  }
  
  // Limit to reasonable size
  return selected.slice(0, 6);
}

export class CursorRunner implements Runner {
  name = 'cursor';
  displayName = 'Cursor Agent';
  
  // Dynamically discovered models (populated on checkStatus)
  supportedModels?: string[];

  async isAvailable(): Promise<boolean> {
    try {
      await execFile('which', [CURSOR_AGENT_BINARY]);
      debug(`Found Cursor Agent CLI: ${CURSOR_AGENT_BINARY}`);
      return true;
    } catch {
      debug('Cursor Agent CLI not found (install: Linux curl https://cursor.com/install -fsS | bash; Intel Mac curl https://cursor.com/install -fsS | bash)');
      return false;
    }
  }

  async checkStatus(): Promise<RunnerStatus> {
    // Check if installed
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, ready: false, error: 'cursor-agent not installed (install: Linux curl https://cursor.com/install -fsS | bash; Intel Mac curl https://cursor.com/install -fsS | bash)' };
    }

    // Check version
    let version: string | undefined;
    try {
      const { stdout } = await execFile(CURSOR_AGENT_BINARY, ['--version']);
      version = stdout.trim();
    } catch {
      // Version check failed, but might still work
    }

    // Check if logged in and get available models
    try {
      const { stdout } = await execFile(CURSOR_AGENT_BINARY, ['models']);
      if (stdout.includes('Available models') || stdout.includes('auto')) {
        // Parse and prioritize models dynamically
        // WHY: Model names change over time, dynamic discovery keeps us current
        const discoveredModels = parseAndPrioritizeModels(stdout);
        if (discoveredModels.length > 0) {
          this.supportedModels = discoveredModels;
          debug('Discovered Cursor models', { models: discoveredModels });
        } else {
          // Fallback if parsing failed
          this.supportedModels = FALLBACK_MODELS;
          debug('Using fallback Cursor models (parsing failed)');
        }
        return { installed: true, ready: true, version };
      }
      if (stdout.includes('login') || stdout.includes('auth') || stdout.includes('unauthorized')) {
        return { installed: true, ready: false, version, error: 'Not logged in (run: cursor-agent login)' };
      }
      // Command worked but unexpected output - use fallback
      this.supportedModels = FALLBACK_MODELS;
      return { installed: true, ready: true, version };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (error.includes('login') || error.includes('auth')) {
        return { installed: true, ready: false, version, error: 'Not logged in (run: cursor-agent login)' };
      }
      // Use fallback models on error
      this.supportedModels = FALLBACK_MODELS;
      return { installed: true, ready: false, version, error };
    }
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    if (!isSafePath(workdir)) {
      return { success: false, output: '', error: `Invalid workdir path: ${workdir}` };
    }
    // Write prompt to a temp file for reference
    const promptFile = join(workdir, '.prr-prompt.txt');
    if (!isSafePath(promptFile)) {
      return { success: false, output: '', error: `Invalid prompt file path: ${promptFile}` };
    }
    writeFileSync(promptFile, prompt, 'utf-8');
    debug('Wrote prompt to file', { promptFile, length: prompt.length });

    return new Promise((resolve) => {
      // Build args array safely (no shell interpolation)
      // cursor-agent options:
      // --print: Output to console (for scripts)
      // --output-format stream-json: Stream JSON chunks for live output
      // --stream-partial-output: Stream partial text as it's generated
      // --workspace: Working directory
      // --model: Model to use (e.g., claude-4-opus-thinking, claude-4-sonnet-thinking)
      // prompt: Positional argument at the end
      
      const args: string[] = [
        '--print',
        '--output-format', 'stream-json',
        '--stream-partial-output',
        '--workspace', workdir,
      ];
      
      // Validate and add model if specified
      if (options?.model) {
        if (!isValidModel(options.model)) {
          // Clean up the temp prompt file before returning
          try { unlinkSync(promptFile); } catch { /* ignore unlink errors */ }
          resolve({ success: false, output: '', error: `Invalid model name: ${options.model}` });
          return;
        }
        args.push('--model', options.model);
      }
      
      // Pass prompt content directly as positional argument
      args.push(prompt);
      
      const modelInfo = options?.model ? ` (model: ${options.model})` : '';
      console.log(`\nRunning: ${CURSOR_AGENT_BINARY}${modelInfo} --workspace ${workdir} [prompt]\n`);
      debug('Cursor command', { binary: CURSOR_AGENT_BINARY, workdir, model: options?.model, promptLength: prompt.length });

      // SECURITY: Use spawn with argument array (no shell) to prevent shell injection.
      // Paths like workdir could contain special characters from repo names or PR numbers.
      // By using spawn without shell: true, arguments are passed directly to the process.
      const child = spawn(CURSOR_AGENT_BINARY, args, {
        cwd: workdir,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
        shell: false, // Explicit: prevent shell injection via paths/arguments
      });

      let stdout = '';
      let stderr = '';
      let lastContent = '';
      let pending = '';

      const handleLine = (line: string) => {
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
      };

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        pending += str;
        
        // Parse stream-json output and display nicely
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        const nonEmpty = lines.filter((l: string) => l.trim());
        for (const line of nonEmpty) {
          handleLine(line);
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
        if (pending.trim()) {
          handleLine(pending);
          pending = '';
        }
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
