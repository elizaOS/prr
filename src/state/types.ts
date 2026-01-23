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
  interrupted?: boolean;     // True if last run was interrupted
  interruptPhase?: string;   // Phase where interruption occurred
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
    totalTimings: {},
    totalTokenUsage: [],
  };
}
