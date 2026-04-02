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
 * Pill audit: when allowedPaths was empty, every edit was falsely reported as wrong-file; we now ensure
 * single-issue mode always includes the issue's path and do not count edits to the issue's target as wrong.
 * If false positives persist, consider raising to 3.
 */
export const WRONG_FILE_EXHAUST_THRESHOLD = 2;

/**
 * Number of WRONG_LOCATION/UNCLEAR results for an issue before we mark as remaining (stop retries).
 * WHY: Audit showed 10+ LLM calls on one issue where fixer repeatedly said WRONG_LOCATION (code not in file);
 * 2 is enough to confirm the issue is about another file or stale context — defers to human and saves tokens.
 */
export const WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD = 2;

/**
 * Apply failures (search/replace did not match) before dismissing as chronic-failure.
 * WHY: output.log audit — earlier dismissal with "output did not match file after N attempts" so the loop
 * doesn't burn many iterations; handoff note makes it clear for human review.
 */
export const APPLY_FAILURE_DISMISS_THRESHOLD = 2;

/**
 * Consecutive no-changes (same issue set) before dismissing as remaining and continuing with others.
 * WHY: output.log audit §3 — earlier bail-out (2 instead of 3) so we don't burn iterations on the same set.
 */
export const NO_PROGRESS_DISMISS_THRESHOLD = 2;

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
 * Lower threshold for "create this file" issues (e.g. missing test file).
 * WHY: output.log audit §4 — couldNotInject on create-file paths retried 2–3 times with no file created; dismiss after 1 failure.
 */
export const COULD_NOT_INJECT_CREATE_FILE_THRESHOLD = 1;

/**
 * Consecutive "file not modified" count before dismissing as file-unchanged.
 * WHY: output.log audit — fix iter 1 dismissed 6 issues (file not modified); fix iter 2 then
 * modified those files and fixed them. Defer dismissal until 2nd occurrence so one fix iteration
 * can touch multiple files and we don't dismiss too early.
 */
export const FILE_UNCHANGED_DISMISS_THRESHOLD = 2;

/**
 * Verifier verdicts saying "delete entirely" / "remove from repo" before we dismiss (Cycle 13 M2).
 * Gives the model 2 chances to output <deletefile> before deferring to handoff.
 */
export const DELETE_ENTIRELY_DISMISS_THRESHOLD = 2;

/**
 * Per-file search/replace (or hallucinated-stub) failure count before dismissing issues targeting that file as remaining.
 * WHY: output.log audit H3 — wallet-auth.ts had 26 failures and was still retried. Lowered from 5 to 3 for earlier dismissal (output.log audit §2).
 */
export const HALLUCINATION_DISMISS_THRESHOLD = 3;

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
