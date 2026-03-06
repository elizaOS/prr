export interface ChangeRecord {
  file: string;
  description: string;
}

export interface VerificationResult {
  passed: boolean;
  reason: string;
}

export interface Iteration {
  timestamp: string;
  commentsAddressed: string[];
  changesMade: ChangeRecord[];
  verificationResults: Record<string, VerificationResult>;
}

export interface TokenUsageRecord {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface VerifiedComment {
  commentId: string;
  verifiedAt: string;        // ISO timestamp when verified
  verifiedAtIteration: number;  // Which iteration it was verified in
  autoVerifiedFrom?: string;  // If this was auto-verified, the canonical comment ID
}

/**
 * Explicit open/resolved lifecycle for each PR comment.
 *
 * HISTORY: Previously, comments not in verifiedFixed or dismissedIssues were
 * implicitly "open" — but we had no record that we'd ALREADY analyzed them and
 * confirmed they still need fixing. Every push iteration re-sent the entire
 * unresolved set to the LLM for classification, burning tokens on identical
 * "still exists" verdicts. Now we persist the LLM's classification so
 * subsequent iterations skip the analysis LLM call for comments whose target
 * file hasn't changed. The status transitions are:
 *
 *   (new comment) ──analyze──► open ──fix+verify──► resolved
 *                                  ──dismiss──────► resolved
 *                  ──analyze──► resolved (already fixed / stale)
 *
 * "open" comments are only re-analyzed when their target file is modified
 * (our fix may have resolved them) or during a final audit (--reverify).
 */
export interface CommentStatus {
  /** Current lifecycle status */
  status: 'open' | 'resolved';
  /** LLM classification when status was set */
  classification: 'exists' | 'stale' | 'fixed';
  /** LLM explanation of why the issue exists / is stale / is fixed */
  explanation: string;
  /** Triage scores from LLM analysis (1-5 scale) */
  importance: number;
  ease: number;
  /** File path this comment targets */
  filePath: string;
  /** SHA-1 prefix of file content when status was last set */
  fileContentHash: string;
  /** When the status was last set/updated */
  updatedAt: string;
  /** Iteration when status was last set */
  updatedAtIteration: number;
  /** When resolved via dismiss: actual dismiss category (stale, remaining, etc.; legacy: exhausted). */
  dismissCategory?: DismissedIssue['category'];
}

/**
 * Track issues that were dismissed (determined not to need fixing).
 *
 * WHY: This enables a feedback loop between the issue generator and judge.
 * By documenting WHY issues don't need fixing, we can:
 * 1. Provide transparency about what was skipped and why
 * 2. Help the generator learn to avoid false positives
 * 3. Enable dialog between generator and judge
 * 4. Track patterns in dismissed issues to improve detection
 */
export interface DismissedIssue {
  commentId: string;
  reason: string;                 // Detailed explanation of why it doesn't need fixing
  dismissedAt: string;            // ISO timestamp when dismissed
  dismissedAtIteration: number;   // Which iteration it was dismissed in
  category: 'already-fixed' | 'not-an-issue' | 'file-unchanged' | 'false-positive' | 'duplicate' | 'stale' | 'exhausted' | 'remaining' | 'chronic-failure';
  filePath: string;               // File the comment was about
  line: number | null;            // Line number if specified
  commentBody: string;            // Original review comment text
  /** Optional next-step for humans (e.g. lockfile: "Run: bun install") */
  remediationHint?: string;
}

/**
 * Track model performance for this project.
 * 
 * WHY: Different models have different strengths. By tracking which models
 * successfully fix issues vs which ones fail, we can:
 * 1. Prioritize better-performing models for this codebase
 * 2. Skip models that consistently fail
 * 3. Provide insights to the user about model effectiveness
 */
export interface ModelStats {
  fixes: number;          // Issues successfully fixed (verified)
  failures: number;       // Fix attempts that failed verification
  noChanges: number;      // Times model made no changes
  errors: number;         // Tool errors (connection, timeout, etc.)
  lastUsed: string;       // ISO timestamp
}

export type ModelPerformance = Record<string, ModelStats>;  // "tool/model" -> stats

/**
 * Track individual fix attempts per issue.
 * 
 * WHY: The LLM model selector needs to know what's been tried on each issue:
 * - "Model X already tried this and failed" → try a different model
 * - "Model Y failed with a lesson learned" → use that lesson
 * - "3 models failed on this issue" → might need strongest model or human review
 */
export interface IssueAttempt {
  commentId: string;            // Which issue was attempted
  tool: string;                 // e.g., "cursor", "claude-code"
  model?: string;               // e.g., "claude-sonnet-4-5"
  timestamp: string;            // ISO timestamp
  result: 'fixed' | 'failed' | 'no-changes' | 'error';
  lessonLearned?: string;       // If a lesson was extracted from this attempt
  rejectionCount?: number;      // How many times the fix was rejected
  /** File content hash when attempt was made; used to ignore attempts after file changed */
  fileContentHash?: string;
}

export type IssueAttempts = Record<string, IssueAttempt[]>;  // commentId -> attempts

/**
 * Track bail-out events and reasons.
 * 
 * WHY: Document why automation stopped so humans can pick up where it left off.
 * This enables:
 * 1. Clear handoff to human reviewers
 * 2. Pattern recognition (what types of issues stall automation?)
 * 3. Feedback loop improvement (what lessons failed to help?)
 */
export interface BailOutRecord {
  timestamp: string;
  reason: 'no-progress-cycles' | 'max-iterations' | 'user-interrupt' | 'all-dismissed';
  cyclesCompleted: number;
  remainingIssues: Array<{
    commentId: string;
    filePath: string;
    line: number | null;
    summary: string;  // First line of comment
  }>;
  partialProgress: {
    issuesFixed: number;
    issuesRemaining: number;
    lessonsLearned: number;
  };
  toolsExhausted: string[];  // Which tools were tried
}

export interface ResolverState {
  pr: string;
  branch: string;
  headSha: string;           // SHA of PR head when state was saved
  startedAt: string;
  lastUpdated: string;
  iterations: Iteration[];
  lessonsLearned: string[];
  verifiedFixed: string[];   // Comment IDs that have been verified as fixed (legacy, for backwards compat)
  verifiedComments?: VerifiedComment[];  // New: detailed verification records with timestamps
  dismissedIssues?: DismissedIssue[];    // Issues that don't need fixing with reasons
  /** Per-comment open/resolved status with LLM classification.
   *  HISTORY: Replaces the ephemeral analysis cache — this is persisted across
   *  sessions so even a resumed run doesn't re-analyze unchanged comments. */
  commentStatuses?: Record<string, CommentStatus>;
  interrupted?: boolean;     // True if last run was interrupted
  interruptPhase?: string;   // Phase where interruption occurred
  // Tool/model rotation state - persisted so we resume where we left off
  currentRunnerIndex?: number;           // Which runner (tool) we're on
  modelIndices?: Record<string, number>; // runner name -> current model index
  // Model performance tracking - which models work well for this project
  modelPerformance?: ModelPerformance;   // "tool/model" -> stats
  // Per-issue attempt tracking - what's been tried on each issue
  issueAttempts?: IssueAttempts;         // commentId -> attempts
  /** Per-issue count of verifier rejections; dismiss after VERIFIER_REJECTION_DISMISS_THRESHOLD. WHY: avoid fixer/verifier stalemate token waste. */
  verifierRejectionCount?: Record<string, number>;
  /** Per-comment count of "tool modified wrong files" lessons; dismiss after WRONG_FILE_EXHAUST_THRESHOLD. WHY: cross-file fixes (e.g. fix in commit.ts but comment on git-push.ts) burn all models. */
  wrongFileLessonCountByCommentId?: Record<string, number>;
  /** Per-comment count of WRONG_LOCATION/UNCLEAR results; dismiss after WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD. WHY: repeated snippet/context failures burn models. */
  wrongLocationUnclearCountByCommentId?: Record<string, number>;
  /** Per-comment last result detail (normalized, ~120 chars) for UNCLEAR/WRONG_LOCATION. Used to detect "same explanation" for consecutive exhaust. */
  wrongLocationUnclearLastDetailByCommentId?: Record<string, string>;
  /** Per-comment consecutive count of same detail; when >= threshold, mark as remaining. */
  wrongLocationUnclearConsecutiveSameByCommentId?: Record<string, number>;
  /** Per-comment ALREADY_FIXED consecutive same explanation; when >= ALREADY_FIXED_EXHAUST_THRESHOLD, dismiss as not-an-issue. */
  alreadyFixedConsecutiveSameByCommentId?: Record<string, number>;
  /** Per-comment last ALREADY_FIXED detail (normalized) for same-explanation detection. */
  alreadyFixedLastDetailByCommentId?: Record<string, string>;
  /**
   * Per-comment consecutive ALREADY_FIXED count regardless of explanation text.
   * WHY: The same-explanation counter (alreadyFixedConsecutiveSameByCommentId) misses the
   * pattern where 3+ different models independently agree the issue is resolved with
   * different wording. This counter tracks any ALREADY_FIXED result. Resets when fixer
   * makes changes (streak broken) or issue is verified fixed.
   */
  consecutiveAlreadyFixedAnyByCommentId?: Record<string, number>;
  /** Per-comment count of "could not inject file from repo" + no-change cycles; dismiss as file-unchanged after threshold (output.log audit H2). */
  couldNotInjectCountByCommentId?: Record<string, number>;
  /** Per-comment count of verifier verdicts saying "delete entirely" / "remove from repo". Dismiss after threshold so we don't burn iterations when fixer keeps emptying files instead of deleting (Cycle 13 M2). */
  deleteEntirelyVerdictCountByCommentId?: Record<string, number>;
  /** Per-comment count of CANNOT_FIX results citing missing/placeholder file content. WHY: audit showed 10+ retries on placeholder files burning 500K+ tokens. */
  cannotFixMissingContentCountByCommentId?: Record<string, number>;
  /** Per-comment consecutive CANNOT_FIX count (any reason); when >= CANNOT_FIX_EXHAUST_THRESHOLD, dismiss as not-an-issue. */
  cannotFixConsecutiveByCommentId?: Record<string, number>;
  /**
   * Per-comment additional paths the fixer said the fix belongs in (from CANNOT_FIX/WRONG_LOCATION).
   * Merged into allowedPaths on next attempt so we relax "only modify this file" and let the fixer edit the correct file.
   * WHY: Prompts.log audit showed 7 identical 33k-char prompts for git-push.ts:42 (fix in commit.ts); persisting
   * the other file and allowing it on retry avoids burning models and can resolve the issue.
   */
  wrongFileAllowedPathsByCommentId?: Record<string, string[]>;
  /**
   * When fixer returns WRONG_LOCATION with "snippet not visible" / "truncated" / "doesn't exist",
   * we request a wider snippet on the next single-issue attempt so the fixer sees the relevant code.
   */
  widerSnippetRequestedByCommentId?: Record<string, boolean>;
  // Bail-out tracking - document when/why automation stopped
  bailOutRecord?: BailOutRecord;         // Last bail-out event
  noProgressCycles?: number;             // Cycles completed with zero progress (persisted for resume)
  /** When a review bot was last detected as rate-limited (bot name -> ISO timestamp). Used to short-wait on next run. */
  botRateLimitDetectedAt?: Record<string, string>;
  /**
   * LLM dedup cache: keyed by sorted comment ID set; stores duplicateMap and dedupedIds.
   * WHY: Repeat runs with the same comments (e.g. re-run or next push iteration) can skip the dedup LLM step
   * and reuse this grouping, saving tokens and latency. Previously in-memory cache reset each run.
   */
  dedupCache?: {
    commentIds: string;
    duplicateMap: Record<string, string[]>;
    dedupedIds: string[];
  };
  // Cumulative stats across all sessions
  totalTimings?: Record<string, number>;  // phase -> total ms
  totalTokenUsage?: TokenUsageRecord[];   // token usage per phase
}

export function createInitialState(pr: string, branch: string, headSha: string): ResolverState {
  return {
    pr,
    branch,
    headSha,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    iterations: [],
    lessonsLearned: [],
    verifiedFixed: [],
    verifiedComments: [],
    dismissedIssues: [],
    commentStatuses: {},
    modelPerformance: {},
    issueAttempts: {},
    noProgressCycles: 0,
    totalTimings: {},
    totalTokenUsage: [],
  };
}
