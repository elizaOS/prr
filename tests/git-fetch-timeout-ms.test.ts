import { describe, expect, it } from 'vitest';
import { parseFetchTimeoutMs } from '../shared/git/git-conflicts.js';

describe('parseFetchTimeoutMs', () => {
  it('uses 60,000 ms when unset or empty', () => {
    expect(parseFetchTimeoutMs({})).toBe(60_000);
    expect(parseFetchTimeoutMs({ PRR_FETCH_TIMEOUT_MS: '' })).toBe(60_000);
  });

  it('uses 60,000 ms when value is not a valid integer', () => {
    expect(parseFetchTimeoutMs({ PRR_FETCH_TIMEOUT_MS: 'abc' })).toBe(60_000);
    expect(parseFetchTimeoutMs({ PRR_FETCH_TIMEOUT_MS: '   ' })).toBe(60_000);
  });

  it('uses parseInt semantics for leading digits (12abc → 12, then clamp to min 5,000)', () => {
    expect(parseFetchTimeoutMs({ PRR_FETCH_TIMEOUT_MS: '12abc' })).toBe(5000);
  });

  it('clamps to minimum 5,000 ms', () => {
    expect(parseFetchTimeoutMs({ PRR_FETCH_TIMEOUT_MS: '1' })).toBe(5000);
  });

  it('accepts valid positive integers', () => {
    expect(parseFetchTimeoutMs({ PRR_FETCH_TIMEOUT_MS: '120000' })).toBe(120_000);
  });
});
