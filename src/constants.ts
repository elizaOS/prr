/**
 * Global constants for PRR (PR Resolver).
 * 
 * WHY CENTRALIZED: Having all magic numbers in one place makes it easy to:
 * - Tune behavior without hunting through code
 * - Understand system-wide limits and thresholds
 * - Adjust for different environments or use cases
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LLM TOKEN LIMITS & PROMPT SIZE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Anthropic Claude models have a 200k token input limit.
 * We target 180k to leave 20k buffer for model response.
 */
export const MAX_PROMPT_TOKENS = 180000;

/**
 * Maximum characters for LLM context (default for --max-context).
 * ~400k chars ≈ 100k tokens (4 chars per token estimate).
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 400000;

/**
 * Maximum characters per batch for issue existence checking.
 * ~150k chars ≈ 37.5k tokens (safe for all models).
 */
export const BATCH_CHECK_MAX_CONTEXT_CHARS = 150000;

/**
 * Maximum issues to include in a single fix prompt.
 * With truncation (2k per comment + 500 lines per snippet),
 * 50 issues ≈ 100k chars ≈ 25k tokens.
 */
export const MAX_ISSUES_PER_PROMPT = 50;

/**
 * Maximum characters per review comment in fix prompts.
 * Truncate longer comments to prevent prompt overflow.
 */
export const MAX_COMMENT_CHARS = 2000;

/**
 * Maximum lines per code snippet in fix prompts.
 * Prevents entire files from bloating the prompt.
 */
export const MAX_SNIPPET_LINES = 500;

/**
 * Maximum file size for LLM conflict resolution (50KB).
 * Larger files cause token overflow and response truncation.
 */
export const MAX_CONFLICT_RESOLUTION_FILE_SIZE = 50000;

/**
 * Maximum issues to show in commit message generation.
 * Keeps prompt focused on most relevant context.
 */
export const MAX_COMMIT_MESSAGE_ISSUES = 10;

/**
 * Reserve space in batched prompts for footer/instructions.
 */
export const BATCH_PROMPT_FOOTER_SIZE = 200;

/**
 * Reserve space for model recommendation section in prompts.
 */
export const MODEL_RECOMMENDATION_SECTION_SIZE = 1500;

/**
 * Reserve space for final audit footer text.
 */
export const FINAL_AUDIT_FOOTER_SIZE = 100;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEFAULT MODELS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Default LLM model for Anthropic provider.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Default LLM model for OpenAI provider.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.3';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MODEL ROTATION & TOOL SWITCHING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * How many models to try on current tool before switching to next tool.
 * WHY: Different tools have different strengths; cycling faster helps unstick loops.
 */
export const MAX_MODELS_PER_TOOL_ROUND = 2;

/**
 * Default max stale cycles (--max-stale-cycles).
 * Bail out after N complete tool/model cycles with zero progress.
 */
export const DEFAULT_MAX_STALE_CYCLES = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VERIFICATION & CACHING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Re-check issues verified more than N iterations ago.
 * WHY: Code changes over iterations; old verifications may be stale.
 */
export const VERIFICATION_EXPIRY_ITERATIONS = 5;

/**
 * Minimum length for a meaningful verification explanation.
 * Prevents accepting lazy/vague LLM responses.
 */
export const MIN_VERIFICATION_EXPLANATION_LENGTH = 20;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TIMING & POLLING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GIT OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Timeout for git push operations (milliseconds).
 */
export const GIT_PUSH_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Maximum push retries on conflict.
 */
export const MAX_PUSH_RETRIES = 3;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CODE SNIPPETS & CONTEXT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Lines of context before the issue line in code snippets (for getCodeSnippet).
 */
export const CODE_SNIPPET_CONTEXT_BEFORE = 5;

/**
 * Lines of context after the issue line in code snippets (for getCodeSnippet).
 */
export const CODE_SNIPPET_CONTEXT_AFTER = 10;

/**
 * Default line range when only start line is provided (for bugbot comments).
 */
export const DEFAULT_LINE_RANGE_SIZE = 20;

/**
 * Maximum recent lessons to show per file (most recent N).
 */
export const MAX_RECENT_LESSONS_PER_FILE = 5;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LESSONS & STATE MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maximum global lessons to sync to CLAUDE.md/CONVENTIONS.md.
 * WHY: Keep sync files readable; too many lessons is noise.
 */
export const MAX_GLOBAL_LESSONS_FOR_SYNC = 15;

/**
 * Maximum lessons per file to sync to CLAUDE.md/CONVENTIONS.md.
 * WHY: Focus on most recent/relevant lessons per file.
 */
export const MAX_FILE_LESSONS_FOR_SYNC = 5;

/**
 * Maximum files to include per-file lessons for in sync.
 * WHY: Prevents massive sync files; focus on most-edited files.
 */
export const MAX_FILES_FOR_SYNC = 20;

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUNNER-SPECIFIC LIMITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maximum consecutive whitespace to allow in LLM API runner output.
 * WHY: Detect infinite loops/generation issues.
 */
export const MAX_WHITESPACE_IN_RUNNER_OUTPUT = 1000;
