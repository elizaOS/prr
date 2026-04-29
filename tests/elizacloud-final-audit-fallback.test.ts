import { describe, expect, it } from 'vitest';
import {
  isWeakElizacloudBatchVerifierModelId,
  pickStrongElizaCloudAuditFallback,
} from '../tools/prr/elizacloud-final-audit-fallback.js';

describe('isWeakElizacloudBatchVerifierModelId', () => {
  it('treats qwen-3-235b as weak', () => {
    expect(isWeakElizacloudBatchVerifierModelId('alibaba/qwen-3-235b')).toBe(true);
  });
  it('does not treat opus as weak', () => {
    expect(isWeakElizacloudBatchVerifierModelId('anthropic/claude-opus-4.5')).toBe(false);
  });
});

describe('pickStrongElizaCloudAuditFallback', () => {
  it('prefers opus when available and not skipped', () => {
    const available = new Set(['anthropic/claude-opus-4.5', 'alibaba/qwen-3-235b']);
    const skip = new Set<string>();
    expect(pickStrongElizaCloudAuditFallback(available, skip)).toBe('anthropic/claude-opus-4.5');
  });
  it('skips opus when in skip set', () => {
    const available = new Set(['anthropic/claude-opus-4.5', 'anthropic/claude-sonnet-4-5-20250929']);
    const skip = new Set(['anthropic/claude-opus-4.5']);
    expect(pickStrongElizaCloudAuditFallback(available, skip)).toBe('anthropic/claude-sonnet-4-5-20250929');
  });
});
