import { describe, expect, it } from 'vitest';
import type { ResolverState } from '../tools/prr/state/types.js';
import {
  applyResolverStateLoadCoreNormalization,
  applyResolverStatePostOverlapCleanup,
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
    applyResolverStateLoadCoreNormalization(state);
    expect(state.verifiedFixed).toEqual(['ic_a', 'ic_b']);
    expect(state.verifiedComments).toHaveLength(1);
    expect(state.verifiedComments[0]!.verifiedAt).toBe('2026-02-01T00:00:00Z');
    expect(state.noProgressCycles).toBe(0);
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
    applyResolverStatePostOverlapCleanup(state);
    expect(state.recoveredFromGitCommentIds).toBeUndefined();
    expect(state.modelPerformance?.['llm-api/anthropic/claude-opus-4.5']).toBeDefined();
  });
});
