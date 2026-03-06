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
 * Hard cap on issues per fix prompt regardless of context window.
 * WHY: Audit (prompts.log) showed 50-issue batches at 515k chars produced >99% waste
 * (model addressed ~5 issues, rest WRONG_LOCATION). Capping at 20 keeps batches effective.
 */
export const MAX_ISSUES_PER_FIX_PROMPT = 20;

/**
 * Hard cap on enriched fix prompt size (base + file injection).
 * WHY: Audit showed single 515k-char prompt produced >99% waste; cap prevents mega-prompts.
 */
export const MAX_ENRICHED_FIX_PROMPT_CHARS = 500_000;

/**
 * Stricter cap for total request size (base + injection) to avoid 504/gateway timeouts.
 * WHY: Audit showed 120k–240k char prompts still caused timeouts; hard cap keeps requests safe.
 */
export const MAX_ENRICHED_FIX_PROMPT_HARD_CAP = 200_000;

/**
 * Chars reserved for rewrite-escalation block appended after file injection.
 * WHY: Injection is capped to (maxEnrichedChars - this); final prompt can still reach maxEnrichedChars without throwing.
 */
export const REWRITE_ESCALATION_RESERVE_CHARS = 2_000;

/**
 * Maximum character length for the fix prompt (before file injection).
 * WHY: File injection can add ~200k+ chars (10 files). Keeping base prompt ≤ this
 * keeps total request under gateway limits (e.g. 500 on 690k). Audit: 449k base
 * + injection → 638k → some models 500.
 */
export const MAX_FIX_PROMPT_CHARS = 200_000;

/**
 * Conservative cap for the first fix attempt to avoid gateway timeouts (90s).
 * WHY: Audit (output.log) showed 94k char prompt timed out on first attempt;
 * pre-flight cap reduces batch so first call stays under ~80k and completes.
 */
export const FIRST_ATTEMPT_MAX_PROMPT_CHARS = 80_000;

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
 * Max issues per prompt when using OpenCode.
 * OpenCode often hangs or times out on large prompts (e.g. 80k chars / 12 issues).
 * Keeping batches small reduces timeouts; tool_timeout still disables it for the run if it hangs.
 */
export const OPENCODE_MAX_ISSUES_PER_PROMPT = 6;

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
 * Use chunked resolution for conflict files above this size (chars) instead of
 * trying full-file first. Reduces 504/timeouts on 22–50KB files.
 */
export const CONFLICT_USE_CHUNKED_FIRST_CHARS = 22_000;

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
 *
 * WHY claude-sonnet-4-5: Best speed/intelligence combo per Anthropic docs.
 * claude-3-5-sonnet-20241022 was deprecated and returns 404.
 * See: https://platform.claude.com/docs/en/about-claude/models/overview
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Default LLM model for OpenAI provider.
 *
 * WHY gpt-4o: Optimized GPT-4 model with improved context handling.
 * Current standard for general-purpose OpenAI API usage.
 * See: https://developers.openai.com/api/docs/models
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/**
 * Default LLM model for ElizaCloud provider.
 * ElizaCloud is an OpenAI-compatible gateway that routes to multiple providers.
 * Eliza Cloud uses owner/model IDs (e.g. anthropic/claude-sonnet-4-5-20250929).
 */
export const DEFAULT_ELIZACLOUD_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

/**
 * ElizaCloud API base URL (OpenAI-compatible).
 */
// Note: API base URL aligns with Eliza Cloud's design for consistency in requests.
export const ELIZACLOUD_API_BASE_URL = 'https://elizacloud.ai/api/v1';

/**
 * Max concurrent requests to ElizaCloud API.
 * WHY: ElizaCloud returns 429 when too many in flight. 1 = one request at a time.
 */
export const ELIZACLOUD_MAX_CONCURRENT_REQUESTS = 1;

/**
 * Min ms between starting successive ElizaCloud requests (per slot).
 * WHY: 6s spacing keeps request rate under ElizaCloud limit of 10 req/min; avoids 429 bursts.
 */
export const ELIZACLOUD_MIN_DELAY_MS = 6000;

