/**
 * State context - replaces StateManager instance properties
 */
import { join } from 'path';
import type { ResolverState } from './types.js';

export interface StateContext {
  statePath: string;
  state: ResolverState | null;
  currentPhase: string;
}

export function createStateContext(workdir: string): StateContext {
  return {
    statePath: join(workdir, '.pr-resolver-state.json'),
    state: null,
    currentPhase: 'init',
  };
}

export function getState(ctx: StateContext): ResolverState {
  if (!ctx.state) {
    throw new Error('State not loaded. Call load() first.');
  }
  return ctx.state;
}

export function setPhase(ctx: StateContext, phase: string): void {
  ctx.currentPhase = phase;
}
