import { describe, it, expect } from 'vitest';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import type { ReviewComment } from '../tools/prr/github/types.js';
import * as Dismissed from '../tools/prr/state/state-dismissed.js';
import {
  buildMergedDuplicatesForAnchor,
  dismissDuplicateCluster,
  dismissDuplicateClusterFromComments,
  getPersistedDedupMapForCommentSet,
  propagateStatusToDuplicates,
  resolveDuplicateMapForRecovery,
  resolveEffectiveDuplicateMapForComments,
  mergeCommentsForClusterDismiss,
  getClusterIdsAccountedOnState,
  type DedupResult,
} from '../tools/prr/workflow/issue-analysis-dedup.js';
import * as CommentStatus from '../tools/prr/state/state-comment-status.js';

function review(id: string, path: string): ReviewComment {
  return {
    id,
    threadId: 't1',
    author: 'bot',
    body: `body ${id}`,
    path,
    line: 1,
    createdAt: '2020-01-01T00:00:00Z',
  };
}

function makeCtx(): StateContext {
  const state: ResolverState = {
    pr: 'o/r#1',
    branch: 'main',
    headSha: 'abc',
    startedAt: 's',
    lastUpdated: 'u',
    lessonsLearned: [],
    iterations: [{ timestamp: 't', commentsAddressed: [], changesMade: [], verificationResults: {} }],
    verifiedComments: [],
    verifiedFixed: [],
    dismissedIssues: [],
    commentStatuses: {},
  } as ResolverState;
  return { statePath: '/tmp/dismiss-cluster-test', state, currentPhase: 'test' };
}

describe('dismissDuplicateCluster', () => {
  it('dismisses anchor and all dedup siblings with per-comment paths', () => {
    const ctx = makeCtx();
    const anchor = review('c1', 'a.ts');
    const dup = review('d1', 'b.ts');
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    const duplicateItems = new Map([
      [
        'd1',
        {
          comment: dup,
          codeSnippet: '',
        },
      ],
    ]);

    dismissDuplicateCluster(ctx, anchor, map, duplicateItems, 'same issue', 'stale');

    expect(Dismissed.isCommentDismissed(ctx, 'c1')).toBe(true);
    expect(Dismissed.isCommentDismissed(ctx, 'd1')).toBe(true);
    const d1 = Dismissed.getDismissedIssue(ctx, 'd1');
    expect(d1?.filePath).toBe('b.ts');
  });
});

describe('getPersistedDedupMapForCommentSet', () => {
  it('returns duplicate map when cache key and schema match', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'a,b',
      schema: 'dedup-v2',
      duplicateMap: { a: ['b'] },
      dedupedIds: ['a'],
    };
    const m = getPersistedDedupMapForCommentSet(ctx, 'a,b');
    expect(m?.get('a')).toEqual(['b']);
  });

  it('returns undefined when comment id key differs', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'x',
      schema: 'dedup-v2',
      duplicateMap: { x: [] },
      dedupedIds: ['x'],
    };
    expect(getPersistedDedupMapForCommentSet(ctx, 'a,b')).toBeUndefined();
  });
});

describe('resolveEffectiveDuplicateMapForComments', () => {
  it('returns in-memory map when non-empty', () => {
    const ctx = makeCtx();
    const mem = new Map<string, string[]>([['a', ['b']]]);
    const a = review('a', 'x.ts');
    const b = review('b', 'y.ts');
    expect(resolveEffectiveDuplicateMapForComments(ctx, mem, [a, b])).toBe(mem);
  });

  it('falls back to persisted cache when duplicateMap is empty', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'a,b',
      schema: 'dedup-v2',
      duplicateMap: { a: ['b'] },
      dedupedIds: ['a'],
    };
    const a = review('a', 'x.ts');
    const b = review('b', 'y.ts');
    const empty = new Map<string, string[]>();
    const eff = resolveEffectiveDuplicateMapForComments(ctx, empty, [a, b]);
    expect(eff?.get('a')).toEqual(['b']);
  });

  it('returns undefined when no map and no matching cache', () => {
    const ctx = makeCtx();
    const a = review('a', 'x.ts');
    expect(resolveEffectiveDuplicateMapForComments(ctx, undefined, [a])).toBeUndefined();
  });
});

describe('resolveDuplicateMapForRecovery', () => {
  it('uses persisted cache when session map is empty and allComments omitted', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'a,b',
      schema: 'dedup-v2',
      duplicateMap: { a: ['b'] },
      dedupedIds: ['a'],
    };
    const m = resolveDuplicateMapForRecovery(ctx, undefined, undefined);
    expect(m?.get('a')).toEqual(['b']);
  });

  it('does not use persisted cache when allComments key disagrees with cache', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'a,b',
      schema: 'dedup-v2',
      duplicateMap: { a: ['b'] },
      dedupedIds: ['a'],
    };
    const x = review('x', 'z.ts');
    const m = resolveDuplicateMapForRecovery(ctx, undefined, [x]);
    expect(m).toBeUndefined();
  });
});

describe('buildMergedDuplicatesForAnchor', () => {
  it('uses effective cluster when duplicateMap empty and dedup cache matches', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'a,b',
      schema: 'dedup-v2',
      duplicateMap: { a: ['b'] },
      dedupedIds: ['a'],
    };
    const a = review('a', 'x.ts');
    const b = review('b', 'y.ts');
    const eff = resolveEffectiveDuplicateMapForComments(ctx, new Map(), [a, b]);
    const rows = buildMergedDuplicatesForAnchor('a', eff, new Map(), [a, b]);
    expect(rows).toEqual([expect.objectContaining({ commentId: 'b', path: 'y.ts' })]);
  });

  it('prefers duplicateItems over allComments when both exist', () => {
    const a = review('a', 'x.ts');
    const b = review('b', 'from-comments.ts');
    const map = new Map<string, string[]>([['a', ['b']]]);
    const duplicateItems: DedupResult['duplicateItems'] = new Map([
      [
        'b',
        {
          comment: { ...b, path: 'from-dedup-item.ts' },
          codeSnippet: '',
        },
      ],
    ]);
    const rows = buildMergedDuplicatesForAnchor('a', map, duplicateItems, [a, b]);
    expect(rows?.[0]?.path).toBe('from-dedup-item.ts');
  });
});

