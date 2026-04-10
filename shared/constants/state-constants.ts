// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LESSONS & STATE MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maximum recent lessons to show per file (most recent N).
 */
export const MAX_RECENT_LESSONS_PER_FILE = 5;

// Lesson sync limits are defined in tools/prr/state/lessons-paths.ts (canonical source of truth).

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DISTRIBUTED LOCKING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Default lock duration for distributed locking (milliseconds).
 * Claims expire after this time if not renewed.
 */
export const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Lock file name for distributed coordination.
 */
export const LOCK_FILENAME = '.prr-lock.json';
