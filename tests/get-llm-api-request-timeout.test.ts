/**
 * llm-api client timeout tiers vs prompt size (shared/constants/polling.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLlmApiRequestTimeoutMs,
  LLM_REQUEST_TIMEOUT_FULL_FILE_MS,
  LLM_REQUEST_TIMEOUT_MS,
} from '../shared/constants/polling.js';

const ENV_KEY = 'PRR_LLM_API_REQUEST_TIMEOUT_MS';

describe('getLlmApiRequestTimeoutMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses full-file constant when full-file rewrite', () => {
    expect(getLlmApiRequestTimeoutMs(5_000, true)).toBe(LLM_REQUEST_TIMEOUT_FULL_FILE_MS);
  });

  it('defaults to 90s for small prompts', () => {
    expect(getLlmApiRequestTimeoutMs(10_000, false)).toBe(LLM_REQUEST_TIMEOUT_MS);
  });

  it('raises tier at 60k+, 100k+, 140k+ chars', () => {
    expect(getLlmApiRequestTimeoutMs(60_001, false)).toBe(120_000);
    expect(getLlmApiRequestTimeoutMs(100_001, false)).toBe(150_000);
    expect(getLlmApiRequestTimeoutMs(140_001, false)).toBe(180_000);
  });

  it('respects PRR_LLM_API_REQUEST_TIMEOUT_MS for non-full-file', () => {
    vi.stubEnv(ENV_KEY, '240000');
    expect(getLlmApiRequestTimeoutMs(200_000, false)).toBe(240_000);
  });

  it('env override does not apply to full-file rewrite', () => {
    vi.stubEnv(ENV_KEY, '240000');
    expect(getLlmApiRequestTimeoutMs(200_000, true)).toBe(LLM_REQUEST_TIMEOUT_FULL_FILE_MS);
  });

  it('ignores invalid env and uses tiers', () => {
    vi.stubEnv(ENV_KEY, 'nope');
    expect(getLlmApiRequestTimeoutMs(150_000, false)).toBe(180_000);
  });
});