describe('propagateStatusToDuplicates', () => {
  it('propagates to canonical when the analyzed row is a duplicate (map keyed by canonical)', () => {
    const ctx = makeCtx();
    const c = review('c1', 'a.ts');
    const d = review('d1', 'b.ts');
    const dedupResult: DedupResult = {
      dedupedToCheck: [],
      duplicateMap: new Map([['c1', ['d1']]]),
      duplicateItems: new Map([
        ['c1', { comment: c, codeSnippet: '' }],
        ['d1', { comment: d, codeSnippet: '' }],
      ]),
    };
    const hashes = new Map([
      ['a.ts', 'ha'],
      ['b.ts', 'hb'],
    ]);
    CommentStatus.markOpen(ctx, 'd1', 'exists', 'dup analyzed', 2, 2, 'b.ts', 'hb');
    propagateStatusToDuplicates(
      ctx,
      'd1',
      dedupResult,
      hashes,
      { kind: 'open', classification: 'exists', explanation: 'dup analyzed', importance: 2, ease: 2 },
      [c, d],
    );
    expect(CommentStatus.getStatus(ctx, 'c1')?.status).toBe('open');
    expect(CommentStatus.getStatus(ctx, 'c1')?.filePath).toBe('a.ts');
  });

  it('uses persisted dedup cache when duplicateMap is empty', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'a,b',
      schema: 'dedup-v2',
      duplicateMap: { a: ['b'] },
      dedupedIds: ['a'],
    };
    const a = review('a', 'x.ts');
    const b = review('b', 'y.ts');
    const dedupResult: DedupResult = {
      dedupedToCheck: [],
      duplicateMap: new Map(),
      duplicateItems: new Map(),
    };
    const hashes = new Map([
      ['x.ts', 'hx'],
      ['y.ts', 'hy'],
    ]);
    CommentStatus.markResolved(ctx, 'a', 'fixed', 'done', 'x.ts', 'hx');
    propagateStatusToDuplicates(
      ctx,
      'a',
      dedupResult,
      hashes,
      { kind: 'resolved', classification: 'fixed', explanation: 'done' },
      [a, b],
    );
    expect(CommentStatus.getStatus(ctx, 'b')?.status).toBe('resolved');
    expect(CommentStatus.getStatus(ctx, 'b')?.filePath).toBe('y.ts');
  });
});

describe('mergeCommentsForClusterDismiss', () => {
  it('returns batch issue comments when allComments is undefined', () => {
    const a = review('a', 'x.ts');
    const b = review('b', 'y.ts');
    const merged = mergeCommentsForClusterDismiss(undefined, [
      { comment: a, codeSnippet: '', stillExists: true, explanation: '' },
      { comment: b, codeSnippet: '', stillExists: true, explanation: '' },
    ]);
    expect(merged.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('prefers allComments row over batch when same id', () => {
    const fromList = review('a', 'from-list.ts');
    const fromBatch = review('a', 'from-batch.ts');
    const merged = mergeCommentsForClusterDismiss([fromList], [{ comment: fromBatch, codeSnippet: '', stillExists: true, explanation: '' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.path).toBe('from-list.ts');
  });
});

describe('pre-dismiss queue removal (execute-fix-iteration contract)', () => {
  it('only cluster ids that were actually dismissed count for queue eviction', () => {
    const ctx = makeCtx();
    const anchor = review('c1', 'a.ts');
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    dismissDuplicateClusterFromComments(ctx, anchor, map, [anchor], 'r', 'remaining');
    expect(Dismissed.isCommentDismissed(ctx, 'c1')).toBe(true);
    expect(Dismissed.isCommentDismissed(ctx, 'd1')).toBe(false);
    expect(getClusterIdsAccountedOnState(ctx, 'c1', map).sort()).toEqual(['c1']);
  });
});

describe('dismissDuplicateClusterFromComments', () => {
  it('resolves siblings from allComments list', () => {
    const ctx = makeCtx();
    const anchor = review('c1', 'a.ts');
    const dup = review('d1', 'b.ts');
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    const all = [anchor, dup];

    dismissDuplicateClusterFromComments(ctx, anchor, map, all, 'r', 'stale');

    expect(Dismissed.isCommentDismissed(ctx, 'c1')).toBe(true);
    expect(Dismissed.isCommentDismissed(ctx, 'd1')).toBe(true);
  });

  it('dismisses cluster siblings from merge(batch) when PR list is absent', () => {
    const ctx = makeCtx();
    const anchor = review('c1', 'a.ts');
    const dup = review('d1', 'b.ts');
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    const batchIssues = [
      { comment: anchor, codeSnippet: '', stillExists: true, explanation: '' },
      { comment: dup, codeSnippet: '', stillExists: true, explanation: '' },
    ];
    const rows = mergeCommentsForClusterDismiss(undefined, batchIssues);
    dismissDuplicateClusterFromComments(ctx, anchor, map, rows, 'r', 'stale');
    expect(Dismissed.isCommentDismissed(ctx, 'c1')).toBe(true);
    expect(Dismissed.isCommentDismissed(ctx, 'd1')).toBe(true);
  });
});
