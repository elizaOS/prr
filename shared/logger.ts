/**
 * Logging: output log tee, prompts log, debug files, and structured debug().
 *
 * WHY two log files (output.log + prompts.log): output.log mirrors the console
 * for operational flow; inlining full prompts would make it unreadable. prompts.log
 * holds full LLM content with searchable slugs so you can jump from a line in
 * output.log to the exact prompt that produced it. WHY strip ANSI: Log files are
 * for grepping and sharing; escape codes add noise. WHY exclude spinner output:
 * ora/spinner write via process.stdout.write, not console.log; excluding them
 * keeps the log free of progress-bar artifacts.
 */
import chalk from 'chalk';
import { writeFileSync, readFileSync, mkdirSync, createWriteStream, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { format } from 'node:util';
import { randomUUID } from 'node:crypto';
import { finished } from 'stream/promises';
import type { WriteStream } from 'fs';

let verboseEnabled = false;
let debugLogDir: string | null = null;
let debugLogCounter = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OUTPUT LOG TEE — mirrors all console output to ~/.prr/output.log
// Provides persistent logging in a consistent user-specific location
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let outputLogStream: WriteStream | null = null;
let outputLogPath: string | null = null;
let promptLogStream: WriteStream | null = null;
let promptLogPath: string | null = null;
let outputLogExitHandlerRegistered = false;
// Pill #8: Counter for empty prompt bodies to emit summary at close
let emptyPromptBodyCount = 0;

/** Same `requestId` on PROMPT + RESPONSE metadata when concurrent LLM calls reorder prompts.log (grep `requestId` to pair). */
const promptRequestIdBySlug = new Map<string, string>();

/** When true, callers should run `runPillAfterClosedLogs()` from tools/pill after `closeOutputLog()`. Set via initOutputLog enablePill or setPillEnabled(--pill). */
let pillAnalysisEnabled = false;

/** Enable or disable pill analysis on close. Call after parse when user passes --pill. WHY opt-in: default runs stay fast; tools like split-exec have no LLM calls so pill would often have nothing to analyze unless the user explicitly requests it. */
export function setPillEnabled(enabled: boolean): void {
  pillAnalysisEnabled = enabled;
}

/** True when --pill / enablePill was set and pill has not yet been run for this close cycle. */
export function isPillScheduledForAfterClose(): boolean {
  return pillAnalysisEnabled;
}

/** Clear pill scheduling after running pill (or to cancel). */
export function clearPillScheduled(): void {
  pillAnalysisEnabled = false;
}

/** Log prefix from initOutputLog (e.g. 'story') so pill knows which log files to read. */
let currentLogPrefix: string | undefined;
/** Original console methods, captured before patching, for pill hook to print to real console. */
let origLogRef: ((...args: unknown[]) => void) | null = null;
let origWarnRef: ((...args: unknown[]) => void) | null = null;
let origErrorRef: ((...args: unknown[]) => void) | null = null;

/** Prefix from initOutputLog (e.g. story) for pill log resolution. */
export function getOutputLogPrefix(): string | undefined {
  return currentLogPrefix;
}

/** Unpatched console methods for post-close pill output (tee may still wrap console). */
export function getOriginalConsoleForShutdown(): {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  return {
    log: origLogRef ?? console.log.bind(console),
    warn: origWarnRef ?? console.warn.bind(console),
    error: origErrorRef ?? console.error.bind(console),
  };
}

/**
 * Strip ANSI escape codes from a string for plain-text logging.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:\[[\x20-\x3F]*[\x40-\x7E]|\].*?(?:\x07|\x1B\\)|\(B)/g, '');
}

/**
 * Options for initOutputLog.
 * WHY prefix: When multiple tools (prr, story, pill) run from the same directory, each can use a prefix
 * (e.g. story → story-output.log, story-prompts.log) so they don't overwrite each other. Pill uses its own
 * logger with hardcoded pill-* names; story uses shared logger with prefix 'story'; prr uses no prefix.
 */
export interface InitOutputLogOptions {
  prefix?: string;
  /** When true, call `runPillAfterClosedLogs()` after `closeOutputLog()` to analyze logs. */
  enablePill?: boolean;
}

/**
 * Initialize the output log tee.
 *
 * Creates/truncates output.log (or {prefix}-output.log when options.prefix is set)
 * and patches console.log/warn/error to mirror all formatted output (ANSI-stripped) to the file.
 *
 * Spinner output (ora etc.) goes through process.stdout.write — NOT console.log —
 * and is intentionally excluded.  It's pure UI noise with no analytical value.
 *
 * Call this once at startup, before any meaningful output.
 *
 * Log directory: process.cwd() unless PRR_LOG_DIR is set (e.g. to avoid
 * overwriting output.log/prompts.log in the project root when you want to
 * preserve them for pill or inspection).
 */
export function initOutputLog(options?: InitOutputLogOptions): void {
  const logDir = process.env.PRR_LOG_DIR ? join(process.cwd(), process.env.PRR_LOG_DIR) : process.cwd();
  const prefix = options?.prefix;
  const outputFileName = prefix ? `${prefix}-output.log` : 'output.log';
  const promptFileName = prefix ? `${prefix}-prompts.log` : 'prompts.log';

  pillAnalysisEnabled = options?.enablePill ?? false;
  currentLogPrefix = prefix;
  outputLogPath = join(logDir, outputFileName);

  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // ignore; writeFileSync will fail if dir missing
  }
  writeFileSync(outputLogPath, '', 'utf-8');
  // Review: ensures logging to a single stream, preventing double initialization issues.
  outputLogStream = createWriteStream(outputLogPath, { flags: 'a', encoding: 'utf-8' });
  outputLogStream.on('error', (err) => {
    if (origErrorRef) origErrorRef('Output log stream error:', err);
    try {
      outputLogStream?.end();
    } catch {
      // ignore
    }
    outputLogStream = null;
  });

  // Companion log for full prompts & responses — search by slug (e.g. "#0009")
  // to jump from output.log to the exact prompt/response in prompts.log.
  promptLogPath = join(logDir, promptFileName);
  writeFileSync(promptLogPath, '', 'utf-8');
  promptRequestIdBySlug.clear();
  promptLogStream = createWriteStream(promptLogPath, { flags: 'a', encoding: 'utf-8' });
  promptLogStream.on('error', (err) => {
    if (origErrorRef) origErrorRef('Prompts log stream error:', err);
    try {
      promptLogStream?.end();
    } catch {
      // ignore
    }
    promptLogStream = null;
  });

  // WHY guard: on second init, console.log is already the patched function from first init.
  // Overwriting origLogRef with that would make the pill hook log to a closed/wrong stream. Only capture when refs are null.
  const origLog = origLogRef ?? console.log.bind(console);
  const origWarn = origWarnRef ?? console.warn.bind(console);
  const origError = origErrorRef ?? console.error.bind(console);
  if (origLogRef === null) origLogRef = origLog;
  if (origWarnRef === null) origWarnRef = origWarn;
  if (origErrorRef === null) origErrorRef = origError;

  if (!outputLogExitHandlerRegistered) {
    outputLogExitHandlerRegistered = true;
    process.on('exit', () => {
      try {
        outputLogStream?.end();
      } catch {
        // ignore
      }
      try {
        promptLogStream?.end();
      } catch {
        // ignore
      }
    });
  }

  function logToStream(...args: unknown[]): void {
    if (!outputLogStream) return;
    try {
      const text = format(...args);
      const clean = stripAnsi(text);
      if (clean) outputLogStream.write(clean + '\n');
    } catch (err) {
      origError('Log stream write failed:', err);
    }
  }

  console.log = (...args: unknown[]) => { logToStream(...args); origLog(...args); };
  console.warn = (...args: unknown[]) => { logToStream(...args); origWarn(...args); };
  console.error = (...args: unknown[]) => { logToStream(...args); origError(...args); };
}

