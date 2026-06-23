import { describe, it, expect } from 'vitest';
import { finalAuditExplanationClaimsSnippetIsIncomplete } from '../tools/prr/llm/verification-heuristics.js';

describe('finalAuditExplanationClaimsSnippetIsIncomplete', () => {
  it('is true when the model says the shown window is insufficient', () => {
    expect(finalAuditExplanationClaimsSnippetIsIncomplete('not visible in the provided excerpt')).toBe(true);
    expect(finalAuditExplanationClaimsSnippetIsIncomplete('The rest of the file may still import the old API')).toBe(
      true,
    );
    expect(finalAuditExplanationClaimsSnippetIsIncomplete('cannot verify — excerpt does not include line 900')).toBe(
      true,
    );
  });

  it('is false for substantive UNFIXED that does not hinge on missing context', () => {
    expect(
      finalAuditExplanationClaimsSnippetIsIncomplete(
        'The handler still returns 500 on empty body; no validation before parse.',
      ),
    ).toBe(false);
  });
});
