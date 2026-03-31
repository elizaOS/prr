// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLONE / FETCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Clone timeout in ms. Configurable via PRR_CLONE_TIMEOUT_MS (default 900s).
 * WHY: Large repos (e.g. 1.6GB) can block indefinitely; timeout + progress feedback avoid silent hang (pill-output #1).
 */
export const DEFAULT_CLONE_TIMEOUT_MS = 900_000;
