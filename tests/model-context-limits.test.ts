import { describe, expect, it } from 'vitest';
import {
  ELIZACLOUD_COMPLETION_CONTEXT_RESERVE_TOKENS,
  ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS,
  ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS,
  estimateElizacloudInputTokensFromCharLength,
  getMaxElizacloudHardInputCeiling,
  getMaxElizacloudLlmCompleteInputChars,
  getMaxFixPromptCharsForModel,
  lowerModelMaxPromptChars,
} from '../shared/llm/model-context-limits.js';

describe('getMaxElizacloudLlmCompleteInputChars', () => {
  it('uses unified small-context cap for Qwen 14B (min of legacy fix+overhead and token-total budget)', () => {
    const fix = getMaxFixPromptCharsForModel('elizacloud', 'alibaba/qwen-3-14b');
    const legacy = fix + ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS;
    // floor((24576 - 8192 - 512) * 1.6) — full system+user must fit with worst-case max_completion
    const unified = Math.floor(
      (24_576 - ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS - ELIZACLOUD_COMPLETION_CONTEXT_RESERVE_TOKENS) * 1.6,
    );
    expect(legacy).toBeGreaterThan(unified);
    expect(getMaxElizacloudLlmCompleteInputChars('alibaba/qwen-3-14b')).toBe(unified);
  });

  it('is large for high-context ElizaCloud models', () => {
    const total = getMaxElizacloudLlmCompleteInputChars('openai/gpt-4o-mini');
    expect(total).toBeGreaterThan(80_000);
  });
});

describe('getMaxElizacloudHardInputCeiling', () => {
  it('hard ceiling is not affected by lowerModelMaxPromptChars on large-context models', () => {
    const model = 'anthropic/claude-sonnet-4-5-20250929';
    const ceilingBefore = getMaxElizacloudHardInputCeiling(model);
    expect(ceilingBefore).toBeGreaterThan(600_000);

    lowerModelMaxPromptChars('elizacloud', model, 35_000);
    const softAfter = getMaxElizacloudLlmCompleteInputChars(model);
    const ceilingAfter = getMaxElizacloudHardInputCeiling(model);

    expect(ceilingAfter).toBe(ceilingBefore);
    expect(softAfter).toBeLessThan(ceilingAfter);
  });

  it('floor prevents large-context models from being lowered below 60k', () => {
    const model = 'anthropic/claude-sonnet-4-5-20250929';
    lowerModelMaxPromptChars('elizacloud', model, 35_000);
    const fix = getMaxFixPromptCharsForModel('elizacloud', model);
    expect(fix).toBeGreaterThanOrEqual(60_000);
  });
});

describe('estimateElizacloudInputTokensFromCharLength', () => {
  it('uses ~1.6 chars/token for small-context models (Qwen 14B)', () => {
    const { approxTokens, assumedCharsPerToken } = estimateElizacloudInputTokensFromCharLength(
      'alibaba/qwen-3-14b',
      3200,
    );
    expect(assumedCharsPerToken).toBe(1.6);
    expect(approxTokens).toBe(2000);
  });

  it('uses ~4 chars/token for large-context models', () => {
    const { approxTokens, assumedCharsPerToken } = estimateElizacloudInputTokensFromCharLength(
      'openai/gpt-4o-mini',
      8000,
    );
    expect(assumedCharsPerToken).toBe(4);
    expect(approxTokens).toBe(2000);
  });
});
