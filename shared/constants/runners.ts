// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUNNER-SPECIFIC LIMITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maximum consecutive whitespace to allow in LLM API runner output.
 * WHY: Detect infinite loops/generation issues.
 */
export const MAX_WHITESPACE_IN_RUNNER_OUTPUT = 1000;

/**
 * Every N completed fix iterations (within a push iteration’s inner loop), clear session-skipped model keys
 * so rotation can retry them. **0** = disabled (default). **WHY:** Pill-output #847 — long runs otherwise
 * never revisit a model skipped early for transient failures; next process run was the only retry.
 */
export function getSessionModelSkipResetAfterFixIterations(): number {
  const raw = process.env.PRR_SESSION_MODEL_SKIP_RESET_AFTER_FIX_ITERATIONS?.trim();
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n;
}

/** Cumulative verification failures (per tool/model, this process) with zero verified fixes before skipping that model for the rest of the run. Set `PRR_SESSION_MODEL_SKIP_FAILURES=0` to disable. */
export function getSessionModelSkipFailureThreshold(): number {
  const raw = process.env.PRR_SESSION_MODEL_SKIP_FAILURES?.trim();
  if (raw === '0') return 0;
  if (raw === undefined || raw === '') return 4;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/**
 * Consecutive fix iterations with no new verified fixes before emitting one warning. Set `PRR_DIMINISHING_RETURNS_ITERATIONS=0` to disable.
 */
export function getDiminishingReturnsIterationThreshold(): number {
  const raw = process.env.PRR_DIMINISHING_RETURNS_ITERATIONS?.trim();
  if (raw === '0') return 0;
  if (raw === undefined || raw === '') return 10;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
