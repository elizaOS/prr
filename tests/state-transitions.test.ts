/**
 * Invariants for {@link transitionIssue}: mutual exclusion, session set, commentStatuses.
 */
import { describe, it, expect } from 'vitest';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import { transitionIssue } from '../tools/prr/state/state-transitions.js';
import * as Verification from '../tools/prr/state/state-verification.js';
import { getState } from '../tools/prr/state/state-context.js';

function makeCtx(partial: Partial<ResolverState>, session?: Set<string>): StateContext {
  const state: ResolverState = {
    pr: 'o/r#1',
    branch: 'main',
    headSha: 'abc',
    startedAt: 's',
    lastUpdated: 'u',
    lessonsLearned: [],
    iterations: partial.iterations ?? [{ timestamp: 't', commentsAddressed: [], changesMade: [], verificationResults: {} }],
    verifiedComments: partial.verifiedComments ?? [],
    verifiedFixed: partial.verifiedFixed ?? [],
    dismissedIssues: partial.dismissedIssues ?? [],
    commentStatuses: partial.commentStatuses ?? {},
    ...partial,
  } as ResolverState;
  return {
    statePath: '/tmp/test-state',
    state,
    currentPhase: 'test',
    verifiedThisSession: session,
  };
}

function verifiedIds(state: ResolverState): Set<string> {
  const fromLegacy = state.verifiedFixed ?? [];
  const fromNew = state.verifiedComments?.map((v) => v.commentId) ?? [];
  return new Set([...fromLegacy, ...fromNew]);
}

function dismissedIds(state: ResolverState): Set<string> {
  return new Set((state.dismissedIssues ?? []).map((d) => d.commentId));
}

describe('transitionIssue', () => {
  it('keeps verified and dismissed disjoint after verify then dismiss', () => {
    const session = new Set<string>();
    const ctx = makeCtx({}, session);
    Verification.markVerified(ctx, 'ic_1');
    transitionIssue(ctx, 'ic_1', {
      kind: 'dismissed',
      reason: 'r',
      category: 'not-an-issue',
      filePath: 'a.ts',
      line: null,
      commentBody: 'body',
    });
    const st = getState(ctx);
    expect(verifiedIds(st).has('ic_1')).toBe(false);
    expect(dismissedIds(st).has('ic_1')).toBe(true);
    expect(session.has('ic_1')).toBe(false);
  });

  it('adds to verifiedThisSession on verify unless skipSessionTracking', () => {
    const session = new Set<string>();
    const ctx = makeCtx({}, session);
    Verification.markVerified(ctx, 'ic_a');
    expect(session.has('ic_a')).toBe(true);

    const session2 = new Set<string>();
    const ctx2 = makeCtx({}, session2);
    Verification.markVerified(ctx2, 'ic_b', undefined, { skipSessionTracking: true });
    expect(session2.has('ic_b')).toBe(false);
  });

  it('removes from verifiedThisSession on unverified', () => {
    const session = new Set<string>(['ic_x']);
    const ctx = makeCtx(
      {
        verifiedComments: [{ commentId: 'ic_x', verifiedAt: 't', verifiedAtIteration: 0 }],
        verifiedFixed: ['ic_x'],
      },
      session
    );
    Verification.unmarkVerified(ctx, 'ic_x');
    expect(session.has('ic_x')).toBe(false);
    expect(Verification.isVerified(ctx, 'ic_x')).toBe(false);
  });

  it('undismissed removes dismissed row and commentStatuses entry', () => {
    const ctx = makeCtx({
      dismissedIssues: [
        {
          commentId: 'ic_d',
          reason: 'x',
          dismissedAt: 'd',
          dismissedAtIteration: 0,
          category: 'stale',
          filePath: 'f.ts',
          line: null,
          commentBody: '',
        },
      ],
      commentStatuses: {
        ic_d: {
          status: 'resolved',
          classification: 'stale',
          explanation: '',
          importance: 1,
          ease: 1,
          filePath: 'f.ts',
          fileContentHash: 'h',
          updatedAt: 'u',
          updatedAtIteration: 0,
        },
      },
    });
    transitionIssue(ctx, 'ic_d', { kind: 'undismissed' });
    expect(getState(ctx).dismissedIssues).toHaveLength(0);
    expect(getState(ctx).commentStatuses?.ic_d).toBeUndefined();
  });

  it('dismiss is idempotent — second dismiss does not duplicate rows', () => {
    const ctx = makeCtx({});
    const d = {
      kind: 'dismissed' as const,
      reason: 'r',
      category: 'not-an-issue' as const,
      filePath: 'a.ts',
      line: null as number | null,
      commentBody: 'b',
    };
    transitionIssue(ctx, 'ic_dup', d);
    transitionIssue(ctx, 'ic_dup', d);
    expect(getState(ctx).dismissedIssues?.filter((x) => x.commentId === 'ic_dup').length).toBe(1);
  });
});
