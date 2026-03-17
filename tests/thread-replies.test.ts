import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postThreadReplies, type PostThreadRepliesOptions, type PostThreadRepliesResult } from '../tools/prr/workflow/thread-replies.js';
import type { GitHubAPI } from '../tools/prr/github/api.js';
import type { ReviewComment, PRInfo } from '../tools/prr/github/types.js';
import type { DismissedIssue } from '../tools/prr/state/types.js';

const defaultPrInfo: PRInfo = {
  owner: 'o',
  repo: 'r',
  number: 1,
  title: 'Test',
  body: '',
  branch: 'main',
  baseBranch: 'base',
  headSha: 'abc1234567',
  cloneUrl: 'https://github.com/o/r',
  mergeable: true,
  mergeableState: 'clean',
};

function makeComment(id: string, threadId: string, databaseId: number | null): ReviewComment {
  return {
    id,
    threadId,
    author: 'reviewer',
    body: 'Fix this',
    path: 'src/foo.ts',
    line: 10,
    createdAt: '2025-01-01T00:00:00Z',
    databaseId: databaseId ?? undefined,
  };
}

function makeDismissed(commentId: string, category: DismissedIssue['category'], reason: string): DismissedIssue {
  return {
    commentId,
    reason,
    dismissedAt: '2025-01-01T00:00:00Z',
    dismissedAtIteration: 1,
    category,
    filePath: 'src/foo.ts',
    line: 10,
    commentBody: 'Fix this',
  };
}

