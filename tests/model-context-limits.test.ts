import { describe, expect, it } from 'vitest';
import {
  ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS,
  estimateElizacloudInputTokensFromCharLength,
  getMaxElizacloudLlmCompleteInputChars,
  getMaxFixPromptCharsForModel,
} from '../shared/llm/model-context-limits.js';

describe('getMaxElizacloudLlmCompleteInputChars', () => {
  it('equals fix-prompt cap plus overhead (Qwen 14B)', () => {
    const fix = getMaxFixPromptCharsForModel('elizacloud', 'alibaba/qwen-3-14b');
    expect(getMaxElizacloudLlmCompleteInputChars('alibaba/qwen-3-14b')).toBe(
      fix + ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS,
    );
  });

  it('is large for high-context ElizaCloud models', () => {
    const total = getMaxElizacloudLlmCompleteInputChars('openai/gpt-4o-mini');
    expect(total).toBeGreaterThan(80_000);
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
