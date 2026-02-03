# AI Coding CLI Tools - Developer Reference

Technical reference for integrating AI coding tools from TypeScript/Node.js, based on our actual runner implementations.

---

## Credentials & Authentication

### Summary Table

| Tool | Auth Method | Credential Source | CLI Flag for Creds | Env Variable |
|------|-------------|-------------------|-------------------|--------------|
| **Cursor Agent** | OAuth (browser) | `cursor-agent login` | None | None |
| **Claude Code** | API Key | Env only | None | `ANTHROPIC_API_KEY` |
| **Aider** | API Key | Env only (in our impl) | `--anthropic-api-key`, `--openai-api-key` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| **Codex** | API Key | Env only | None | `OPENAI_API_KEY` |
| **OpenCode** | API Key | Env / config | None | Provider-specific |

---

### Cursor Agent

**Auth**: OAuth via browser - no API key needed.

**How we check auth status** (from `cursor.ts`):
```typescript
// Run `cursor-agent models` - if it works, we're logged in
const { stdout } = await execFile('cursor-agent', ['models']);
if (stdout.includes('Available models') || stdout.includes('auto')) {
  return { ready: true };
}
if (stdout.includes('login') || stdout.includes('auth')) {
  return { ready: false, error: 'Not logged in (run: cursor-agent login)' };
}
```

**Setup**:
```bash
cursor-agent login   # Opens browser, stores token locally
```

---

### Claude Code

**Auth**: `ANTHROPIC_API_KEY` environment variable only.

**How we check** (from `claude-code.ts`):
```typescript
if (!process.env.ANTHROPIC_API_KEY) {
  return { ready: false, error: 'ANTHROPIC_API_KEY not set' };
}
```

**No CLI flag** for API key - must use env var.

---

### Aider

**Auth**: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` environment variable.

**How we check** (from `aider.ts`):
```typescript
const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

if (!hasAnthropicKey && !hasOpenAIKey) {
  return { ready: false, error: 'No API key set (ANTHROPIC_API_KEY or OPENAI_API_KEY)' };
}
```

**Note**: Aider CLI supports `--anthropic-api-key` and `--openai-api-key` flags, but our implementation uses env vars only.

---

### Codex

**Auth**: `OPENAI_API_KEY` environment variable only.

**How we check** (from `codex.ts`):
```typescript
if (!process.env.OPENAI_API_KEY) {
  return { ready: false, error: 'OPENAI_API_KEY not set' };
}
```

---

## Cursor Agent

Binary: `cursor-agent`

### CLI Options (what we use)

```
cursor-agent [options]

Options we use:
  --print                   Output to stdout
  --output-format <fmt>     We use: stream-json
  --stream-partial-output   Stream partial text as generated
  --workspace <path>        Working directory
  --model <name>            Model to use

Commands:
  login                     Authenticate with Cursor
  models                    List available models (also used to check auth)
  --version                 Get version
```

### How We Run It (from `cursor.ts`)

```typescript
import { spawn } from 'child_process';

const CURSOR_AGENT_BINARY = 'cursor-agent';

const args: string[] = [
  '--print',
  '--output-format', 'stream-json',
  '--stream-partial-output',
  '--workspace', workdir,
];

if (options?.model) {
  args.push('--model', options.model);
}

const child = spawn(CURSOR_AGENT_BINARY, args, {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  shell: false,  // Security: prevent shell injection
});