describe('postThreadReplies', () => {
  let replyCalls: Array<{ commentId: number; body: string }>;
  let resolveCalls: string[];
  let getThreadCommentsCalls: string[];
  let getThreadCommentsMap: Map<string, Array<{ author: string }>>;
  let mockGithub: GitHubAPI;

  beforeEach(() => {
    replyCalls = [];
    resolveCalls = [];
    getThreadCommentsCalls = [];
    getThreadCommentsMap = new Map();
    mockGithub = {
      replyToReviewThread: vi.fn(async (_o, _r, _pr, commentId: number, body: string) => {
        replyCalls.push({ commentId, body });
      }),
      getThreadComments: vi.fn(async (_o, _repo, _pr, threadId: string) => {
        getThreadCommentsCalls.push(threadId);
        return getThreadCommentsMap.get(threadId) ?? [];
      }),
      resolveReviewThread: vi.fn(async (_o, _r, threadId: string) => {
        resolveCalls.push(threadId);
      }),
    } as unknown as GitHubAPI;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function run(opts: Partial<PostThreadRepliesOptions> & { replyToThreads: boolean }): Promise<PostThreadRepliesResult | void> {
    return postThreadReplies({
      comments: opts.comments ?? [],
      verifiedCommentIds: opts.verifiedCommentIds ?? new Set(),
      dismissedIssues: opts.dismissedIssues ?? [],
      commitSha: opts.commitSha ?? 'abc1234567890',
      repliedThreadIds: opts.repliedThreadIds ?? new Set(),
      github: opts.github ?? mockGithub,
      prInfo: opts.prInfo ?? defaultPrInfo,
      replyToThreads: opts.replyToThreads,
      resolveThreads: opts.resolveThreads ?? false,
    });
  }

  it('does nothing when replyToThreads is false', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: false,
      comments,
      verifiedCommentIds: new Set(['c1']),
    });
    expect(replyCalls).toHaveLength(0);
    expect(mockGithub.replyToReviewThread).not.toHaveBeenCalled();
  });

  it('posts fixed-in reply for verified comment and uses short sha', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
      commitSha: 'abcdef0123456789',
    });
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]).toEqual({ commentId: 100, body: 'Fixed in `abcdef0`.' });
  });

  it('skips threads already in repliedThreadIds (in-run idempotency)', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    const repliedThreadIds = new Set<string>(['thread-1']);
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
      repliedThreadIds,
    });
    expect(replyCalls).toHaveLength(0);
  });

  it('skips issue-comment threads (ic-*)', async () => {
    const comments = [makeComment('ic-1', 'ic-issue', 99)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['ic-1']),
    });
    expect(replyCalls).toHaveLength(0);
  });

  it('skips comments without databaseId', async () => {
    const comments = [makeComment('c1', 'thread-1', null)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
    });
    expect(replyCalls).toHaveLength(0);
  });

  it('posts already-fixed dismissed reply with expected body', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(),
      dismissedIssues: [makeDismissed('c1', 'already-fixed', 'Done before.')],
    });
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0].body).toBe('No changes needed — already addressed before this run.');
  });

  it('posts dismissed reply for other reply-eligible categories with reason', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      dismissedIssues: [makeDismissed('c1', 'not-an-issue', 'Intentional design.')],
    });
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0].body).toBe('Dismissed: Intentional design.');
  });

  it('posts "Could not auto-fix" reply for exhausted or remaining categories', async () => {
    const comments = [
      makeComment('c1', 'thread-1', 100),
      makeComment('c2', 'thread-2', 101),
    ];
    const expectedBody = 'Could not auto-fix (wrong file or repeated failures); manual review recommended.';
    await run({
      replyToThreads: true,
      comments,
      dismissedIssues: [
        makeDismissed('c1', 'exhausted', 'Max attempts.'),
        makeDismissed('c2', 'remaining', 'Manual follow-up.'),
      ],
    });
    expect(replyCalls).toHaveLength(2);
    expect(replyCalls[0].body).toBe(expectedBody);
    expect(replyCalls[1].body).toBe(expectedBody);
  });

  it('calls resolveReviewThread when resolveThreads is true after replying', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
      resolveThreads: true,
    });
    expect(replyCalls).toHaveLength(1);
    expect(resolveCalls).toEqual(['thread-1']);
  });

  it('does not call resolveReviewThread when resolveThreads is false', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
      resolveThreads: false,
    });
    expect(resolveCalls).toHaveLength(0);
  });

  it('skips reply when PRR_BOT_LOGIN is set and thread already has bot comment (cross-run idempotency)', async () => {
    vi.stubEnv('PRR_BOT_LOGIN', 'prr-bot');
    getThreadCommentsMap.set('thread-1', [{ author: 'reviewer' }, { author: 'prr-bot' }]);
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
    });
    expect(replyCalls).toHaveLength(0);
    expect(getThreadCommentsCalls).toContain('thread-1');
  });

  it('posts reply when PRR_BOT_LOGIN is set but thread has no bot comment yet', async () => {
    vi.stubEnv('PRR_BOT_LOGIN', 'prr-bot');
    getThreadCommentsMap.set('thread-1', [{ author: 'reviewer' }]);
    const comments = [makeComment('c1', 'thread-1', 100)];
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
    });
    expect(replyCalls).toHaveLength(1);
  });

  it('adds thread to repliedThreadIds after successful reply', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    const repliedThreadIds = new Set<string>();
    await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
      repliedThreadIds,
    });
    expect(repliedThreadIds.has('thread-1')).toBe(true);
  });

  it('truncates long dismissal reason with oneLine', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    const longReason = 'A'.repeat(250);
    await run({
      replyToThreads: true,
      comments,
      dismissedIssues: [makeDismissed('c1', 'false-positive', longReason)],
    });
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0].body).toMatch(/^Dismissed: .{197}\.\.\.$/);
  });

  it('returns { attempted, replied } when replyToThreads is true', async () => {
    const comments = [makeComment('c1', 'thread-1', 100)];
    const result = await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
    });
    expect(result).toEqual({ attempted: 1, replied: 1 });
  });

  it('returns undefined when replyToThreads is false', async () => {
    const result = await run({ replyToThreads: false });
    expect(result).toBeUndefined();
  });

  it('returns attempted > 0 and replied === 0 when all replies fail with 422', async () => {
    const err422 = Object.assign(new Error('Validation Failed'), { status: 422 });
    const replyMock = vi.fn(async () => {
      throw err422;
    });
    mockGithub.replyToReviewThread = replyMock;
    const comments = [
      makeComment('c1', 'thread-1', 100),
      makeComment('c2', 'thread-2', 101),
    ];
    const result = await run({
      replyToThreads: true,
      comments,
      verifiedCommentIds: new Set(['c1']),
      dismissedIssues: [makeDismissed('c2', 'already-fixed', 'Done.')],
    });
    expect(result).toEqual({ attempted: 2, replied: 0 });
    expect(replyMock).toHaveBeenCalledTimes(4);
  });
});