/**
 * Max concurrent LLM dedup calls (per-file).
 * WHY: Running file-level dedup in parallel cuts phase time (e.g. 38 files in ~1 batch
 * instead of 38 sequential). ElizaCloud still serializes via acquireElizacloud(); direct
 * Anthropic/OpenAI get real parallelism. Cap at 5 to avoid 429 on strict gateways.
 */
export const LLM_DEDUP_MAX_CONCURRENT = 5;

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
// Review: limits progress cycles to prevent indefinite execution on stuck processes.
export const DEFAULT_MAX_STALE_CYCLES = 1;

/**
 * Maximum distinct tool/model combinations to attempt before marking as remaining.
 * WHY: If 4 different strategies all fail, the issue is likely unsolvable.
 * Different from a raw attempt count which doesn't distinguish "same model retried" from "all strategies tried".
 */
export const MAX_DISTINCT_FAILED_ATTEMPTS = 4;

/**
 * Total failed fix attempts (across all sessions) before dismissing as chronic failure.
 * WHY: Same issue failing 5+ times burns tokens with no progress; auto-dismiss and let human review.
 * Override with PRR_CHRONIC_FAILURE_THRESHOLD env (integer).
 */
export const CHRONIC_FAILURE_THRESHOLD = typeof process !== 'undefined' && process.env.PRR_CHRONIC_FAILURE_THRESHOLD
  ? Math.max(1, parseInt(process.env.PRR_CHRONIC_FAILURE_THRESHOLD, 10) || 5)
  : 5;

/**
 * Number of "tool modified wrong files" lessons for an issue before we mark as remaining.
 * WHY: When the fix requires a different file than the comment's path (e.g. duplicate interface in commit.ts
 * but comment is on git-push.ts), the fixer correctly refuses to change the wrong file and we burn through
 * all models. Exhausting after 2 wrong-file lessons defers to human and saves ~5 min of LLM calls.
 */
export const WRONG_FILE_EXHAUST_THRESHOLD = 2;

/**
 * Number of WRONG_LOCATION/UNCLEAR results for an issue before we mark as remaining (stop retries).
 * WHY: Audit showed 10+ LLM calls on one issue where fixer repeatedly said WRONG_LOCATION (code not in file);
 * 2 is enough to confirm the issue is about another file or stale context — defers to human and saves tokens.
 */
export const WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD = 2;

/**
 * Number of consecutive ALREADY_FIXED results (same explanation) before we dismiss as not-an-issue.
 * WHY: Prompts.log audit — same issue got 12 fix attempts with every model saying "no as any casts in this file";
 * bailing after 2× identical ALREADY_FIXED saves tokens and defers phantom issues to human.
 */
export const ALREADY_FIXED_EXHAUST_THRESHOLD = 2;

/**
 * Consecutive ALREADY_FIXED results (any explanation) before we dismiss as already-fixed.
 *
 * WHY separate from ALREADY_FIXED_EXHAUST_THRESHOLD: That counter only fires when the
 * explanation text matches (same model, same wording). This counter catches the broader
 * pattern: 3+ different models independently return ALREADY_FIXED with varying explanations
 * (e.g. "guard clause exists", "null check present", "already handled"). When multiple
 * models agree regardless of wording, the issue is almost certainly resolved.
 *
 * WHY 3: Conservative enough to avoid false dismissals (one model can be wrong, two is
 * suspicious, three is a consensus). Counter resets when the fixer makes actual changes
 * or the issue is verified fixed, so only truly consecutive no-change results count.
 */
export const ALREADY_FIXED_ANY_THRESHOLD = 3;

/**
 * Number of CANNOT_FIX results citing missing/placeholder file content before we skip the issue.
 * WHY 2: Audit showed 10+ retries on placeholder files (500K+ tokens wasted). After 2 CANNOT_FIX
 * with "file content missing/placeholder", the file injection is broken and retrying won't help.
 */
export const CANNOT_FIX_MISSING_CONTENT_THRESHOLD = 2;

/**
 * Consecutive "could not inject file from repo" + no-change cycles before dismissing as file-unchanged.
 * WHY: output.log audit H2 — issues targeting paths not in HEAD (e.g. redeemable-earnings.ts) were retried
 * dozens of times with no file content; dismiss so we stop burning tokens.
 */
