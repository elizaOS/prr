/**
 * Session and overall phase timing (extracted from logger for structure).
 */
import chalk from 'chalk';

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

  const overallEntries = Object.entries(overallTimings);
  if (overallEntries.length > 0) {
    let overallTotal = 0;
    for (const [, duration] of overallEntries) {
      overallTotal += duration;
    }

    const sessionTotal = sessionTimings.reduce((sum, t) => sum + t.duration, 0);
    if (Math.abs(overallTotal - sessionTotal) > 1000) {
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
}

export function resetAllTimings(): void {
  timers.clear();
  sessionTimings.length = 0;
  overallTimings = {};
}
