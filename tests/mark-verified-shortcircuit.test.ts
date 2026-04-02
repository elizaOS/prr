/**
 * markVerified short-circuit: skip redundant updates in the same iteration (pill-output recovery / fix loop).
 */
import { describe, it, expect } from 'vitest';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import * as Verification from '../tools/prr/state/state-verification.js';
import { getState } from '../tools/prr/state/state-context.js';

function makeCtx(partial: Partial<ResolverState>): StateContext {
  const state: ResolverState = {
    pr: 'o/r#1',
    branch: 'main',
    headSha: 'abc',
    startedAt: 's',
    lastUpdated: 'u',
    lessonsLearned: [],
    iterations: partial.iterations ?? [],
    verifiedComments: partial.verifiedComments ?? [],
    verifiedFixed: partial.verifiedFixed ?? [],
    dismissedIssues: partial.dismissedIssues ?? [],
    ...partial,
  } as ResolverState;
  return {
    statePath: '/tmp/test-state',
    state,
    currentPhase: 'test',
  };
}

describe('markVerified short-circuit', () => {
  it('does not refresh timestamp when called twice in the same iteration', () => {
    const iterations = [{ timestamp: 't', commentsAddressed: [], changesMade: [], verificationResults: {} }];
    const ctx = makeCtx({
      iterations,
      verifiedComments: [
        {
          commentId: 'ic_1',
          verifiedAt: '2020-01-01T00:00:00.000Z',
          verifiedAtIteration: 1,
        },
      ],
      verifiedFixed: ['ic_1'],
    });
    const before = getState(ctx).verifiedComments![0]!.verifiedAt;
    Verification.markVerified(ctx, 'ic_1');
    expect(getState(ctx).verifiedComments![0]!.verifiedAt).toBe(before);
  });

  it('still clears dismissed when same iteration but overlap exists', () => {
    const iterations = [{ timestamp: 't', commentsAddressed: [], changesMade: [], verificationResults: {} }];
    const ctx = makeCtx({
      iterations,
      verifiedComments: [
        {
          commentId: 'ic_1',
          verifiedAt: '2020-01-01T00:00:00.000Z',
          verifiedAtIteration: 1,
        },
      ],
      verifiedFixed: ['ic_1'],
      dismissedIssues: [
        {
          commentId: 'ic_1',
          reason: 'x',
          dismissedAt: 'd',
          dismissedAtIteration: 0,
          category: 'stale',
          filePath: 'a.ts',
          line: null,
          commentBody: '',
        },
      ],
    });
    Verification.markVerified(ctx, 'ic_1');
    expect(getState(ctx).dismissedIssues).toHaveLength(0);
  });
});
