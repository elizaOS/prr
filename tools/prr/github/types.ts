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

/**
 * Parse a branch spec (repo + branch). Returns null if input does not match.
 * Supports: owner/repo@branch, owner/repo:branch, https://github.com/owner/repo/tree/branch
 * WHY tree URL: Users paste browser URLs; accepting tree URL avoids "invalid input" and we pass only branch name to the API.
 * WHY strip query/fragment and trailing slash: Clean branch name; GitHub API expects ref name without URL cruft.
 */
export function parseBranchSpec(input: string): { owner: string; repo: string; branch: string } | null {
  const trimmed = input.trim();
  const shorthandAt = trimmed.match(/^([^\/]+)\/([^@:]+)@([^@]+)$/);
  if (shorthandAt) {
    return { owner: shorthandAt[1], repo: shorthandAt[2], branch: shorthandAt[3] };
  }
  const shorthandColon = trimmed.match(/^([^\/]+)\/([^@:]+):([^@:]+)$/);
  if (shorthandColon) {
    return { owner: shorthandColon[1], repo: shorthandColon[2], branch: shorthandColon[3] };
  }
  const treeMatch = trimmed.match(/(?:https?:\/\/)?github\.com\/([^\/]+)\/([^\/]+)\/tree\/(.+?)(?:[?#]|$)/);
  if (treeMatch) {
    const branch = treeMatch[3].replace(/\/+$/, '').trim();
    if (branch) {
      return { owner: treeMatch[1], repo: treeMatch[2], branch };
    }
  }
  return null;
}

/**
 * Normalize a --compare value to a branch name for the GitHub API.
 * Accepts: plain branch name (e.g. v1-develop), owner/repo@branch, or tree URL.
 * When currentOwner/currentRepo are set, parsed repo must match (same-repo comparison only).
 * WHY: Compare API expects ref names; passing a tree URL as ref causes 404. We parse and pass only the branch name.
 */
export function normalizeCompareBranch(
  value: string,
  currentOwner?: string,
  currentRepo?: string
): string {
  const trimmed = value.trim();
  const parsed = parseBranchSpec(trimmed);
  if (parsed) {
    if (currentOwner != null && currentRepo != null && (parsed.owner !== currentOwner || parsed.repo !== currentRepo)) {
      throw new Error(
        `--compare repo (${parsed.owner}/${parsed.repo}) does not match branch repo (${currentOwner}/${currentRepo}). Use the same repository.`
      );
    }
    return parsed.branch;
  }
  if (!/github\.com|@|^[^\/]+\/[^\/]+:/.test(trimmed)) {
    return trimmed;
  }
  throw new Error(
    `Invalid --compare value: "${value}". Use a branch name (e.g. v1-develop), owner/repo@branch, or a tree URL.`
  );
}
