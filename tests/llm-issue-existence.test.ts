import { describe, expect, it } from 'vitest';
import {
  commentNeedsConservativeExistenceCheck,
  explanationHasConcreteFixEvidence,
  explanationMentionsMissingCodeVisibility,
  snippetShowsUuidCommentAlignedWithVersionRange,
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

describe('explanationMentionsMissingCodeVisibility', () => {
  it('matches truncated snippet explanations', () => {
    expect(
      explanationMentionsMissingCodeVisibility(
        "The truncated snippet doesn't show the actual call to `sliceToFitBudget` with `fromEnd`, so I cannot determine if the issue is fixed."
      )
    ).toBe(true);
  });

  it('matches generic code-not-visible explanations', () => {
    expect(
      explanationMentionsMissingCodeVisibility(
        'The current code does not show the relevant implementation, so this cannot be assessed from the provided excerpt.'
      )
    ).toBe(true);
  });

  it('matches hedged truncated-snippet explanations', () => {
    expect(
      explanationMentionsMissingCodeVisibility(
        'The truncated snippet suggests the cleanup may happen elsewhere, but the relevant lifecycle code is not visible here.'
      )
    ).toBe(true);
  });

  it('matches hedged truncated-excerpt explanations (only new pattern; no "snippet" for old patterns)', () => {
    expect(
      explanationMentionsMissingCodeVisibility(
        'The truncated excerpt suggests the cleanup may happen elsewhere; the relevant lifecycle code is not visible here.'
      )
    ).toBe(true);
  });
});

describe('snippetShowsUuidCommentAlignedWithVersionRange', () => {
  it('is true when comment documents versions 1-8 and regex uses [1-8]', () => {
    const snip = `// WHY this regex? Matches standard UUID format (versions 1-8) with variant bits
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;`;
    expect(snippetShowsUuidCommentAlignedWithVersionRange(snip)).toBe(true);
  });

  it('is false without [1-8] in regex', () => {
    expect(
      snippetShowsUuidCommentAlignedWithVersionRange(
        '// v4 only\nconst r = /^[0-9a-f-]{36}$/i;',
      ),
    ).toBe(false);
  });
});
