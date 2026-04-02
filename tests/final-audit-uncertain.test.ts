import { describe, it, expect } from 'vitest';
import { classifyFinalAuditUncertainExplanation } from '../tools/prr/workflow/helpers/final-audit-uncertain.js';

describe('classifyFinalAuditUncertainExplanation', () => {
  it('returns null for empty', () => {
    expect(classifyFinalAuditUncertainExplanation('')).toBeNull();
    expect(classifyFinalAuditUncertainExplanation('   ')).toBeNull();
  });

  it('detects truncation guard prefix', () => {
    expect(
      classifyFinalAuditUncertainExplanation('FIXED (truncation guard): partial snippet'),
    ).toBe('truncation-guard');
    expect(
      classifyFinalAuditUncertainExplanation('fixed (truncation guard): case'),
    ).toBe('truncation-guard');
  });

  it('detects UNCERTAIN (audit pass) prefix', () => {
    expect(
      classifyFinalAuditUncertainExplanation('UNCERTAIN (audit pass): prose here'),
    ).toBe('uncertain');
  });

  it('detects plain UNCERTAIN:', () => {
    expect(classifyFinalAuditUncertainExplanation('UNCERTAIN: excerpt only')).toBe('uncertain');
  });

  it('returns null for normal FIXED', () => {
    expect(classifyFinalAuditUncertainExplanation('FIXED: issue resolved.')).toBeNull();
  });
});
