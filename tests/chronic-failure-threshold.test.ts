import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseChronicFailureThresholdFromEnv } from '../shared/constants/fix-loop.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseChronicFailureThresholdFromEnv', () => {
  it('defaults empty and whitespace-only to 5 (no warn)', () => {
    expect(parseChronicFailureThresholdFromEnv(undefined)).toBe(5);
    expect(parseChronicFailureThresholdFromEnv('')).toBe(5);
    expect(parseChronicFailureThresholdFromEnv('   ')).toBe(5);
  });

  it('defaults non-numeric tokens to 5 and warns', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseChronicFailureThresholdFromEnv('abc')).toBe(5);
    expect(parseChronicFailureThresholdFromEnv('NaN')).toBe(5);
    expect(w).toHaveBeenCalled();
    expect(String(w.mock.calls[0]?.[0] ?? '')).toMatch(/PRR_CHRONIC_FAILURE_THRESHOLD/);
  });

  it('parses integers with floor 1', () => {
    expect(parseChronicFailureThresholdFromEnv('1')).toBe(1);
    expect(parseChronicFailureThresholdFromEnv('  12  ')).toBe(12);
    expect(parseChronicFailureThresholdFromEnv('0')).toBe(1);
    expect(parseChronicFailureThresholdFromEnv('-3')).toBe(1);
  });
});
