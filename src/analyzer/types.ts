import type { ReviewComment } from '../github/types.js';

export interface UnresolvedIssue {
  comment: ReviewComment;
  codeSnippet: string;
  stillExists: boolean;
  explanation: string;
}

export interface FixPrompt {
  prompt: string;
  summary: string;           // Short 1-line description
  detailedSummary: string;   // Multi-line detailed summary for console
  lessonsIncluded: number;   // Number of lessons included in prompt
  issues: UnresolvedIssue[];
}

export interface VerificationResult {
  commentId: string;
  fixed: boolean;
  explanation: string;
}
