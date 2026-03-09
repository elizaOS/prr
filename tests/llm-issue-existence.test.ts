import { describe, expect, it } from 'vitest';
import {
  commentNeedsConservativeExistenceCheck,
  explanationHasConcreteFixEvidence,
} from '../tools/prr/llm/client.js';

describe('commentNeedsConservativeExistenceCheck', () => {
  it('treats lifecycle comments conservatively', () => {
    expect(
      commentNeedsConservativeExistenceCheck(
        'latestResponseIds Map potential memory leak because stale entries are never cleared.'
      )
    ).toBe(true);
  });

  it('treats ordering comments conservatively', () => {
    expect(
      commentNeedsConservativeExistenceCheck(
        'sliceToFitBudget with fromEnd: true keeps oldest runs instead of newest-first history.'
      )
    ).toBe(true);
  });
});

describe('explanationHasConcreteFixEvidence', () => {
  it('requires more than vague already-correct language', () => {
    expect(explanationHasConcreteFixEvidence('This is already correct.')).toBe(false);
  });

  it('accepts line-cited explanations', () => {
    expect(
      explanationHasConcreteFixEvidence('Line 158 now calls sliceToFitBudget without `fromEnd: true`.')
    ).toBe(true);
  });
});
