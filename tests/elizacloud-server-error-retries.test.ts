import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertValidLlmPromptSizeLimits,
  clearInvalidElizacloudServerErrorRetriesWarnDedupeForTests,
  getElizacloudServerErrorMaxRetries,
  MAX_ENRICHED_FIX_PROMPT_CHARS,
  MAX_ENRICHED_FIX_PROMPT_HARD_CAP,
} from '../shared/constants/llm.js';

const keys = ['PRR_ELIZACLOUD_SERVER_ERROR_RETRIES', 'CI'] as const;

afterEach(() => {
  for (const k of keys) delete process.env[k];
  vi.restoreAllMocks();
  clearInvalidElizacloudServerErrorRetriesWarnDedupeForTests();
});

describe('getElizacloudServerErrorMaxRetries', () => {
  it('defaults to 2 when not CI', () => {
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
  });

  it('defaults to 4 when CI=true', () => {
    process.env.CI = 'true';
    expect(getElizacloudServerErrorMaxRetries()).toBe(4);
  });

  it('env overrides CI default', () => {
    process.env.CI = 'true';
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '7';
    expect(getElizacloudServerErrorMaxRetries()).toBe(7);
  });

  it('invalid env falls through to non-CI default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = 'not-a-number';
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/PRR_ELIZACLOUD_SERVER_ERROR_RETRIES/);
  });

  it('invalid env falls through to CI default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CI = 'true';
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '999';
    expect(getElizacloudServerErrorMaxRetries()).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/PRR_ELIZACLOUD_SERVER_ERROR_RETRIES/);
  });

  it('allows zero retries', () => {
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '0';
    expect(getElizacloudServerErrorMaxRetries()).toBe(0);
  });

  it('rejects partial numeric strings (parseInt-style junk)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '3abc';
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns at most once per distinct invalid value per process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = 'oops';
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('LLM prompt size limits', () => {
  it('keeps enriched prompt caps aligned', () => {
    expect(MAX_ENRICHED_FIX_PROMPT_CHARS).toBe(MAX_ENRICHED_FIX_PROMPT_HARD_CAP);
    expect(() => assertValidLlmPromptSizeLimits()).not.toThrow();
  });

  it('rejects constants that would make rewrite injection budget invalid', () => {
    expect(() =>
      assertValidLlmPromptSizeLimits({
        firstAttemptMaxPromptChars: 80_000,
        maxFixPromptChars: 100_000,
        maxEnrichedFixPromptChars: 101_000,
        maxEnrichedFixPromptHardCap: 101_000,
        rewriteEscalationReserveChars: 2_000,
      }),
    ).toThrow(/REWRITE_ESCALATION_RESERVE_CHARS/);
  });
});