// Pass prompt via stdin
child.stdin?.write(prompt);
child.stdin?.end();
```

### Output Format (stream-json)

Each line is a JSON object:
```jsonl
{"type": "text", "content": "I'll fix..."}
{"type": "tool_use", "name": "edit_file", "input": {"path": "src/foo.ts"}}
{"type": "tool_result", "content": "...", "is_error": false}
{"type": "message_start"}
{"type": "message_stop"}
{"type": "content_block_start"}
{"type": "content_block_stop"}
```

### Parsing stream-json (from `cursor.ts`)

```typescript
const handleLine = (line: string) => {
  try {
    const json = JSON.parse(line);
    if (json.type === 'text' && json.content) {
      process.stdout.write(json.content);
    } else if (json.type === 'tool_use') {
      console.log(`\n🔧 ${json.name || 'tool'}: ${json.input?.path || json.input?.command || ''}`);
    } else if (json.type === 'tool_result' && json.is_error) {
      console.log(`   ❌ Error: ${json.content?.slice(0, 100)}...`);
    } else if (json.content) {
      process.stdout.write(json.content);
    }
  } catch {
    // Not JSON, print raw
    if (line.trim()) process.stdout.write(line + '\n');
  }
};
```

### Fallback Models (from `cursor.ts`)

```typescript
const FALLBACK_MODELS = [
  'claude-4-sonnet-thinking',
  'gpt-4o',
  'claude-4-opus-thinking',
  'gpt-4o-mini',
  'o3',
];
```

### Binary Detection

```typescript
async function isAvailable(): Promise<boolean> {
  try {
    await execFile('which', ['cursor-agent']);
    return true;
  } catch {
    return false;
  }
}
```

---

## Claude Code

Binaries: `claude` or `claude-code` (we try both)

### CLI Options (what we use)

```
claude [options]

Options we use:
  --print                           Output to stdout (non-interactive)
  --dangerously-skip-permissions    Skip file write permission prompts
  --model <name>                    Model to use
  --version                         Get version
  --help                            Check for auth hints
```

### How We Run It (from `claude-code.ts`)

```typescript
import { spawn } from 'child_process';

const CLAUDE_BINARIES = ['claude', 'claude-code'];

const args: string[] = ['--print'];

// For automation - skip permission prompts
const skipPermissions = shouldSkipPermissions();  // Checks PRR_CLAUDE_SKIP_PERMISSIONS env
if (skipPermissions) {
  args.push('--dangerously-skip-permissions');
}

if (options?.model) {
  args.push('--model', options.model);
}

