/**
 * Regression: printDebugIssueTable must not throw when persisted state omits
 * optional-looking fields (e.g. commentStatuses.explanation) — see value.length crash.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { printDebugIssueTable } from '../tools/prr/workflow/debug-issue-table.js';
import type { ReviewComment } from '../tools/prr/github/types.js';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import type { CommentStatus } from '../tools/prr/state/types.js';

function makeCtx(partial: Partial<ResolverState>): StateContext {
  const state: ResolverState = {
    pr: 'o/r#1',
    branch: 'main',
    headSha: 'abc',
    startedAt: 's',
    lastUpdated: 'u',
    lessonsLearned: [],
    iterations: [
      { timestamp: 't', commentsAddressed: [], changesMade: [], verificationResults: {} },
    ],
    verifiedComments: [],
    verifiedFixed: [],
    dismissedIssues: [],
    commentStatuses: {},
    ...partial,
  } as ResolverState;
  return { statePath: '/tmp/prr-debug-table-test', state, currentPhase: 'test' };
}

const sampleComment: ReviewComment = {
  id: 'PRRC_kw_test1',
  threadId: 'th1',
  author: 'coderabbit',
  body: 'Nit: simplify',
  path: 'src/a.ts',
  line: 10,
  createdAt: '2026-01-01T00:00:00Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printDebugIssueTable', () => {
  it('does not throw when commentStatuses row omits explanation (legacy / partial JSON)', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    const incomplete = {
      status: 'resolved',
      classification: 'stale',
      importance: 1,
      ease: 1,
      filePath: 'src/a.ts',
      fileContentHash: 'deadbeef',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as CommentStatus;

    const ctx = makeCtx({
      commentStatuses: { [sampleComment.id]: incomplete },
    });

    expect(() =>
      printDebugIssueTable('test', [sampleComment], ctx, []),
    ).not.toThrow();

    expect(logs.some((l) => l.includes('resolved/stale'))).toBe(true);
  });

  it('does not throw when comment omits id/path/body (legacy / bad API row)', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    const broken = {
      ...sampleComment,
      id: undefined as unknown as string,
      path: undefined as unknown as string,
      body: undefined,
      line: undefined,
    } as ReviewComment;

    expect(() => printDebugIssueTable('test', [broken], makeCtx({}), [])).not.toThrow();
    expect(logs.some((l) => l.includes('?:?'))).toBe(true);
  });

  it('does not throw when dismissedIssues entry has empty reason', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    const ctx = makeCtx({
      dismissedIssues: [
        {
          commentId: sampleComment.id,
          reason: '',
          dismissedAt: '2026-01-01T00:00:00Z',
          dismissedAtIteration: 1,
          category: 'not-an-issue',
        },
      ],
    });

    expect(() =>
      printDebugIssueTable('test', [sampleComment], ctx, []),
    ).not.toThrow();

    expect(logs.some((l) => l.includes('dismissed/not-an-issue'))).toBe(true);
  });
});
