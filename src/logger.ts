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
import { writeFileSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { format } from 'node:util';
import { finished } from 'stream/promises';
import type { WriteStream } from 'fs';

let verboseEnabled = false;
let debugLogDir: string | null = null;
let debugLogCounter = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OUTPUT LOG TEE — mirrors all console output to ./output.log in the CWD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let outputLogStream: WriteStream | null = null;
let outputLogPath: string | null = null;
let promptLogStream: WriteStream | null = null;

/**
 * Strip ANSI escape codes from a string for plain-text logging.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:\[[\x20-\x3F]*[\x40-\x7E]|\].*?(?:\x07|\x1B\\)|\(B)/g, '');
}

/**
 * Initialize the output log tee.
 *
 * Creates/truncates ./output.log in the CWD and patches console.log/warn/error
 * to mirror all formatted output (ANSI-stripped) to the file.
 *
 * Spinner output (ora etc.) goes through process.stdout.write — NOT console.log —
 * and is intentionally excluded.  It's pure UI noise with no analytical value.
 *
 * Call this once at startup, before any meaningful output.
 */
export function initOutputLog(): void {
  // Write to ~/.prr/ directory as documented in README
  const prrDir = join(homedir(), '.prr');
  mkdirSync(prrDir, { recursive: true });

  outputLogPath = join(prrDir, 'output.log');

  writeFileSync(outputLogPath, '', 'utf-8');
  outputLogStream = createWriteStream(outputLogPath, { flags: 'a', encoding: 'utf-8' });

  // Companion log for full prompts & responses — search by slug (e.g. "#0009")
  // to jump from output.log to the exact prompt/response in prompts.log.
  const promptLogPath = join(prrDir, 'prompts.log');
  writeFileSync(promptLogPath, '', 'utf-8');
  promptLogStream = createWriteStream(promptLogPath, { flags: 'a', encoding: 'utf-8' });

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

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
      console.error('Log stream close/flush failed:', err);
    }
  }
}

/**
 * Get the path to the current output log file.
 */
export function getOutputLogPath(): string | null {
  return outputLogPath;
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
  slug: string, kind: 'PROMPT' | 'RESPONSE', label: string,
  body: string, metadata?: Record<string, unknown>,
): void {
  if (!promptLogStream) return;
  try {
    const sep = '═'.repeat(70);
    let header = `${sep}\n ${slug}  ${kind}: ${label} (${body.length} chars)\n`;
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
 * Only active when PRR_DEBUG_PROMPTS=1 and verbose mode is enabled.
 * Standalone files are written to ~/.prr/debug/<timestamp>/
 */
export function debugPrompt(label: string, prompt: string, metadata?: Record<string, unknown>): void {
  if (!debugLogDir) return;
  
  debugLogCounter++;
  const slug = promptSlug(debugLogCounter, label);

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

  // Full content in prompts.log
  writeToPromptLog(slug, 'PROMPT', label, prompt, metadata);
}

/**
 * Log a response to the prompts.log companion file and (optionally) a standalone
 * debug file. A one-liner with a searchable slug is written to output.log.
 *
 * Only active when PRR_DEBUG_PROMPTS=1 and verbose mode is enabled.
 */
export function debugResponse(label: string, response: string, metadata?: Record<string, unknown>): void {
  if (!debugLogDir) return;
  
  debugLogCounter++;
  const slug = promptSlug(debugLogCounter, label);

  // Standalone file
  const filename = `${String(debugLogCounter).padStart(4, '0')}-${label.replace(/[^a-z0-9]/gi, '-')}-response.txt`;
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

  // Full content in prompts.log
  writeToPromptLog(slug, 'RESPONSE', label, response, metadata);
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
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
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
  
  // Session timings
  if (hasSession) {
    console.log(chalk.gray('   This session:'));
    let sessionTotal = 0;
    for (const { name, duration } of sessionTimings) {
      sessionTotal += duration;
      console.log(chalk.gray(`     ${name.padEnd(28)} ${formatDuration(duration).padStart(8)}`));
    }
    console.log(chalk.gray(`     ${'─'.repeat(37)}`));
    console.log(chalk.gray(`     ${'Session total'.padEnd(28)} ${formatDuration(sessionTotal).padStart(8)}`));
  }
  
  // Overall timings (if resumed and have history)
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
        console.log(chalk.gray(`     ${name.padEnd(28)} ${formatDuration(duration).padStart(8)}`));
      }
      console.log(chalk.cyan(`     ${'─'.repeat(37)}`));
      console.log(chalk.cyan(`     ${'Overall total'.padEnd(28)} ${formatDuration(overallTotal).padStart(8)}`));
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
