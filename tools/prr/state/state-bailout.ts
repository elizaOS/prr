/**
 * No-progress cycle tracking and bail-out mechanism
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { BailOutRecord } from './types.js';

export function getNoProgressCycles(ctx: StateContext): number {
  return ctx.state?.noProgressCycles ?? 0;
}

export function incrementNoProgressCycles(ctx: StateContext): number {
  const state = getState(ctx);
  if (!state.noProgressCycles) {
    state.noProgressCycles = 0;
  }
  state.noProgressCycles++;
  return state.noProgressCycles;
}

export function resetNoProgressCycles(ctx: StateContext): void {
  if (ctx.state) {
    ctx.state.noProgressCycles = 0;
  }
}

export function recordBailOut(
  ctx: StateContext,
  reason: BailOutRecord['reason'],
  cyclesCompleted: number,
  remainingIssues: BailOutRecord['remainingIssues'],
  issuesFixed: number,
  toolsExhausted: string[]
): void {
  const state = getState(ctx);
  
  state.bailOutRecord = {
    timestamp: new Date().toISOString(),
    reason,
    cyclesCompleted,
    remainingIssues,
    partialProgress: {
      issuesFixed,
      issuesRemaining: remainingIssues.length,
      lessonsLearned: state.lessonsLearned.length,
    },
    toolsExhausted,
  };
}

export function getBailOutRecord(ctx: StateContext): BailOutRecord | undefined {
  return ctx.state?.bailOutRecord;
}

export function clearBailOutRecord(ctx: StateContext): void {
  if (ctx.state) {
    ctx.state.bailOutRecord = undefined;
  }
}
