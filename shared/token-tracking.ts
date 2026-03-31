/**
 * LLM token usage by phase (extracted from logger for structure).
 */
import chalk from 'chalk';

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

  if (hasOverall) {
    const overallTotals = { totalInput: 0, totalOutput: 0, totalCalls: 0 };
    for (const { inputTokens, outputTokens, calls } of overallTokenUsage) {
      overallTotals.totalInput += inputTokens;
      overallTotals.totalOutput += outputTokens;
      overallTotals.totalCalls += calls;
    }

    if (overallTotals.totalCalls > sessionTotals.totalCalls) {
      console.log('');
      printTokenSection('Overall (all sessions)', overallTokenUsage, false);

      const inputCost = (overallTotals.totalInput / 1000000) * 3;
      const outputCost = (overallTotals.totalOutput / 1000000) * 15;
      const totalCost = inputCost + outputCost;
      if (totalCost > 0.001) {
        console.log(chalk.gray(`     Estimated total cost: ~$${totalCost.toFixed(3)}`));
      }
    } else {
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
}

export function resetAllTokenUsage(): void {
  sessionTokenUsage.length = 0;
  overallTokenUsage = [];
  currentPhase = 'unknown';
}