export const COULD_NOT_INJECT_DISMISS_THRESHOLD = 3;

/**
 * Verifier verdicts saying "delete entirely" / "remove from repo" before we dismiss (Cycle 13 M2).
 * Gives the model 2 chances to output <deletefile> before deferring to handoff.
 */
export const DELETE_ENTIRELY_DISMISS_THRESHOLD = 2;

/**
 * Per-file search/replace (or hallucinated-stub) failure count before dismissing issues targeting that file as remaining.
 * WHY: output.log audit H3 — wallet-auth.ts had 26 failures and was still retried; dismiss so we stop burning tokens.
 */
export const HALLUCINATION_DISMISS_THRESHOLD = 5;

/**
 * Number of consecutive CANNOT_FIX results (any reason) before we dismiss as not-an-issue.
 * WHY: output.log audit — Vercel bot comments got 10 fix iterations with every model saying
 * CANNOT_FIX (deployment/team notification, not code). After 2× CANNOT_FIX, bailing saves tokens.
 */
export const CANNOT_FIX_EXHAUST_THRESHOLD = 2;

/**
 * Times the verifier can reject an issue (fixer claimed fixed / ALREADY_FIXED but verifier said no)
 * before we dismiss it to avoid token waste on repeated retries.
 * WHY 3: With VERIFIER_ESCALATION_THRESHOLD=1 we use the stronger (fixer) model after the first rejection. Dismissing at 3 gives two verification attempts with the stronger model before deferring to human.
 */
export const VERIFIER_REJECTION_DISMISS_THRESHOLD = 3;

/** After this many verifier rejections for an issue, use the current fixer model for the next verification. WHY: Audit showed cheap verifier repeatedly said "not fixed" while fixers had applied valid changes. */
export const VERIFIER_ESCALATION_THRESHOLD = 1;

/** Max number of verifier rejection messages to keep per issue so the fixer sees judge→fixer thread. WHY: Full thread helps fixer avoid repeating the same attempt; cap prevents prompt bloat. */
export const VERIFIER_FEEDBACK_HISTORY_MAX = 10;

/**
 * After this many verifier rejections, if the review's described bug pattern (e.g. enumerate())
 * is no longer present in the current code, auto-verify to break fixer/verifier stalemates.
 * WHY 3: Matches VERIFIER_REJECTION_DISMISS_THRESHOLD. The auto-verify check runs inside
 * fix-verification before the rejection count is persisted, so it fires on the 3rd rejection.
 * Audit showed 7+ rejections on already-fixed code; 3 gives the verifier a fair chance while
 * stopping the stalemate before it burns too many tokens.
 */
export const AUTO_VERIFY_PATTERN_ABSENT_THRESHOLD = 3;

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
 * Using max(5, floor(iterations/10)) keeps re-checks bounded on long-running PRs.
 */
export function getVerificationExpiryForIterationCount(iterationCount: number): number {
  return Math.max(VERIFICATION_EXPIRY_ITERATIONS, Math.floor(iterationCount / 10));
}

/**
 * Minimum length for a meaningful verification explanation.
 * Prevents accepting lazy/vague LLM responses.
 */
export const MIN_VERIFICATION_EXPLANATION_LENGTH = 20;

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
 * WHY 20: Review bots reference ranges (e.g. "lines 52-93"); 5 lines before was too narrow
 * and often missed imports/class context. 20 captures surrounding scope without bloating the prompt.
 */
export const CODE_SNIPPET_CONTEXT_BEFORE = 20;

/**
 * Lines of context after the issue line in code snippets (for getCodeSnippet).
 * WHY 30: Comments often point at the start of a block; 10 lines after missed the rest of
 * the function or block. 30 covers typical method/block length while staying under snippet cap.
 */
export const CODE_SNIPPET_CONTEXT_AFTER = 30;

/**
 * Default line range when only start line is provided (for bugbot comments).
 */
export const DEFAULT_LINE_RANGE_SIZE = 20;

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUNNER-SPECIFIC LIMITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maximum consecutive whitespace to allow in LLM API runner output.
 * WHY: Detect infinite loops/generation issues.
 */
export const MAX_WHITESPACE_IN_RUNNER_OUTPUT = 1000;
