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
 * ElizaCloud `LLMClient.complete()` inner loop: retries after 500/502/504 (and similar) before surfacing failure.
 * The loop runs `attempt504` from 0 through N inclusive → **N + 1** HTTP attempts, with 10s / 20s / … backoff
 * (the last delay repeats for further attempts).
 *
 * - **Default 2** (3 attempts) when not in CI — balances flaky gateways vs long hangs.
 * - **Default 4** (5 attempts) when **`CI=true`** and **`PRR_ELIZACLOUD_SERVER_ERROR_RETRIES`** is unset — Actions often sees transient empty 500s.
 * - **`PRR_ELIZACLOUD_SERVER_ERROR_RETRIES`**: explicit override, integer **0–15**. Per-call **`complete(..., { max504Retries })`** still wins.
 */
const ELIZACLOUD_SERVER_ERROR_RETRIES_CAP = 15;

export function getElizacloudServerErrorMaxRetries(): number {
  const raw = process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES?.trim();
  if (raw != null && raw !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= ELIZACLOUD_SERVER_ERROR_RETRIES_CAP) return n;
  }
  if (process.env.CI === 'true') return 4;
  return 2;
}

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
/** Cap fix prompt size to reduce gateway timeouts (prompts.log audit: 194k chars caused risk). First attempt uses FIRST_ATTEMPT_MAX_PROMPT_CHARS. */
export const MAX_FIX_PROMPT_CHARS = 100_000;

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

/** Same as MAX_CONFLICT_RESOLUTION_FILE_SIZE — max chars for one-shot LLM merge prompts (tools/prr/llm/client.ts). */
export const MAX_CONFLICT_SINGLE_SHOT_LLM_CHARS = MAX_CONFLICT_RESOLUTION_FILE_SIZE;

/**
 * Use chunked resolution for conflict files above this size (chars) instead of
 * trying full-file first. Reduces 504/timeouts on 22–50KB files.
 */
export const CONFLICT_USE_CHUNKED_FIRST_CHARS = 22_000;

/**
 * Use chunked resolution when a file has many distinct conflict regions even if
 * the total file size is modest.
 * WHY: prompts.log showed files like test_autonomy.py work much better as many
 * 1-2KB chunk prompts than as a single 20KB whole-file conflict prompt.
 */
export const CONFLICT_USE_CHUNKED_FIRST_CHUNKS = 5;

/**
 * Reserve for 3-way conflict prompt: system/instructions + model response.
 * WHY: Each request sends base + ours + theirs (3× segment) + this overhead. We derive segment cap as
 * (effectiveMaxChars - this) / 3 so input + output stays within the model's context window.
 */
export const CONFLICT_PROMPT_OVERHEAD_CHARS = 12_000;

/**
 * File-overview ("story") for chunked conflict resolution: we do a full read of the file (no preview/truncation),
 * in consecutive full-content segments; the LLM tells a story across turns; that story is injected into each
 * chunk-resolution prompt.
 */
/** Size of each full-content segment when we chunk the file for the story read (no cap — we always chunk). */
export const FILE_OVERVIEW_SEGMENT_CHARS = 40_000;
/** Trigger overview when file has at least this many conflict regions. */
export const FILE_OVERVIEW_MIN_CHUNKS = 2;
/** Trigger overview when file size exceeds this (even with one conflict). */
export const FILE_OVERVIEW_MIN_FILE_CHARS = 15_000;

/**
 * Default max chars per segment when model context is unknown.
 * WHY override in resolve path: When we know the model we use (effectiveMaxChars - CONFLICT_PROMPT_OVERHEAD_CHARS) / 3
 * so small-context models get smaller segments; this default is used only when model is not available.
 */
export const MAX_EDGE_SEGMENT_CHARS_DEFAULT = 12_000;

/**
 * Conflict region above this size triggers sub-chunking at AST/fallback edges.
 * WHY same as segment default: We sub-chunk when the region would exceed one segment cap, so we never
 * send a single request with more than one segment's worth of content (keeps context bounded).
 */
export const MAX_SINGLE_CHUNK_CHARS = 12_000;

/**
 * Max file size (chars) embedded in the post-resolution "syntax fix" LLM pass (full file in prompt).
 * Larger files skip that pass — avoids gateway 504 / multi-minute timeouts (audit: ~214k-char prompt).
 */
export const MAX_CONFLICT_SYNTAX_FIX_EMBED_CHARS = 45_000;

/**
 * Half-window line count (above + below center) for **windowed** conflict syntax-fix when the file
 * exceeds MAX_CONFLICT_SYNTAX_FIX_EMBED_CHARS. WHY: Large files (e.g. 200k+ chars) still fail parse
 * with leftover markers; a local fragment prompt avoids 504s while fixing the error line.
 */
export const CONFLICT_SYNTAX_FIX_WINDOW_HALF_LINES = 140;

/** Max chars for that fragment (prompt + response headroom). */
export const CONFLICT_SYNTAX_FIX_WINDOW_MAX_CHARS = 32_000;

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
 * Top+tails fallback: only try when no conflict chunk exceeds this line count (larger side).
 * WHY: We ask the model to produce the full resolved conflict from partial input (top + tails);
 * very large conflicts would require the model to invent too much middle content.
 */
export const TOP_TAILS_FALLBACK_MAX_CHUNK_LINES = 280;

/** Lines of context before conflict to include in "top" for top+tails fallback. */
export const TOP_TAILS_CONTEXT_LINES = 15;
/** First N lines of the conflict block (with markers) to include in "top". */
export const TOP_TAILS_TOP_CONFLICT_LINES = 80;
/** Last N lines of OURS/THEIRS (and base) to include as "tail". */
export const TOP_TAILS_TAIL_LINES = 80;

/**
 * Above this line count (larger side), use two-pass resolution in top+tails fallback: resolve head, then tail.
 * Below this, one shot (top + tails → full resolution). Keeps one-shot for small conflicts.
 */
export const TOP_TAILS_TWO_PASS_THRESHOLD_LINES = 150;

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
