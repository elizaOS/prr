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
export const DEFAULT_MAX_CONTEXT_CHARS = 400_000;

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
 * Minimum issues per prompt when adaptive batching reduces the batch size.
 * Below this, single-issue focus mode is more appropriate.
 *
 * WHY 5: Single-issue mode already handles 1-3 issues with focused context
 * per issue. Between 5 and MAX, the adaptive batch gives the model a smaller
 * but still meaningful workload. Going below 5 would overlap with single-issue
 * mode without the per-issue context benefits.
 */
export const MIN_ISSUES_PER_PROMPT = 5;

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
 * Maximum file size for single-pass LLM conflict resolution (50KB).
 * Larger files use chunked resolution strategy to stay within token limits.
 * 
 * WHY CHUNKED STRATEGY: Files >50KB are split into conflict regions that are
 * resolved separately and reconstructed, enabling resolution of any size file.
 */
export const MAX_CONFLICT_RESOLUTION_FILE_SIZE = 50000;

/**
 * Minimum ratio of resolved content lines to the larger conflict side's lines.
 * If a resolution is smaller than this fraction, reject it as likely corrupted.
 * 
 * WHY: LLMs sometimes catastrophically truncate large files during conflict
 * resolution (e.g., reducing 23K-line schema to 250 lines). This catches such
 * failures before the garbage gets committed and pushed.
 */
export const MIN_CONFLICT_RESOLUTION_SIZE_RATIO = 0.1; // 10%

/**
 * Minimum line count in the larger conflict side to trigger size regression checks.
 * Small conflicts don't benefit from ratio checks (a 10-line conflict resolving
 * to 1 line is fine).
 */
export const MIN_LINES_FOR_SIZE_REGRESSION_CHECK = 100;

/**
 * Size ratio threshold for detecting asymmetric conflicts in generated files.
 * If the smaller conflict side is less than this fraction of the larger side,
 * use the large-side-as-base strategy instead of standard LLM resolution.
 * 
 * Example: a 17-line empty Drizzle skeleton vs a 23K-line full schema
 * has a ratio of 0.0007 — far below this 5% threshold.
 */
export const ASYMMETRIC_CONFLICT_SIDE_RATIO = 0.05; // 5%

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
export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';

/**
 * Default LLM model for OpenAI provider.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/**
 * Default LLM model for ElizaCloud provider.
 */
export const DEFAULT_ELIZACLOUD_MODEL = 'gpt-4o';

/**
 * ElizaCloud API base URL (OpenAI-compatible).
 */
export const ELIZACLOUD_API_BASE_URL = 'https://elizacloud.ai/api/v1';

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

/**
 * Maximum distinct tool/model combinations to attempt before dismissing as exhausted.
 * WHY: If 4 different strategies all fail, the issue is likely unsolvable.
 * Different from a raw attempt count which doesn't distinguish "same model retried" from "all strategies tried".
 */
export const MAX_DISTINCT_FAILED_ATTEMPTS = 4;

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

// Lesson sync limits are defined in src/state/lessons-paths.ts (canonical source of truth).

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
