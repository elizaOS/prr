/**
 * Tool/model rotation state persistence
 */
import type { StateContext } from './state-context.js';

export function setCurrentRunnerIndex(ctx: StateContext, index: number): void {
  if (!ctx.state) return;
  ctx.state.currentRunnerIndex = index;
}

export function getCurrentRunnerIndex(ctx: StateContext): number {
  return ctx.state?.currentRunnerIndex ?? 0;
}

export function setModelIndex(ctx: StateContext, runnerName: string, index: number): void {
  if (!ctx.state) return;
  if (!ctx.state.modelIndices) {
    ctx.state.modelIndices = {};
  }
  ctx.state.modelIndices[runnerName] = index;
}

export function getModelIndex(ctx: StateContext, runnerName: string): number {
  return ctx.state?.modelIndices?.[runnerName] ?? 0;
}

export function getModelIndices(ctx: StateContext): Record<string, number> {
  return ctx.state?.modelIndices ?? {};
}

export function setModelIndices(ctx: StateContext, indices: Record<string, number>): void {
  if (!ctx.state) return;
  ctx.state.modelIndices = indices;
}