/**
 * Close the output log and prompts log streams (call during shutdown).
 * WHY: Without closing, the last lines may stay buffered and the file may be
 * unreadable or truncated when the user opens it after the process exits.
 * Waits for streams to flush so callers (e.g. before process.exit()) can rely on logs being written.
 */
export async function closeOutputLog(): Promise<void> {
  const streams: WriteStream[] = [];
  if (outputLogStream) {
    streams.push(outputLogStream);
    outputLogStream.end();
    outputLogStream = null;
  }
  if (promptLogStream) {
    streams.push(promptLogStream);
    promptLogStream.end();
    promptLogStream = null;
  }
  for (const stream of streams) {
    try {
      await finished(stream);
    } catch (err) {
      // Log but don't throw; caller expects shutdown to complete
      if (origErrorRef) origErrorRef('Log stream close/flush failed:', err);
    }
  }

  // Pill #8: Emit summary of empty prompt bodies to output.log so operators see it
  if (emptyPromptBodyCount > 0 && outputLogPath) {
    const summaryMsg = `WARNING: ${formatNumber(emptyPromptBodyCount)} prompts.log entr${emptyPromptBodyCount === 1 ? 'y' : 'ies'} had empty bodies — see stderr for details. This may indicate a logging bug (e.g. elizacloud streaming not passing accumulated response to logger).\n`;
    try {
      appendFileSync(outputLogPath, summaryMsg, 'utf-8');
      if (origWarnRef) origWarnRef(summaryMsg.trim());
    } catch {
      // ignore write errors during shutdown
    }
    // Reset counter for next run
    emptyPromptBodyCount = 0;
  }
}

