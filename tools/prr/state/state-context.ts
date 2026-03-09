/**
 * State context - replaces StateManager instance properties
 */
import { join } from 'path';
import chalk from 'chalk';
import type { ResolverState } from './types.js';
import type { TokenUsage } from '../../../shared/runners/types.js';

/** Aggregated token usage across runner runs this session. */
export interface AggregatedTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

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
  /** Token usage aggregated from runner runs (e.g. Codex --json turn.completed). */
  tokenUsage?: AggregatedTokenUsage;
  /** When set, next fix prompt should use a smaller batch (e.g. after large-prompt failure before rotate). Cleared when consumed.
   *  WHY: Prompts >200k chars cause gateway 500s/timeouts. Forcing a smaller batch on the next iteration avoids re-sending the same oversized prompt and burning rotation slots. */
  forceNextBatchSizeReduce?: boolean;
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

/** Add a run's token usage to the session aggregate. */
export function addTokenUsage(ctx: StateContext, usage: TokenUsage): void {
  if (!ctx.tokenUsage) {
    ctx.tokenUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  }
  ctx.tokenUsage.input_tokens += usage.input_tokens ?? 0;
  ctx.tokenUsage.cached_input_tokens += usage.cached_input_tokens ?? 0;
  ctx.tokenUsage.output_tokens += usage.output_tokens ?? 0;
}

/** Log aggregated token usage for this session (if any). */
export function logTokenUsage(ctx: StateContext): void {
  const u = ctx.tokenUsage;
  if (!u || (u.input_tokens === 0 && u.cached_input_tokens === 0 && u.output_tokens === 0)) return;
  const total = u.input_tokens + u.cached_input_tokens + u.output_tokens;
  console.log(
    chalk.gray(
      `  Token usage (this session): input ${u.input_tokens.toLocaleString()}${u.cached_input_tokens ? `, cached ${u.cached_input_tokens.toLocaleString()}` : ''}, output ${u.output_tokens.toLocaleString()} (total ${total.toLocaleString()})`
    )
  );
}
