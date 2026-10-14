// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VERIFICATION & CACHING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Minimum iterations after which a verification is considered stale (re-checked).
 * WHY: Code changes over iterations; old verifications may be stale.
 */
export const VERIFICATION_EXPIRY_ITERATIONS = 5;

/**
 * Scale stale-verification threshold with total iteration count.
 * WHY: At 131 iterations a fixed threshold of 5 causes 40+ re-checks per run (time/tokens).
 * Using max(5, floor(iterations/15)) keeps re-checks rarer on very long runs (output.log audit: /10 caused large stale batches).
 */
export function getVerificationExpiryForIterationCount(iterationCount: number): number {
  return Math.max(VERIFICATION_EXPIRY_ITERATIONS, Math.floor(iterationCount / 15));
}

/**
 * Minimum length for a meaningful verification explanation.
 * Prevents accepting lazy/vague LLM responses.
 */
export const MIN_VERIFICATION_EXPLANATION_LENGTH = 20;