/**
 * Get the path to the current output log file.
 */
export function getOutputLogPath(): string | null {
  return outputLogPath;
}

/** Path to the current prompts.log (or {prefix}-prompts.log). Null if initOutputLog was not called or failed. */
export function getPromptLogPath(): string | null {
  return promptLogPath;
}

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;

  // If verbose mode, enable prompt/response logging to files
  // Can be disabled with PRR_DEBUG_PROMPTS=0
  if (enabled && process.env.PRR_DEBUG_PROMPTS !== '0') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    debugLogDir = join(homedir(), '.prr', 'debug', timestamp);
    mkdirSync(debugLogDir, { recursive: true });
    console.log(chalk.gray(`  Debug logs: ${debugLogDir}`));
  }
}

/**
 * Safely stringify a value to JSON, handling edge cases.
 *
 * WHY: JSON.stringify throws on BigInt values and can throw on objects
 * with custom toJSON methods that error. This provides a safe fallback.
 *
 * @param value - The value to stringify
 * @param pretty - If true, format with 2-space indentation
 * @returns JSON string or string representation if JSON fails
 */
function safeStringify(value: unknown, pretty = false): string {
  try {
    return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  } catch {
    // Fallback for values that can't be JSON serialized (BigInt, circular, etc.)
    return String(value);
  }
}

function formatCompact(data: unknown): string {
  if (typeof data === 'string') {
    // Truncate long strings
    return data.length > 200 ? data.substring(0, 200) + '...' : data;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    if (data.length <= 3) {
      return '[' + data.map(formatCompact).join(', ') + ']';
    }
    return `[${data.length} items]`;
  }
  if (typeof data === 'object' && data !== null) {
    const entries = Object.entries(data);
    const parts = entries.map(([k, v]) => {
      if (typeof v === 'string' && v.length > 50) {
        return `${k}: "${v.substring(0, 50)}..."`;
      }
      if (typeof v === 'object' && v !== null) {
        if (Array.isArray(v)) {
          // Show short arrays of primitives inline, collapse long/complex ones.
          // WHY: [14] (a number array) was displayed as [1] (its length),
          // which looks like "array containing 1" — genuinely misleading.
          if (v.length <= 5 && v.every(item => typeof item !== 'object' || item === null)) {
            const items = v.map(item => {
              if (typeof item === 'string' && item.length > 40) return `"${item.substring(0, 40)}..."`;
              return safeStringify(item);
            });
            return `${k}: [${items.join(', ')}]`;
          }
          return `${k}: [${v.length}]`;
        }
        return `${k}: {...}`;
      }
      return `${k}: ${safeStringify(v)}`;
    });
    return '{ ' + parts.join(', ') + ' }';
  }
  return String(data);
}