const child = spawn(this.binaryPath, args, {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

// Pass prompt via stdin
child.stdin?.write(prompt);
child.stdin?.end();
```

### Permission Control

```typescript
// From claude-code.ts
function shouldSkipPermissions(): boolean {
  const envValue = process.env.PRR_CLAUDE_SKIP_PERMISSIONS;
  // Default: true (enabled)
  // Set to '0' or 'false' to disable
  return envValue !== '0' && envValue !== 'false';
}

// CAVEAT: Refuses --dangerously-skip-permissions when running as root
function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0;
}
```

### Permission Error Detection (from `claude-code.ts`)

```typescript
const PERMISSION_ERROR_PATTERNS = [
  /requested permissions? to write/i,
  /haven't granted it yet/i,
  /permission.*denied/i,
  /Unable to write.*permission/i,
  /persistent permission error/i,
];

function hasPermissionError(output: string): boolean {
  return PERMISSION_ERROR_PATTERNS.some(pattern => pattern.test(output));
}
```

### Binary Detection

```typescript
const CLAUDE_BINARIES = ['claude', 'claude-code'];

async function isAvailable(): Promise<boolean> {
  for (const binary of CLAUDE_BINARIES) {
    try {
      await exec(`which ${binary}`);
      this.binaryPath = binary;
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}
```

---

## Aider

Binary: `aider`

### CLI Options (what we use)

```
aider [options]

Options we use:
  --yes-always              Auto-confirm all prompts
  --model <provider/model>  Model (e.g., anthropic/claude-sonnet-4-5-20250929)
  --message <prompt>        The prompt to run
  --version                 Get version
```

### How We Run It (from `aider.ts`)

```typescript
import { spawn } from 'child_process';

const args: string[] = ['--yes-always'];

if (options?.model) {
  args.push('--model', options.model);
}

// Pass prompt via --message argument (NOT stdin)
args.push('--message', prompt);

const child = spawn('aider', args, {
  cwd: workdir,
  stdio: ['inherit', 'pipe', 'pipe'],  // Note: stdin is 'inherit'
  env: { ...process.env },
});
```

### Model Format

Provider-prefixed names:
```typescript
// Anthropic
'anthropic/claude-sonnet-4-5-20250929'
'anthropic/claude-opus-4-5-20251101'

// OpenAI
'openai/gpt-5.2'
'openai/gpt-5-mini'
```

### Stderr Filtering (from `aider.ts`)

```typescript
child.stderr?.on('data', (data) => {
  const str = data.toString();
  stderr += str;
  // Filter out warnings
  if (!str.includes('Warning')) {
    process.stderr.write(str);
  }
});
```

---

## OpenAI Codex

Binaries: `codex` or `openai-codex` (we try both)

### CLI Options (what we use)

```
codex exec [options] <prompt | ->

Options we use:
  exec                                    Non-interactive execution mode
  --dangerously-bypass-approvals-and-sandbox  Full automation mode
  -C, --cwd <path>                        Working directory
  --model <name>                          Model to use
  --add-dir <path>                        Add directory to context (repeatable)
  -                                       Read prompt from stdin
  --version                               Get version
```

### How We Run It (from `codex.ts`)

```typescript
import { spawn } from 'child_process';
import { createReadStream } from 'fs';

const CODEX_BINARIES = ['codex', 'openai-codex'];

const args: string[] = ['exec'];

// Full automation - bypass sandbox and approvals
args.push('--dangerously-bypass-approvals-and-sandbox');

// Working directory
args.push('-C', workdir);

if (options?.model) {
  args.push('--model', options.model);
}

// Extra context directories
if (options?.codexAddDirs) {
  for (const dir of options.codexAddDirs) {
    args.push('--add-dir', dir);
  }
}

// Read prompt from stdin
args.push('-');

const child = spawn(this.binaryPath, args, {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CI: '1',           // Hint: non-interactive
    NO_COLOR: '1',     // Disable ANSI colors
    FORCE_COLOR: '0',
  },
});

// Pipe prompt file to stdin
const promptStream = createReadStream(promptFile);
promptStream.pipe(child.stdin);
```

### TTY Error Detection (from `codex.ts`)

```typescript
function isCursorPositionError(output?: string): boolean {
  if (!output) return false;
  // Strip ANSI codes
  const cleaned = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x1f]/g, ' ');
  return /cursor.{0,10}position.{0,10}could.{0,10}not.{0,10}be.{0,10}read/i.test(cleaned);
}
```

### RunnerOptions (from `types.ts`)

```typescript
interface RunnerOptions {
  model?: string;
  codexAddDirs?: string[];  // Only used by Codex
}
```

---

## OpenCode

Binary: `opencode`

### CLI Options (what we use)

```
opencode [options]

Options we use:
  --model <name>            Model to use
  --version                 Get version
```

### How We Run It (from `opencode.ts`)

```typescript
import { spawn } from 'child_process';
import { createReadStream } from 'fs';

const args: string[] = [];

if (options?.model) {
  args.push('--model', options.model);
}

const child = spawn('opencode', args, {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,
  env: { ...process.env },
});

// Pipe prompt file to stdin
const promptStream = createReadStream(promptFile);
promptStream.pipe(child.stdin);
```

---

## Common Types (from `types.ts`)

### RunnerErrorType

```typescript
/**
 * Error types for runner failures
 * - 'permission': Tool lacks write permissions (bail out immediately)
 * - 'auth': Authentication/API key issues
 * - 'timeout': Process timed out
 * - 'tool': General tool failure (retry with different model/tool)
 * - 'environment': TTY/cursor position issues (bail out)
 */
type RunnerErrorType = 'permission' | 'auth' | 'timeout' | 'tool' | 'environment';
```

### RunnerResult

```typescript
interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
  errorType?: RunnerErrorType;
}
```

### RunnerStatus

```typescript
interface RunnerStatus {
  installed: boolean;
  ready: boolean;        // Logged in, API key set, etc.
  version?: string;
  error?: string;        // Why it's not ready
}
```

### RunnerOptions

```typescript
interface RunnerOptions {
  model?: string;
  codexAddDirs?: string[];  // Extra directories for Codex context
}
```

### Runner Interface

```typescript
interface Runner {
  name: string;
  displayName: string;
  supportedModels?: string[];  // Populated dynamically for some runners
  
