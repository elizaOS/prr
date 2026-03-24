import { describe, expect, it } from 'vitest';
import {
  ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS,
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
