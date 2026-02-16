/**
 * State context - replaces StateManager instance properties
 */
import { join } from 'path';
import type { ResolverState } from './types.js';

export interface StateContext {
  statePath: string;
  state: ResolverState | null;
  currentPhase: string;
  /** Number of verified-fixed IDs when the session started (after dedup + git recovery).
   *  Used to compute "fixed this session" = current count - this baseline. */
  verifiedFixedAtSessionStart?: number;
}

export function createStateContext(workdir: string): StateContext {
  if (!workdir) {
    throw new Error('Cannot create state context: workdir is required');
  }
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
