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

/** When true, closeOutputLog() runs pill analysis on the logs we just closed. Set at init or via setPillEnabled() when --pill is passed. */
let pillAnalysisEnabled = false;

/** Enable or disable pill analysis on close. Call after parse when user passes --pill. WHY opt-in: default runs stay fast; tools like split-exec have no LLM calls so pill would often have nothing to analyze unless the user explicitly requests it. */
export function setPillEnabled(enabled: boolean): void {
  pillAnalysisEnabled = enabled;
}
/** Log prefix from initOutputLog (e.g. 'story') so pill knows which log files to read. */
let currentLogPrefix: string | undefined;
/** Original console methods, captured before patching, for pill hook to print to real console. */
let origLogRef: ((...args: unknown[]) => void) | null = null;
let origWarnRef: ((...args: unknown[]) => void) | null = null;
let origErrorRef: ((...args: unknown[]) => void) | null = null;

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
  /** When true, closeOutputLog() runs pill analysis and prints pitch + file paths. */
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
 * When enablePill was set, runs pill analysis on the closed logs and prints pitch + file paths to the real console.
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

  // WHY run when output has content OR prompts have entries: split-exec has no prompts log; prr/story do. So we
  // run pill when either the output log has content (operational improvements) or the prompts log has PROMPT/RESPONSE/ERROR.
  const outputLogHasContent =
    outputLogPath && existsSync(outputLogPath) && readFileSync(outputLogPath, 'utf-8').trim().length > 0;
  const hasPromptsToAnalyze =
    promptLogPath &&
    existsSync(promptLogPath) &&
    / (PROMPT|RESPONSE|ERROR): /m.test(readFileSync(promptLogPath, 'utf-8'));

  if (pillAnalysisEnabled && outputLogPath && (outputLogHasContent || hasPromptsToAnalyze)) {
    // WHY reset first: so we run at most once even if runPillAnalysis or a later step throws.
    pillAnalysisEnabled = false;
    try {
      // WHY dynamic import: avoids circular dependency (orchestrator must not import from logger).
      const { dirname } = await import('path');
      const { runPillAnalysis } = await import('../tools/pill/orchestrator.js');
      const { tryLoadPillConfig } = await import('../tools/pill/config.js');
      const targetDir = dirname(outputLogPath);
      const config = tryLoadPillConfig({ targetDir, logPrefix: currentLogPrefix });
      if (config) {
        appendFileSync(outputLogPath, '\n[Pill] Running analysis on closed logs…\n', 'utf-8');
        const out = await runPillAnalysis(config);
        if (out.result) {
          appendFileSync(outputLogPath, `[Pill] Done. Instructions: ${out.result.instructionsPath}\n`, 'utf-8');
          if (origLogRef) {
            origLogRef('\n' + out.result.pitch);
            origLogRef(`\n  Instructions: ${out.result.instructionsPath}`);
            origLogRef(`  Summary log:  ${out.result.summaryPath}`);
          }
        } else {
          const reasonLine =
            out.reason === 'api_call_failed' && (out as { errorMessage?: string }).errorMessage
              ? `[Pill] No improvements to record (reason: ${out.reason}: ${(out as { errorMessage?: string }).errorMessage}).\n`
              : `[Pill] No improvements to record (reason: ${out.reason}).\n`;
          appendFileSync(outputLogPath, reasonLine, 'utf-8');
          // WHY distinct console message: Operators need to know why pill recorded nothing (pill-output.md #3, #7).
          const consoleMsg =
            out.reason === 'no_logs'
              ? 'Pill: No logs to analyze (output/prompts log empty or missing for this prefix).'
              : out.reason === 'no_api_key'
                ? 'Pill: No improvements to record (no API key configured). Set API key in .env.'
                : out.reason === 'zero_improvements_from_llm'
                  ? 'Pill: LLM returned zero improvements (audit ran successfully).'
                  : out.reason === 'api_call_failed' && (out as { errorMessage?: string }).errorMessage
                    ? `Pill: Audit failed: ${(out as { errorMessage?: string }).errorMessage}`
                    : `Pill: No improvements to record (reason: ${out.reason}).`;
          if (origLogRef) origLogRef('\n[Pill] ' + consoleMsg);
        }
      } else {
        appendFileSync(outputLogPath, '[Pill] Skipped (no API key or no config in target dir).\n', 'utf-8');
        if (origLogRef) origLogRef('\n[Pill] Skipped (no API key or no config in target dir).');
      }
    } catch (err) {
      // Log to real console so operators see pill failures (pill-output.md #6); still complete shutdown.
      if (origErrorRef) origErrorRef('[Pill] Error:', err);
      try {
        if (outputLogPath) {
          const msg = err instanceof Error ? err.message : String(err);
          appendFileSync(outputLogPath, `[Pill] Error: ${msg}\n`, 'utf-8');
        }
      } catch { /* ignore */ }
    }
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
  // WHY warn on empty: Pill/audit cycles need content between markers; empty entries indicate a logging bug
  // (e.g. subprocess runner not writing to same stream, or caller passed marker-only). See AGENTS.md prompts.log.
  if (body.length === 0 && kind !== 'ERROR') {
    try {
      const w = (typeof console !== 'undefined' && console.warn) ? console.warn : () => {};
      w('[logger] prompts.log: ' + kind + ' ' + slug + ' has zero content — refusing to write empty entry; pill/audit need content. Check initOutputLog was called and prompt/response body is passed.');
    } catch {
      // avoid throwing from logger
    }
    return;
  }
  try {
    const sep = '═'.repeat(70);
    const sizeNote = `${body.length} chars`;
    let header = `${sep}\n ${slug}  ${kind}: ${label} (${sizeNote})\n`;
    header += ` ${new Date().toISOString()}\n`;
    if (metadata) header += ` ${safeStringify(metadata, true)}\n`;
    header += `${sep}\n`;
    promptLogStream.write(header);
    promptLogStream.write(body);
    promptLogStream.write(`\n${sep}\n\n`);
  } catch (err) {
    console.error('Prompt log stream write failed:', err);
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
 */
/** Returns the slug so the caller can pass it to debugResponse/debugPromptError for the same request (safe when requests are in flight). */
export function debugPrompt(label: string, prompt: string, metadata?: Record<string, unknown>): string {
  debugLogCounter++;
  const slug = promptSlug(debugLogCounter, label);

  // Full content in prompts.log (always when stream exists, so split-plan etc. get a non-empty log)
  writeToPromptLog(slug, 'PROMPT', label, prompt, metadata);

  if (!debugLogDir) return slug;

  // Standalone file (still useful for sharing/diffing individual prompts)
  const filename = `${String(debugLogCounter).padStart(4, '0')}-${label.replace(/[^a-z0-9]/gi, '-')}-prompt.txt`;
  const filepath = join(debugLogDir, filename);
  let content = `=== ${label} ===\n`;
  content += `Timestamp: ${new Date().toISOString()}\n`;
  if (metadata) {
    content += `Metadata: ${safeStringify(metadata, true)}\n`;
  }
  content += `Length: ${prompt.length} chars\n`;
  content += `${'='.repeat(50)}\n\n`;
  content += prompt;
  writeFileSync(filepath, content, 'utf-8');

  // Searchable one-liner in output.log
  debug(`PROMPT ${slug}`, { chars: prompt.length });
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
  // Full content in prompts.log (always when stream exists)
  writeToPromptLog(slug, 'RESPONSE', label, response, metadata);

  if (!debugLogDir) return;

  // Standalone file
  const num = slugNumber(slug);
  const filename = `${num}-${label.replace(/[^a-z0-9]/gi, '-')}-response.txt`;
  const filepath = join(debugLogDir, filename);
  let content = `=== ${label} ===\n`;
  content += `Timestamp: ${new Date().toISOString()}\n`;
  if (metadata) {
    content += `Metadata: ${safeStringify(metadata, true)}\n`;
  }
  content += `Length: ${response.length} chars\n`;
  content += `${'='.repeat(50)}\n\n`;
  content += response;
  writeFileSync(filepath, content, 'utf-8');

  // Searchable one-liner in output.log
  debug(`RESPONSE ${slug}`, { chars: response.length });
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
  writeToPromptLog(slug, 'ERROR', label, errorMessage, metadata);
  if (debugLogDir) {
    debug(`ERROR ${slug}`, { error: errorMessage.slice(0, 80) });
  }
}

/**
 * Get the current debug log directory (for informational purposes)
 */
export function getDebugLogDir(): string | null {
  return debugLogDir;
}

// Timing utilities - session and overall tracking
const timers = new Map<string, number>();
const sessionTimings: Array<{ name: string; duration: number }> = [];
let overallTimings: Record<string, number> = {};

export function startTimer(name: string): void {
  timers.set(name, Date.now());
}

export function endTimer(name: string): number {
  const start = timers.get(name);
  if (!start) {
    return 0;
  }
  const duration = Date.now() - start;
  timers.delete(name);
  sessionTimings.push({ name, duration });
  // Aggregate to overall
  overallTimings[name] = (overallTimings[name] || 0) + duration;
  return duration;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    const secsStr = secs.toString().padStart(2, '0');
    return `${mins}m ${secsStr}s`;
  }
}

export function getTimingSummary(): Array<{ name: string; duration: number; formatted: string }> {
  return sessionTimings.map(t => ({
    ...t,
    formatted: formatDuration(t.duration),
  }));
}

export function loadOverallTimings(timings: Record<string, number>): void {
  overallTimings = { ...timings };
}

export function getOverallTimings(): Record<string, number> {
  return { ...overallTimings };
}

export function printTimingSummary(): void {
  const hasSession = sessionTimings.length > 0;
  const hasOverall = Object.keys(overallTimings).length > 0;

  if (!hasSession && !hasOverall) return;

  console.log(chalk.cyan('\n⏱  Timing Summary:'));

  // Session timings — aggregate repeated phase names (e.g. "Run fixer" 11×) for scannability
  if (hasSession) {
    console.log(chalk.gray('   This session:'));
    const byName = new Map<string, number[]>();
    for (const { name, duration } of sessionTimings) {
      const list = byName.get(name) ?? [];
      list.push(duration);
      byName.set(name, list);
    }
    let sessionTotal = 0;
    for (const [name, durations] of byName) {
      const total = durations.reduce((a, b) => a + b, 0);
      sessionTotal += total;
      const label = durations.length > 1 ? `${name} (${durations.length}×)` : name;
      console.log(chalk.gray(`     ${label.padEnd(32)} ${formatDuration(total).padStart(8)}`));
    }
    console.log(chalk.gray(`     ${'─'.repeat(41)}`));
    console.log(chalk.gray(`     ${'Session total'.padEnd(32)} ${formatDuration(sessionTotal).padStart(8)}`));
  }

  // Overall timings (if resumed and have history) — already aggregated by name
  const overallEntries = Object.entries(overallTimings);
  if (overallEntries.length > 0) {
    let overallTotal = 0;
    for (const [, duration] of overallEntries) {
      overallTotal += duration;
    }

    // Only show overall breakdown if different from session
    const sessionTotal = sessionTimings.reduce((sum, t) => sum + t.duration, 0);
    if (Math.abs(overallTotal - sessionTotal) > 1000) { // >1s difference means resumed
      console.log(chalk.cyan('   Overall (all sessions):'));
      for (const [name, duration] of overallEntries) {
        if (name === 'Total') continue;
        console.log(chalk.gray(`     ${name.padEnd(32)} ${formatDuration(duration).padStart(8)}`));
      }
      console.log(chalk.cyan(`     ${'─'.repeat(41)}`));
      console.log(chalk.cyan(`     ${'Overall total'.padEnd(32)} ${formatDuration(overallTotal).padStart(8)}`));
    }
  }
}

export function resetTimings(): void {
  timers.clear();
  sessionTimings.length = 0;
  // Note: overall timings are NOT reset, they accumulate across sessions
}

export function resetAllTimings(): void {
  timers.clear();
  sessionTimings.length = 0;
  overallTimings = {};
}

// Token usage tracking - session and overall
export interface TokenUsage {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const sessionTokenUsage: TokenUsage[] = [];
let overallTokenUsage: TokenUsage[] = [];
let currentPhase = 'unknown';

export function setTokenPhase(phase: string): void {
  currentPhase = phase;
}

export function trackTokens(inputTokens: number, outputTokens: number): void {
  // Track in session
  const existingSession = sessionTokenUsage.find(t => t.phase === currentPhase);
  if (existingSession) {
    existingSession.inputTokens += inputTokens;
    existingSession.outputTokens += outputTokens;
    existingSession.calls += 1;
  } else {
    sessionTokenUsage.push({
      phase: currentPhase,
      inputTokens,
      outputTokens,
      calls: 1,
    });
  }

  // Track in overall
  const existingOverall = overallTokenUsage.find(t => t.phase === currentPhase);
  if (existingOverall) {
    existingOverall.inputTokens += inputTokens;
    existingOverall.outputTokens += outputTokens;
    existingOverall.calls += 1;
  } else {
    overallTokenUsage.push({
      phase: currentPhase,
      inputTokens,
      outputTokens,
      calls: 1,
    });
  }
}

export function getTokenUsage(): TokenUsage[] {
  return [...sessionTokenUsage];
}

export function loadOverallTokenUsage(usage: TokenUsage[]): void {
  overallTokenUsage = usage.map(u => ({ ...u }));
}

export function getOverallTokenUsage(): TokenUsage[] {
  return overallTokenUsage.map(u => ({ ...u }));
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  } else if (tokens < 1000000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  } else {
    return `${(tokens / 1000000).toFixed(2)}M`;
  }
}

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

function printTokenSection(label: string, usage: TokenUsage[], isSession: boolean): { totalInput: number; totalOutput: number; totalCalls: number } {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCalls = 0;

  console.log(chalk.gray(`   ${label}:`));

  for (const { phase, inputTokens, outputTokens, calls } of usage) {
    totalInput += inputTokens;
    totalOutput += outputTokens;
    totalCalls += calls;
    console.log(chalk.gray(
      `     ${phase.padEnd(23)} ${formatTokenCount(inputTokens).padStart(8)} in / ${formatTokenCount(outputTokens).padStart(8)} out  (${calls} call${calls > 1 ? 's' : ''})`
    ));
  }

  const lineChar = isSession ? '─' : '─';
  const color = isSession ? chalk.gray : chalk.cyan;
  console.log(color(`     ${lineChar.repeat(58)}`));
  console.log(color(
    `     ${'Subtotal'.padEnd(23)} ${formatTokenCount(totalInput).padStart(8)} in / ${formatTokenCount(totalOutput).padStart(8)} out  (${totalCalls} calls)`
  ));

  return { totalInput, totalOutput, totalCalls };
}

export function printTokenSummary(): void {
  const hasSession = sessionTokenUsage.length > 0;
  const hasOverall = overallTokenUsage.length > 0;

  if (!hasSession && !hasOverall) return;

  console.log(chalk.cyan('\n🔤 Token Usage:'));

  let sessionTotals = { totalInput: 0, totalOutput: 0, totalCalls: 0 };

  if (hasSession) {
    sessionTotals = printTokenSection('This session', sessionTokenUsage, true);
  }

  // Only show overall if different from session (i.e., resumed)
  if (hasOverall) {
    const overallTotals = { totalInput: 0, totalOutput: 0, totalCalls: 0 };
    for (const { inputTokens, outputTokens, calls } of overallTokenUsage) {
      overallTotals.totalInput += inputTokens;
      overallTotals.totalOutput += outputTokens;
      overallTotals.totalCalls += calls;
    }

    // Show overall breakdown if different from session
    if (overallTotals.totalCalls > sessionTotals.totalCalls) {
      console.log('');
      printTokenSection('Overall (all sessions)', overallTokenUsage, false);

      // Cost estimate for overall
      const inputCost = (overallTotals.totalInput / 1000000) * 3;
      const outputCost = (overallTotals.totalOutput / 1000000) * 15;
      const totalCost = inputCost + outputCost;
      if (totalCost > 0.001) {
        console.log(chalk.gray(`     Estimated total cost: ~$${totalCost.toFixed(3)}`));
      }
    } else {
      // Just session, show cost for session
      const inputCost = (sessionTotals.totalInput / 1000000) * 3;
      const outputCost = (sessionTotals.totalOutput / 1000000) * 15;
      const totalCost = inputCost + outputCost;
      if (totalCost > 0.001) {
        console.log(chalk.gray(`     Estimated cost: ~$${totalCost.toFixed(3)}`));
      }
    }
  }
}

export function resetTokenUsage(): void {
  sessionTokenUsage.length = 0;
  currentPhase = 'unknown';
  // Note: overall token usage is NOT reset
}

export function resetAllTokenUsage(): void {
  sessionTokenUsage.length = 0;
  overallTokenUsage = [];
  currentPhase = 'unknown';
}
