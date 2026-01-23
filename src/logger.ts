import chalk from 'chalk';

let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

// Safe stringify that handles BigInt, circular refs, and custom toJSON errors
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
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
    // Use Math.floor to prevent rounding to 60 seconds
    const secs = Math.floor((ms % 60000) / 1000);
    // Pad seconds with leading zero for consistency (e.g., "1m 05s")
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
    let overallTotals = { totalInput: 0, totalOutput: 0, totalCalls: 0 };
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
