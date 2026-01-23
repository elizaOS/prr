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

export interface ResolverState {
  pr: string;
  branch: string;
  startedAt: string;
  lastUpdated: string;
  iterations: Iteration[];
  lessonsLearned: string[];
  verifiedFixed: string[]; // Comment IDs that have been verified as fixed
}

export function createInitialState(pr: string, branch: string): ResolverState {
  return {
    pr,
    branch,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    iterations: [],
    lessonsLearned: [],
    verifiedFixed: [],
  };
}
