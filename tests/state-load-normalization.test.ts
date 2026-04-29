import { describe, expect, it } from 'vitest';
import type { DismissedIssue, ResolverState } from '../tools/prr/state/types.js';
import {
  applyResolverStateLoadCoreNormalization,
  applyResolverStatePostOverlapCleanup,
  assertNoVerifiedDismissedOverlapOrThrow,
  getVerifiedDismissedOverlapIds,
} from '../tools/prr/state/state-core.js';

function baseState(over: Partial<ResolverState>): ResolverState {
  return {
    pr: 'o/r#1',
    branch: 'main',
    headSha: 'abc',
    startedAt: 's',
    lastUpdated: 'u',
    lessonsLearned: [],
    iterations: [],
    verifiedComments: [],
    verifiedFixed: [],
    dismissedIssues: [],
    ...over,
  } as ResolverState;
}

describe('applyResolverStateLoadCoreNormalization', () => {
  it('dedupes verifiedFixed and verifiedComments', () => {
    const state = baseState({
      verifiedFixed: ['ic_a', 'ic_a', 'ic_b'],
      verifiedComments: [
        { commentId: 'ic_x', verifiedAt: '2026-01-01T00:00:00Z', verifiedAtIteration: 1 },
        { commentId: 'ic_x', verifiedAt: '2026-02-01T00:00:00Z', verifiedAtIteration: 2 },
      ],
      noProgressCycles: 9,
    });
    const { mutated } = applyResolverStateLoadCoreNormalization(state);
    expect(mutated).toBe(true);
    expect(state.verifiedFixed).toEqual(['ic_a', 'ic_b']);
    expect(state.verifiedComments).toHaveLength(1);
    expect(state.verifiedComments[0]!.verifiedAt).toBe('2026-02-01T00:00:00Z');
    expect(state.noProgressCycles).toBe(0);
  });
});

const minimalDismissed = (over: Partial<DismissedIssue> & Pick<DismissedIssue, 'commentId'>): DismissedIssue => ({
  reason: 'r',
  dismissedAt: '2026-01-01T00:00:00Z',
  dismissedAtIteration: 1,
  category: 'stale',
  filePath: 'a.ts',
  line: 1,
  commentBody: 'b',
  ...over,
});

describe('getVerifiedDismissedOverlapIds', () => {
  it('returns ids present in verifiedFixed and dismissed', () => {
    const state = baseState({
      verifiedFixed: ['ic_1', 'ic_2'],
      dismissedIssues: [minimalDismissed({ commentId: 'ic_1' })],
    });
    expect(getVerifiedDismissedOverlapIds(state)).toEqual(['ic_1']);
  });
});

describe('assertNoVerifiedDismissedOverlapOrThrow', () => {
  it('does not throw when strict mode is off', () => {
    const prev = process.env.PRR_STRICT_STATE_OVERLAP;
    delete process.env.PRR_STRICT_STATE_OVERLAP;
    try {
      const state = baseState({
        verifiedFixed: ['ic_1'],
        dismissedIssues: [minimalDismissed({ commentId: 'ic_1' })],
      });
      expect(() => assertNoVerifiedDismissedOverlapOrThrow(state)).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.PRR_STRICT_STATE_OVERLAP = prev;
    }
  });

  it('throws when strict mode is on and overlap exists', () => {
    const prev = process.env.PRR_STRICT_STATE_OVERLAP;
    process.env.PRR_STRICT_STATE_OVERLAP = '1';
    try {
      const state = baseState({
        verifiedFixed: ['ic_1'],
        dismissedIssues: [minimalDismissed({ commentId: 'ic_1' })],
      });
      expect(() => assertNoVerifiedDismissedOverlapOrThrow(state)).toThrow(/PRR_STRICT_STATE_OVERLAP/);
    } finally {
      if (prev !== undefined) process.env.PRR_STRICT_STATE_OVERLAP = prev;
      else delete process.env.PRR_STRICT_STATE_OVERLAP;
    }
  });
});

describe('applyResolverStatePostOverlapCleanup', () => {
  it('clears recoveredFromGitCommentIds and skip-listed model performance keys', () => {
    const state = baseState({
      recoveredFromGitCommentIds: ['ic_1'],
      modelPerformance: {
        'llm-api/anthropic/claude-3.5-sonnet': { fixes: 0, failures: 1, noChanges: 0, errors: 0, lastUsed: 't' },
        'llm-api/anthropic/claude-opus-4.5': { fixes: 1, failures: 0, noChanges: 0, errors: 0, lastUsed: 't' },
      },
    });
    const { mutated } = applyResolverStatePostOverlapCleanup(state);
    expect(mutated).toBe(true);
    expect(state.recoveredFromGitCommentIds).toBeUndefined();
    expect(state.modelPerformance?.['llm-api/anthropic/claude-opus-4.5']).toBeDefined();
  });
});
