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

/**
 * Session-level model skip after repeated failures. **Mostly persisted** in
 * `.pr-resolver-state.json` (`sessionSkippedModelKeys` / `sessionModelStats`) so restarts skip bad
 * models without re-burning budget — opt out with **`PRR_PERSIST_SESSION_MODEL_SKIP=0`**.
 */
export interface RotationSessionTracking {
  skippedModelKeys: Set<string>;
  modelStats: Map<string, { fixes: number; failures: number }>;
  /**
   * Fix iteration (1-based) when each key was added to `skippedModelKeys`.
   * WHY: Per-key retry — remove from skip after N iterations for that key only (vs clearing all skips).
   */
  sessionSkippedSinceFixIteration: Map<string, number>;
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
  /** Comments that were previously verified but final audit said UNFIXED — we re-queued them (safe over sorry). Used for AAR/visibility. */
  auditOverridesThisRun?: Array<{ commentId: string; path: string; line?: number | null; explanation?: string }>;
  /** Final audit passed but via UNCERTAIN or truncation guard — for strict exit / visibility (`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`). Ephemeral per run. */
  finalAuditUncertainThisRun?: Array<{
    commentId: string;
    path: string;
    line?: number | null;
    kind: 'uncertain' | 'truncation-guard';
    explanation?: string;
  }>;
  /** Set during git recovery; consumed when logging prune so operators see recovered vs pruned context. */
  gitRecoveredVerificationCount?: number;
  /** Ephemeral: skip tool/model for rest of run after threshold failures with no fixes (see PRR_SESSION_MODEL_SKIP_FAILURES). */
  rotationSession?: RotationSessionTracking;
  /** Ephemeral: consecutive iterations with zero new verified fixes (diminishing-returns warning). */
  diminishingReturnsZeroVerifyStreak?: number;
  /** Ephemeral: already logged one diminishing-returns warning this run. */
  diminishingReturnsWarned?: boolean;
  /**
   * Repo-relative paths in the blast-radius set (changed files + graph BFS + proximity), normalized with `/`.
   * **WHY:** Fixer batch allowlist stays full; prompt injection is intersected with this set to save context.
   * Undefined when blast radius was not built this analysis (disabled, failure, or cache without field).
   */
  blastRadiusPaths?: Set<string>;
  /**
   * Ephemeral: `git diff --name-only` vs PR base for this push iteration (from main-loop-setup).
   * WHY: Basename-only API paths (e.g. `auto-optimizer.ts`) need `resolveTrackedPathWithPrFiles` in
   * recovery and single-issue prompts when `issue.resolvedPath` is missing — same disambiguation as analysis.
   */
  prChangedFilesForRecovery?: string[];
  /**
   * Ephemeral: LLM dedup cluster map for this push iteration (from issue analysis).
   * WHY: Recovery / single-issue paths must mark the full duplicate cluster verified, not only the queued id.
   */
  duplicateMapForSession?: Map<string, string[]>;
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

export function ensureRotationSession(ctx: StateContext): RotationSessionTracking {
  if (!ctx.rotationSession) {
    ctx.rotationSession = {
      skippedModelKeys: new Set(),
      modelStats: new Map(),
      sessionSkippedSinceFixIteration: new Map(),
    };
  }
  if (!ctx.rotationSession.sessionSkippedSinceFixIteration) {
    ctx.rotationSession.sessionSkippedSinceFixIteration = new Map();
  }
  return ctx.rotationSession;
}

/** Restore session skip + stats from persisted state after `loadState` (pill-output). */
export function hydrateRotationSessionFromPersistedState(ctx: StateContext): void {
  if (!ctx.state) return;
  if (process.env.PRR_PERSIST_SESSION_MODEL_SKIP?.trim() === '0') return;
  const s = ctx.state;
  const keys = s.sessionSkippedModelKeys;
  const stats = s.sessionModelStats;
  const since = s.sessionSkippedSinceFixIteration;
  const hasKeys = keys && keys.length > 0;
  const hasStats = stats && Object.keys(stats).length > 0;
  const hasSince = since && Object.keys(since).length > 0;
  if (!hasKeys && !hasStats && !hasSince) return;

  const rs = ensureRotationSession(ctx);
  for (const k of keys ?? []) rs.skippedModelKeys.add(k);
  if (stats) {
    for (const [k, v] of Object.entries(stats)) {
      rs.modelStats.set(k, { fixes: v.fixes, failures: v.failures });
    }
  }
  if (since) {
    for (const [k, v] of Object.entries(since)) {
      rs.sessionSkippedSinceFixIteration.set(k, Number(v));
    }
  }
}

/** Write session skip sets into `ctx.state` before JSON save. */
export function persistRotationSessionToState(ctx: StateContext): void {
  if (!ctx.state || process.env.PRR_PERSIST_SESSION_MODEL_SKIP?.trim() === '0') return;
  if (!ctx.rotationSession) {
    delete ctx.state.sessionSkippedModelKeys;
    delete ctx.state.sessionModelStats;
    delete ctx.state.sessionSkippedSinceFixIteration;
    return;
  }
  const rs = ctx.rotationSession;
  if (rs.skippedModelKeys.size === 0 && rs.modelStats.size === 0) {
    delete ctx.state.sessionSkippedModelKeys;
    delete ctx.state.sessionModelStats;
    delete ctx.state.sessionSkippedSinceFixIteration;
    return;
  }
  ctx.state.sessionSkippedModelKeys = [...rs.skippedModelKeys];
  ctx.state.sessionModelStats = Object.fromEntries(
    [...rs.modelStats.entries()].map(([k, v]) => [k, { fixes: v.fixes, failures: v.failures }]),
  );
  if (rs.sessionSkippedSinceFixIteration.size > 0) {
    ctx.state.sessionSkippedSinceFixIteration = Object.fromEntries(rs.sessionSkippedSinceFixIteration);
  } else {
    delete ctx.state.sessionSkippedSinceFixIteration;
  }
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
