/**
 * State context - replaces StateManager instance properties
 */
import { join } from 'path';
import type { ResolverState } from './types.js';

export interface StateContext {
  statePath: string;
  state: ResolverState | null;
  currentPhase: string;
  /** IDs of comments actually verified during THIS session's fix loop iterations.
   *  Unlike the delta approach (verifiedNow - baseline), this correctly counts
   *  re-verifications of issues that were already in verifiedFixed from previous sessions. */
  verifiedThisSession?: Set<string>;
  /** IDs of all review comments in the current PR.
   *  Used to bound verifiedFixed against the actual comment set — stale IDs from
   *  previous HEAD revisions or deleted comments are excluded from reporting. */
  currentCommentIds?: Set<string>;
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
