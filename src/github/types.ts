export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  branch: string;
  baseBranch: string;
  headSha: string;
  cloneUrl: string;
  mergeable: boolean | null;  // null = GitHub is still calculating
  mergeableState: string;     // 'clean', 'dirty', 'blocked', 'unstable', 'unknown'
}

export interface PRStatus {
  // CI checks
  ciState: 'pending' | 'success' | 'failure' | 'error';
  inProgressChecks: string[];
  pendingChecks: string[];
  totalChecks: number;
  completedChecks: number;
  // Bot reviews
  pendingReviewers: string[];
  activelyReviewingBots: string[];  // Bots that posted "reviewing" but no final review yet
  botsWithEyesReaction: string[];   // Bots that reacted with 👀 (working on it)
}

export interface ThreadComment {
  id: string;
  threadId: string;
  author: string;
  body: string;
  path: string;
  line: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  createdAt: string;
  isResolved: boolean;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  isResolved: boolean;
  comments: ThreadComment[];
}

export interface ReviewComment {
  id: string;
  threadId: string;
  author: string;
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
}

export function parsePRUrl(url: string): { owner: string; repo: string; number: number } {
  // Supports formats:
  // https://github.com/owner/repo/pull/123
  // github.com/owner/repo/pull/123
  // owner/repo#123
  
  const fullUrlMatch = url.match(/(?:https?:\/\/)?github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (fullUrlMatch) {
    return {
      owner: fullUrlMatch[1],
      repo: fullUrlMatch[2],
      number: parseInt(fullUrlMatch[3], 10),
    };
  }

  const shorthandMatch = url.match(/^([^\/]+)\/([^#]+)#(\d+)$/);
  if (shorthandMatch) {
    return {
      owner: shorthandMatch[1],
      repo: shorthandMatch[2],
      number: parseInt(shorthandMatch[3], 10),
    };
  }

  throw new Error(`Invalid PR URL format: ${url}. Expected: https://github.com/owner/repo/pull/123 or owner/repo#123`);
}
