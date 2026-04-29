import { describe, it, expect } from 'vitest';
import { isLikelyNonRetryableElizaCloudError } from '../shared/llm/elizacloud-retry-policy.js';

describe('isLikelyNonRetryableElizaCloudError', () => {
  it('returns true for Pricing unavailable (ElizaCloud 500 body)', () => {
    const err = new Error('500 Pricing unavailable for language:input anthropic/claude-sonnet-4-5-20250929');
    expect(isLikelyNonRetryableElizaCloudError(err)).toBe(true);
  });

  it('returns true when nested body mentions pricing', () => {
    const err = { message: 'Request failed', body: { error: { message: 'Pricing unavailable for org' } } };
    expect(isLikelyNonRetryableElizaCloudError(err)).toBe(true);
  });

  it('returns false for generic 504 timeout message', () => {
    expect(isLikelyNonRetryableElizaCloudError(new Error('504 Gateway Timeout'))).toBe(false);
  });
});
