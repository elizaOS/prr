import { describe, it, expect } from 'vitest';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import * as Verification from '../tools/prr/state/state-verification.js';
import {
  expandGitRecoveredVerificationFromDedupCache,
  markVerifiedClusterForFixedIssue,
  unmarkVerifiedClusterForStaleRecheck,
  unmarkVerifiedClustersForFinalAuditFailures,
} from '../tools/prr/workflow/duplicate-cluster-verify.js';

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
  return {
    statePath: '/tmp/mark-cluster-test',
    state,
    currentPhase: 'test',
    verifiedThisSession: new Set<string>(),
  };
}

describe('markVerifiedClusterForFixedIssue', () => {
  it('marks anchor and dedup siblings', () => {
    const ctx = makeCtx();
    const session = ctx.verifiedThisSession!;
    const map = new Map<string, string[]>([['c1', ['d1', 'd2']]]);
    const extra = markVerifiedClusterForFixedIssue(ctx, 'd1', map, session);
    expect(extra).toBe(2);
    expect(Verification.isVerified(ctx, 'c1')).toBe(true);
    expect(Verification.isVerified(ctx, 'd1')).toBe(true);
    expect(Verification.isVerified(ctx, 'd2')).toBe(true);
    expect(session.has('c1') && session.has('d1') && session.has('d2')).toBe(true);
  });

  it('is a no-op for unknown id when map missing', () => {
    const ctx = makeCtx();
    const extra = markVerifiedClusterForFixedIssue(ctx, 'solo', undefined, ctx.verifiedThisSession);
    expect(extra).toBe(0);
    expect(Verification.isVerified(ctx, 'solo')).toBe(true);
  });
});

describe('expandGitRecoveredVerificationFromDedupCache', () => {
  it('marks dedup siblings when dedupCache matches comment set', () => {
    const ctx = makeCtx();
    const key = ['c1', 'd1', 'd2'].sort().join(',');
    ctx.state!.dedupCache = {
      commentIds: key,
      schema: 'dedup-v2',
      duplicateMap: { c1: ['d1', 'd2'] },
      dedupedIds: ['c1'],
    };
    Verification.markVerified(ctx, 'c1', Verification.PRR_GIT_RECOVERY_VERIFIED_MARKER, {
      skipSessionTracking: true,
    });
    const { staleSkipIds, addedVerified } = expandGitRecoveredVerificationFromDedupCache(ctx, ['c1'], key);
    expect(addedVerified).toBe(true);
    expect(new Set(staleSkipIds)).toEqual(new Set(['c1', 'd1', 'd2']));
    expect(Verification.isVerified(ctx, 'd1')).toBe(true);
    expect(Verification.isVerified(ctx, 'd2')).toBe(true);
  });

  it('does not expand when dedupCache commentIds differ', () => {
    const ctx = makeCtx();
    ctx.state!.dedupCache = {
      commentIds: 'other',
      schema: 'dedup-v2',
      duplicateMap: { c1: ['d1'] },
      dedupedIds: ['c1'],
    };
    Verification.markVerified(ctx, 'c1', Verification.PRR_GIT_RECOVERY_VERIFIED_MARKER, {
      skipSessionTracking: true,
    });
    const { staleSkipIds, addedVerified } = expandGitRecoveredVerificationFromDedupCache(ctx, ['c1'], 'c1');
    expect(addedVerified).toBe(false);
    expect(staleSkipIds).toEqual(['c1']);
    expect(Verification.isVerified(ctx, 'd1')).toBe(false);
  });
});

describe('unmarkVerifiedClusterForStaleRecheck', () => {
  it('unmarks every verified id in the cluster', () => {
    const ctx = makeCtx();
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    markVerifiedClusterForFixedIssue(ctx, 'c1', map, ctx.verifiedThisSession);
    expect(Verification.isVerified(ctx, 'c1')).toBe(true);
    expect(Verification.isVerified(ctx, 'd1')).toBe(true);
    unmarkVerifiedClusterForStaleRecheck(ctx, 'd1', map, undefined);
    expect(Verification.isVerified(ctx, 'c1')).toBe(false);
    expect(Verification.isVerified(ctx, 'd1')).toBe(false);
  });

  it('skips unmark for ids in recoveredSet only', () => {
    const ctx = makeCtx();
    const map = new Map<string, string[]>([['c1', ['d1', 'd2']]]);
    markVerifiedClusterForFixedIssue(ctx, 'c1', map, ctx.verifiedThisSession);
    unmarkVerifiedClusterForStaleRecheck(ctx, 'c1', map, new Set(['c1']));
    expect(Verification.isVerified(ctx, 'c1')).toBe(true);
    expect(Verification.isVerified(ctx, 'd1')).toBe(false);
    expect(Verification.isVerified(ctx, 'd2')).toBe(false);
  });
});

describe('unmarkVerifiedClustersForFinalAuditFailures', () => {
  it('unmarks canonical when only duplicate id is listed as failed', () => {
    const ctx = makeCtx();
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    markVerifiedClusterForFixedIssue(ctx, 'c1', map, ctx.verifiedThisSession);
    unmarkVerifiedClustersForFinalAuditFailures(ctx, ['d1'], map);
    expect(Verification.isVerified(ctx, 'c1')).toBe(false);
    expect(Verification.isVerified(ctx, 'd1')).toBe(false);
  });

  it('dedupes when two failed rows are in the same cluster', () => {
    const ctx = makeCtx();
    const map = new Map<string, string[]>([['c1', ['d1']]]);
    markVerifiedClusterForFixedIssue(ctx, 'c1', map, ctx.verifiedThisSession);
    unmarkVerifiedClustersForFinalAuditFailures(ctx, ['c1', 'd1'], map);
    expect(Verification.isVerified(ctx, 'c1')).toBe(false);
    expect(Verification.isVerified(ctx, 'd1')).toBe(false);
  });
});
