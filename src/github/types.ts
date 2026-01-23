export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  branch: string;
  cloneUrl: string;
}

export interface ReviewComment {
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
  comments: ReviewComment[];
}

export interface BotComment {
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
