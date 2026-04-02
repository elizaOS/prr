/**
 * Mock GitHub API for testing
 */

import { vi } from 'vitest';
import type { GitHubAPI } from '../../tools/prr/github/api.js';
import type { ReviewComment, PRInfo } from '../../tools/prr/github/types.js';

export interface MockGitHubAPIOptions {
  prInfo?: PRInfo;
  comments?: ReviewComment[];
  commits?: Array<{ sha: string; message: string; authoredDate: Date }>;
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  status?: {
    state: string;
    statuses: Array<{ state: string; context: string }>;
  };
}

export function createMockGitHubAPI(options: MockGitHubAPIOptions = {}): GitHubAPI {
  const defaultPrInfo: PRInfo = {
    owner: 'test-org',
    repo: 'test-repo',
    number: 1,
    title: 'Test PR',
    body: '',
    branch: 'feature',
    baseBranch: 'main',
    headSha: 'abc123',
    cloneUrl: 'https://github.com/test-org/test-repo.git',
    mergeable: true,
    mergeableState: 'clean',
  };

  const prInfo = options.prInfo || defaultPrInfo;
  const comments = options.comments || [];
  const commits = options.commits || [];
  const files = options.files || [];

  return {
    getPRInfo: vi.fn(async () => prInfo),
    getReviewComments: vi.fn(async () => comments),
    getPRCommits: vi.fn(async () => commits),
    getPRFiles: vi.fn(async () => files),
    getPRStatus: vi.fn(async () => options.status || { state: 'success', statuses: [] }),
    replyToReviewThread: vi.fn(async () => {}),
    resolveReviewThread: vi.fn(async () => {}),
    getThreadComments: vi.fn(async () => []),
    createPR: vi.fn(async () => ({ number: 1, url: 'https://github.com/test/test/pull/1' })),
    getOpenPRs: vi.fn(async () => []),
    getRecentPRTitles: vi.fn(async () => []),
    getPRFilesWithPatches: vi.fn(async () => files.map(f => ({ ...f, patch: '' }))),
    getBranchCommitHistory: vi.fn(async () => commits),
    getBranchComparison: vi.fn(async () => ({ commits, files })),
  } as unknown as GitHubAPI;
}
