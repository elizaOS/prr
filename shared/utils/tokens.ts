/**
 * Token estimation and text truncation for context budgeting.
 * Used by prr (prompt size checks), pill (log context caps), and story-related flows.
 *
 * WHY shared: Same chars-per-token rule and head+tail truncation pattern avoid drift
 * and duplicate logic across tools/prr and tools/pill.
 */

/** Rough chars per token (conservative for English/code). Used for budgeting only. */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for a string.
 * Good enough for context budgeting; not accurate for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const TRUNCATE_MARKER = '\n\n[ ... truncated for context size ... ]\n\n';

/**
 * Truncate text to ~maxTokens (chars/4), keeping head (2/3) and tail (1/3).
 * Caller can pass a custom marker for audit/log messages.
 * WHY head+tail: Start and end of logs/docs carry the most signal (init, exit, summary); middle is often repetitive.
 * WHY tailChars Math.max(0, …): When marker is long, tailChars could go negative; slice(-n) with negative n is wrong.
 */
export function truncateHeadAndTail(
  text: string,
  maxTokens: number,
  marker: string = TRUNCATE_MARKER
): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * (2 / 3));
  const tailChars = Math.max(0, maxChars - headChars - marker.length);
  return text.slice(0, headChars) + marker + text.slice(-tailChars);
}

/**
 * Truncate text to maxChars, keeping head (2/3) and tail (1/3).
 * Used for hard character caps (e.g. 504 timeout avoidance).
 * WHY char cap: Token-based truncation can still send huge bodies if the provider counts tokens differently; char cap is a hard guard.
 */
export function truncateHeadAndTailByChars(
  text: string,
  maxChars: number,
  marker: string = TRUNCATE_MARKER
): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * (2 / 3));
  const tailChars = Math.max(0, maxChars - headChars - marker.length);
  return text.slice(0, headChars) + marker + text.slice(-tailChars);
}
