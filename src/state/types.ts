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
  category: 'already-fixed' | 'not-an-issue' | 'file-unchanged' | 'false-positive' | 'duplicate';
  filePath: string;               // File the comment was about
  line: number | null;            // Line number if specified
  commentBody: string;            // Original review comment text
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
  interrupted?: boolean;     // True if last run was interrupted
  interruptPhase?: string;   // Phase where interruption occurred
  // Tool/model rotation state - persisted so we resume where we left off
  currentRunnerIndex?: number;           // Which runner (tool) we're on
  modelIndices?: Record<string, number>; // runner name -> current model index
  // Model performance tracking - which models work well for this project
  modelPerformance?: ModelPerformance;   // "tool/model" -> stats
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
    modelPerformance: {},
    totalTimings: {},
    totalTokenUsage: [],
  };
}
