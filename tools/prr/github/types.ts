export interface BotResponseTiming {
  botName: string;
  responseCount: number;
  minResponseMs: number;
  avgResponseMs: number;
  maxResponseMs: number;
  responseTimes: Array<{
    commitSha: string;
    commitTime: Date;
    responseTime: Date;
    delayMs: number;
  }>;
}

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  /**
   * PR title and body give fix prompts context about what the PR is trying
   * to accomplish. Without this, the fixer sees individual review comments
   * in isolation and may produce fixes that are technically correct but
   * misaligned with the PR's intent.
   *
   * WHY `body: string` (not `string | null`): GitHub's API returns `null`
   * for PRs with no description. We coerce to `''` at the source (`getPRInfo`)
   * so downstream code never has to null-check.
   */
  title: string;
  body: string;
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
  /** True when the comment was on a line that no longer exists in the current diff (GitHub marks these "Outdated"). */
  isOutdated?: boolean;
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
  /** True when GitHub marks this thread as outdated (line no longer in current diff). Such comments are not shown as unaddressed. */
  outdated?: boolean;
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
