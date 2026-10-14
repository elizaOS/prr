import { describe, it, expect } from 'vitest';
import {
  finalAuditExplanationClaimsSnippetIsIncomplete,
  FINAL_AUDIT_TRUNCATION_GUARD_PASS_PREFIX,
  FINAL_AUDIT_UUID_ALIGN_PASS_EXPLANATION,
  isFinalAuditTruncationGuardPass,
  isFinalAuditUuidAlignPass,
} from '../tools/prr/llm/verification-heuristics.js';

describe('finalAuditExplanationClaimsSnippetIsIncomplete', () => {
  it('is true when the model says the shown window is insufficient', () => {
    expect(finalAuditExplanationClaimsSnippetIsIncomplete('not visible in the provided excerpt')).toBe(true);
    expect(finalAuditExplanationClaimsSnippetIsIncomplete('The rest of the file may still import the old API')).toBe(
      false,
    );
    expect(
      finalAuditExplanationClaimsSnippetIsIncomplete(
        'The rest of the file is not shown so I cannot verify the handler',
      ),
    ).toBe(true);
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

describe('isFinalAuditTruncationGuardPass', () => {
  it('is true only for explanations that start with the truncation-guard pass prefix', () => {
    expect(isFinalAuditTruncationGuardPass(`${FINAL_AUDIT_TRUNCATION_GUARD_PASS_PREFIX} Partial snippet; …`)).toBe(
      true,
    );
    expect(isFinalAuditTruncationGuardPass('FIXED: code looks good')).toBe(false);
    expect(isFinalAuditTruncationGuardPass('UNFIXED: line 1 still wrong')).toBe(false);
  });
});

describe('isFinalAuditUuidAlignPass', () => {
  it('is true only for the exact UUID-align post-check explanation', () => {
    expect(isFinalAuditUuidAlignPass(FINAL_AUDIT_UUID_ALIGN_PASS_EXPLANATION)).toBe(true);
    expect(isFinalAuditUuidAlignPass(`${FINAL_AUDIT_UUID_ALIGN_PASS_EXPLANATION} extra`)).toBe(false);
    expect(isFinalAuditUuidAlignPass('FIXED (post-check): other reason')).toBe(false);
  });
});