  run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult>;
  isAvailable(): Promise<boolean>;
  checkStatus(): Promise<RunnerStatus>;
}
```

---

## Default Model Rotations (from `types.ts`)

```typescript
const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  'cursor': [
    'claude-sonnet-4-5',
    'gpt-5.2',
    'claude-opus-4-5',
    'o3',
  ],
  'claude-code': [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ],
  'aider': [
    'anthropic/claude-sonnet-4-5-20250929',
    'openai/gpt-5.2',
    'anthropic/claude-opus-4-5-20251101',
    'openai/gpt-5-mini',
  ],
  'opencode': [
    'claude-sonnet-4-5-20250929',
    'gpt-5.2',
    'gpt-5-mini',
  ],
  'codex': [
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5-mini',
  ],
  'llm-api': [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ],
};
```

---

## Common Patterns

### Model Name Validation (from config.ts, used by all runners)

```typescript
function isValidModelName(model: string): boolean {
  // Allow alphanumeric, dots, dashes, underscores, forward slashes
  return /^[A-Za-z0-9._\/-]+$/.test(model);
}

// Usage in runners:
if (options?.model && !isValidModel(options.model)) {
  return { success: false, output: '', error: `Invalid model name: ${options.model}` };
}
```

### Prompt File Handling (used by all runners)

```typescript
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Write prompt to temp file with restricted permissions
const promptFile = join(tmpdir(), `prr-prompt.${process.pid}.${Date.now()}.txt`);
writeFileSync(promptFile, prompt, { encoding: 'utf-8', mode: 0o600 });

// Cleanup helper
const cleanupPromptFile = () => {
  try {
    unlinkSync(promptFile);
  } catch {
    // Ignore cleanup errors
  }
};
```

### Empty Prompt Guard (all runners)

```typescript
if (!prompt || prompt.trim().length === 0) {
  return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
}
```

### Error Classification (example from codex.ts)

```typescript
const combinedOutput = stdout + stderr;

if (/authentication|unauthorized|invalid.*key|api.*key/i.test(combinedOutput)) {
  return { success: false, output: stdout, error: 'Authentication error', errorType: 'auth' };
}
if (/permission denied|cannot write|read-only/i.test(combinedOutput)) {
  return { success: false, output: stdout, error: 'Permission error', errorType: 'permission' };
}
```

### Binary Detection Pattern

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Single binary
async function isAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['cursor-agent']);
    return true;
  } catch {
    return false;
  }
}

// Multiple possible binaries
const BINARIES = ['claude', 'claude-code'];

async function isAvailable(): Promise<boolean> {
  for (const binary of BINARIES) {
    try {
      await exec(`which ${binary}`);
      this.binaryPath = binary;
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}
```

---

## Summary: How Each Tool Gets Its Prompt

| Tool | Prompt Delivery | Args |
|------|-----------------|------|
| **Cursor Agent** | stdin | `--print --output-format stream-json --workspace <dir>` |
| **Claude Code** | stdin | `--print --dangerously-skip-permissions` |
| **Aider** | `--message <prompt>` | `--yes-always --model <model>` |
| **Codex** | stdin (piped from file) | `exec --dangerously-bypass-approvals-and-sandbox -C <dir> -` |
| **OpenCode** | stdin (piped from file) | `--model <model>` |

---

## Summary: Environment Variables

| Variable | Used By |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude Code, Aider, LLM API |
| `OPENAI_API_KEY` | Codex, Aider, LLM API |
| `PRR_CLAUDE_SKIP_PERMISSIONS` | Claude Code (set to `0` to disable skip-permissions) |
| `CI`, `NO_COLOR`, `FORCE_COLOR` | Set by Codex runner for automation hints |
