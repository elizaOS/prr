import type { ReviewComment } from '../github/types.js';

/**
 * Triage scores from LLM analysis (1-5 scale).
 * 
 * WHY: The analysis phase already asks the LLM "does this issue still exist?"
 * for every comment. We piggyback importance + difficulty assessment onto the
 * same call at zero extra cost, then use these scores to prioritize fixes.
 */
export interface IssueTriage {
  /** 1=critical/security, 2=major bug, 3=moderate, 4=minor, 5=trivial/style */
  importance: number;
  /** 1=one-line fix, 2=simple, 3=moderate, 4=complex multi-file, 5=major refactor */
  ease: number;
}

export interface UnresolvedIssue {
  comment: ReviewComment;
  codeSnippet: string;
  stillExists: boolean;
  explanation: string;
  /**
   * Optional triage scores from LLM analysis.
   * 
   * WHY optional: There are 11 places that construct UnresolvedIssue objects.
   * Making this required would break all of them simultaneously. Optional means
   * the type system accepts objects without triage, and we can add it incrementally.
   */
  triage?: IssueTriage;
  /**
   * Comments that were identified as duplicates of this issue and merged in.
   * Only populated when deduplication identifies this as a canonical issue.
   */
  mergedDuplicates?: Array<{
    commentId: string;
    author: string;
    body: string;
    path: string;
    line: number | null;
  }>;
  /**
   * When the fixer claims ALREADY_FIXED but the verifier disagrees, the
   * verifier's explanation is stored here so the next fixer attempt sees
   * exactly *where* the issue still exists (specific line, specific code).
   * Prevents the fixer/verifier stalemate where they look at different lines.
   */
  verifierContradiction?: string;
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
