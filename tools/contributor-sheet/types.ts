/**
 * Shared types for contributor-sheet (avoids circular imports between fetch modules).
 */

export interface ThreadComment {
  kind: 'issue' | 'review_inline' | 'review_submitted';
  author: string;
  createdAt: string;
  body: string;
  path?: string;
  line?: number | null;
}

export interface PrDeepDetails {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  issueComments: ThreadComment[];
  reviewInline: ThreadComment[];
  reviewSubmitted: ThreadComment[];
}

export interface AuthorPrRow {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  merged: boolean;
  draft?: boolean;
  /** Present when per-PR detail fetch ran for this row. */
  details?: PrDeepDetails;
}
