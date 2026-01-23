import type { BotComment } from '../github/types.js';

export interface UnresolvedIssue {
  comment: BotComment;
  codeSnippet: string;
  stillExists: boolean;
  explanation: string;
}

export interface FixPrompt {
  prompt: string;
  issues: UnresolvedIssue[];
}

export interface VerificationResult {
  commentId: string;
  fixed: boolean;
  explanation: string;
}