export function debug(message: string, data?: unknown): void {
  if (!verboseEnabled) return;

  const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);

  if (data !== undefined) {
    console.log(chalk.gray(`[${timestamp}]`), chalk.cyan('[DEBUG]'), message, chalk.gray('→'), formatCompact(data));
  } else {
    console.log(chalk.gray(`[${timestamp}]`), chalk.cyan('[DEBUG]'), message);
  }
}

export function debugStep(step: string): void {
  if (!verboseEnabled) return;
  console.log(chalk.yellow(`\n━━━ ${step} ━━━\n`));
}

export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function warn(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

export function error(message: string): void {
  console.log(chalk.red('✗'), message);
}

/**
 * Generate the searchable slug for a prompt/response entry.
 * Format: "#0009/llm-anthropic" — unique, greppable from output.log into prompts.log.
 */
function promptSlug(counter: number, label: string): string {
  return `#${String(counter).padStart(4, '0')}/${label}`;
}

/**
 * Write a prompt or response to prompts.log (the companion file to output.log).
 *
 * WHY a separate file: Prompts can be 5-50K chars each. Inlining them in
 * output.log would make it unsearchable (a single run can produce 500K+ of
 * prompt data vs ~20K of console output). prompts.log keeps the full content
 * available for analysis without drowning the operational log.
 *
 * WHY the slug format (#0001/llm-anthropic): The same slug appears as a
 * one-liner in output.log. When you see a suspicious LLM response in
 * output.log, Cmd+F the slug in prompts.log to jump directly to the full
 * prompt that produced it. This cross-file navigation pattern replaces the
 * need to correlate timestamps or count log entries manually.
 */
function writeToPromptLog(
  slug: string, kind: 'PROMPT' | 'RESPONSE' | 'ERROR', label: string,
  body: string, metadata?: Record<string, unknown>,
): void {
  if (!promptLogStream) return;
  // Normalize: accept only string; coerce undefined/null and treat whitespace-only like empty (pill #5).
  const content = typeof body === 'string' ? body : (body != null ? String(body) : '');
  const isEmpty = content.length === 0 || (kind !== 'ERROR' && content.trim().length === 0);
  // WHY warn on empty: Pill/audit cycles need content between markers; empty entries indicate a logging bug
  // (e.g. elizacloud/LLM client not passing accumulated body after stream, or caller passed marker-only). See AGENTS.md prompts.log.
  if (isEmpty && kind !== 'ERROR') {
    // No RESPONSE will follow — drop pairing slot (debugPrompt already registered slug).
    if (kind === 'PROMPT') promptRequestIdBySlug.delete(slug);
    // Pill #8: Increment counter for summary at close
    emptyPromptBodyCount++;
    const phaseFromMeta =
      metadata && typeof metadata === 'object' && metadata !== null && 'phase' in metadata
        ? String((metadata as { phase?: unknown }).phase ?? '').trim()
        : '';
    const phaseHint = phaseFromMeta ? ` phase=${JSON.stringify(phaseFromMeta)}` : '';
    // Include stack trace to identify the caller (pill #5, #6)
    const stack = new Error().stack;
    const stackSnippet = stack
      ? stack
          .split('\n')
          .slice(2, 6) // Skip Error() and writeToPromptLog lines, show next 4 frames
          .map((line) => line.trim())
          .join('\n    ')
      : '(stack unavailable)';
    const msg = `[logger] prompts.log: ${kind} ${slug}${phaseHint} has zero content — refusing to write empty entry; pill/audit need content. Check initOutputLog was called and prompt/response body is passed (e.g. after streaming, pass accumulated content).\n    Caller stack:\n    ${stackSnippet}\n`;
    try {
      if (typeof process !== 'undefined' && process.stderr?.write) {
        process.stderr.write(msg);
      }
      const w = (typeof console !== 'undefined' && console.warn) ? console.warn : () => {};
      w(msg.trim());
    } catch {
      // avoid throwing from logger
    }
    // Pill / audit: record in prompts.log so CI and pill see empty-body events (not only stderr).
    // Pill / audit: standard ERROR block in prompts.log (not only stderr / one-line marker) so greps match.
    const emptyMeta: Record<string, unknown> = {
      ...(metadata && typeof metadata === 'object' && metadata !== null ? { ...metadata } : {}),
      emptyBody: true,
      originalKind: kind,
    };
    writeToPromptLog(
      slug,
      'ERROR',
      label,
      `[empty-body] ${kind} refused: zero or whitespace-only content (see AGENTS.md prompts.log troubleshooting).`,
      emptyMeta,
    );
    return;
  }
  const bodyToWrite = content;
  try {
    // WHY cork/uncork: Flush this entry as a unit so on crash we don't get a truncated entry
    // that breaks the parser (prompts.log audit). See AGENTS.md "Crash / truncation".
    if (promptLogStream.cork) promptLogStream.cork();
    const sep = '═'.repeat(70);
    const sizeNote = `${bodyToWrite.length} chars`;
    let header = `${sep}\n ${slug}  ${kind}: ${label} (${sizeNote})\n`;
    header += ` ${new Date().toISOString()}\n`;
    if (metadata) header += ` ${safeStringify(metadata, true)}\n`;
    // Pill fix: Don't write delimiter between metadata and content — parser splits by delimiter
    // and treats content as separate entry. Write delimiter only at start and end.
    promptLogStream.write(header);
    promptLogStream.write(bodyToWrite);
    promptLogStream.write(`\n${sep}\n\n`);
    if (promptLogStream.uncork) promptLogStream.uncork();
  } catch (err) {
    console.error('Prompt log stream write failed:', err);
    if (promptLogStream?.uncork) promptLogStream.uncork();
  }
}

/**
 * Log a prompt to the prompts.log companion file and (optionally) a standalone
 * debug file. A one-liner with a searchable slug is written to output.log so
 * you can grep the slug in prompts.log to see the full content.
 *
 * WHY dual logging (standalone files + prompts.log): Standalone files are
 * useful for sharing individual prompts or diffing prompt evolution across
 * iterations. prompts.log provides chronological search across ALL prompts
 * and responses in a single file — critical for diagnosing "the LLM got
 * confused at step 5" type issues where you need to see the conversation flow.
 *
 * prompts.log is written whenever initOutputLog was used (e.g. split-plan-prompts.log).
 * Standalone files and output.log one-liner only when PRR_DEBUG_PROMPTS + verbose (debugLogDir set).
 *
 * Each PROMPT entry gets a UUID `requestId` in metadata; the matching RESPONSE/ERROR repeats it
 * so you can correlate when entries are interleaved (parallel dedup, etc.) — same slug still pairs by number.
 */
/** Returns the slug so the caller can pass it to debugResponse/debugPromptError for the same request (safe when requests are in flight). */
export function debugPrompt(label: string, prompt: string, metadata?: Record<string, unknown>): string {
  debugLogCounter++;
  const slug = promptSlug(debugLogCounter, label);
  const requestId = randomUUID();
  promptRequestIdBySlug.set(slug, requestId);
  const mergedMeta = { ...metadata, requestId };

  // Full content in prompts.log (always when stream exists, so split-plan etc. get a non-empty log)
  writeToPromptLog(slug, 'PROMPT', label, prompt, mergedMeta);

  if (!debugLogDir) return slug;

  // Standalone file (still useful for sharing/diffing individual prompts)
  const filename = `${String(debugLogCounter).padStart(4, '0')}-${label.replace(/[^a-z0-9]/gi, '-')}-prompt.txt`;
  const filepath = join(debugLogDir, filename);
  let content = `=== ${label} ===\n`;
  content += `Timestamp: ${new Date().toISOString()}\n`;
  content += `Metadata: ${safeStringify(mergedMeta, true)}\n`;
  content += `Length: ${prompt.length} chars\n`;
  content += `${'='.repeat(50)}\n\n`;
  content += prompt;
  writeFileSync(filepath, content, 'utf-8');

  // Searchable one-liner in output.log
  debug(`PROMPT ${slug}`, { chars: prompt.length, requestId });
  return slug;
}

/** Extract numeric part from slug (e.g. "#0001/llm-api" → "0001") for standalone filenames. */
function slugNumber(slug: string): string {
  const m = /^#(\d+)\//.exec(slug);
  return m ? m[1] : String(debugLogCounter).padStart(4, '0');
}

/**
 * Log a response to the prompts.log companion file and (optionally) a standalone
 * debug file. Caller must pass the slug returned from debugPrompt for this request
 * so prompt and response are paired even when multiple requests are in flight.
 */
export function debugResponse(
  slug: string,
  label: string,
  response: string,
  metadata?: Record<string, unknown>
): void {
  const requestId = promptRequestIdBySlug.get(slug);
  const mergedMeta = requestId ? { ...metadata, requestId } : metadata;
  if (requestId) promptRequestIdBySlug.delete(slug);

  // Full content in prompts.log (always when stream exists)
  writeToPromptLog(slug, 'RESPONSE', label, response, mergedMeta);

  if (!debugLogDir) return;

  // Standalone file
  const num = slugNumber(slug);
  const filename = `${num}-${label.replace(/[^a-z0-9]/gi, '-')}-response.txt`;
  const filepath = join(debugLogDir, filename);
  let content = `=== ${label} ===\n`;
  content += `Timestamp: ${new Date().toISOString()}\n`;
  content += `Metadata: ${safeStringify(mergedMeta ?? {}, true)}\n`;
  content += `Length: ${response.length} chars\n`;
  content += `${'='.repeat(50)}\n\n`;
  content += response;
  writeFileSync(filepath, content, 'utf-8');

  // Searchable one-liner in output.log
  debug(`RESPONSE ${slug}`, { chars: response.length, ...(requestId ? { requestId } : {}) });
}

/**
 * Log a failed LLM request to prompts.log (ERROR entry) so audits can see
 * 504/timeout etc. Caller must pass the slug returned from debugPrompt for this request.
 */
export function debugPromptError(
  slug: string,
  label: string,
  errorMessage: string,
  metadata?: Record<string, unknown>,
): void {
  if (!promptLogStream) return;
  const requestId = promptRequestIdBySlug.get(slug);
  const mergedMeta = requestId ? { ...metadata, requestId } : metadata;
  if (requestId) promptRequestIdBySlug.delete(slug);
  writeToPromptLog(slug, 'ERROR', label, errorMessage, mergedMeta);
  if (debugLogDir) {
    debug(`ERROR ${slug}`, {
      error: errorMessage.slice(0, 80),
      ...(requestId ? { requestId } : {}),
    });
  }
}

/**
 * Get the current debug log directory (for informational purposes)
 */
export function getDebugLogDir(): string | null {
  return debugLogDir;
}

export {
  endTimer,
  formatDuration,
  getOverallTimings,
  getTimingSummary,
  loadOverallTimings,
  printTimingSummary,
  resetAllTimings,
  resetTimings,
  startTimer,
} from './timing.js';

export type { TokenUsage } from './token-tracking.js';
export {
  getOverallTokenUsage,
  getTokenUsage,
  loadOverallTokenUsage,
  printTokenSummary,
  resetAllTokenUsage,
  resetTokenUsage,
  setTokenPhase,
  trackTokens,
} from './token-tracking.js';

/**
 * Format a number with locale-aware separators (e.g., 1,234,567).
 * Use this for all user-facing number output.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Return singular when n === 1, otherwise plural (e.g. "1 file" / "2 files"). */
export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural;
}
