// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TIMING & POLLING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Skip comment fetch when head SHA unchanged and last fetch was within this many ms.
 * WHY: Reduces redundant API calls when we just fetched and haven't pushed.
 */
export const COMMENT_FETCH_SKIP_IF_FETCHED_WITHIN_MS = 60_000;

/**
 * Default poll interval (--poll-interval) in seconds.
 * How long to wait for bot re-review in auto-push mode.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 120;

/**
 * How often to check status while waiting for bot review (seconds).
 */
export const POLL_STATUS_CHECK_INTERVAL_SECONDS = 15;

/**
 * Minimum wait time before checking for bot responses (milliseconds).
 */
export const MIN_BOT_WAIT_MS = 30 * 1000; // 30 seconds

/**
 * Default wait when bot is actively reviewing (no timing data).
 */
export const BOT_ACTIVELY_REVIEWING_WAIT_SECONDS = 90;

/**
 * Default wait when CI checks are running (no timing data).
 */
export const CI_CHECKS_RUNNING_WAIT_SECONDS = 60;

/**
 * Time threshold for detecting rapid failures (milliseconds).
 * Failures faster than this indicate environment/setup issues.
 */
export const RAPID_FAILURE_THRESHOLD_MS = 2000;

/**
 * Maximum rapid failures allowed before bailing out.
 * WHY: Prevents infinite loops with broken tools/environment.
 */
export const MAX_RAPID_FAILURES = 3;

/**
 * Time window for rapid failure detection (milliseconds).
 * Failures are considered "rapid" if they occur within this window.
 */
export const RAPID_FAILURE_WINDOW_MS = 10_000; // 10 seconds

/**
 * Per-request timeout for LLM API calls (milliseconds).
 * Prevents a single attempt from hanging for minutes before 504; fail fast and retry.
 */
export const LLM_REQUEST_TIMEOUT_MS = 90_000; // 90 seconds

/**
 * Timeout for full-file rewrite requests (milliseconds).
 * Full-file prompts are larger and take longer to generate; use a longer timeout
 * so the request can complete before the gateway returns 504.
 */
export const LLM_REQUEST_TIMEOUT_FULL_FILE_MS = 180_000; // 3 minutes

/**
 * Client-side wait for each llm-api HTTP attempt (wrapped by with504Retry in shared/runners/llm-api.ts).
 * Full-file rewrite prompts use {@link LLM_REQUEST_TIMEOUT_FULL_FILE_MS} always.
 *
 * Large search/replace prompts (e.g. 100k+ chars) often need more than 90s wall time; output.log audits
 * showed Opus timing out at 90s with ~137k input while `isFullFileRewrite` was false.
 *
 * **Override:** set **`PRR_LLM_API_REQUEST_TIMEOUT_MS`** to a positive integer (ms) to use a fixed cap for
 * non-full-file fix calls (skips size tiers below).
 */
export function getLlmApiRequestTimeoutMs(promptCharCount: number, isFullFileRewrite: boolean): number {
  if (isFullFileRewrite) {
    return LLM_REQUEST_TIMEOUT_FULL_FILE_MS;
  }
  const raw = process.env.PRR_LLM_API_REQUEST_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  let ms = LLM_REQUEST_TIMEOUT_MS;
  if (promptCharCount > 60_000) ms = Math.max(ms, 120_000);
  if (promptCharCount > 100_000) ms = Math.max(ms, 150_000);
  if (promptCharCount > 140_000) ms = Math.max(ms, 180_000);
  return Math.min(ms, LLM_REQUEST_TIMEOUT_FULL_FILE_MS);
}
