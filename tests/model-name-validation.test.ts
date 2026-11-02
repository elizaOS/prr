import { describe, expect, it } from 'vitest';
import { isValidModelName, MODEL_NAME_MAX_LENGTH, MODEL_NAME_PATTERN } from '../shared/config.js';

describe('isValidModelName', () => {
  it('accepts OpenAI / gateway style ids', () => {
    expect(isValidModelName('gpt-4o')).toBe(true);
    expect(isValidModelName('anthropic/claude-3-5-haiku-20241022')).toBe(true);
  });

  it('accepts Ollama and LM Studio style tags (colon)', () => {
    expect(isValidModelName('gpt-oss:20b')).toBe(true);
    expect(isValidModelName('llama3.2:latest')).toBe(true);
    expect(isValidModelName('qwen2.5:3B')).toBe(true);
  });

  it('rejects empty, too long, or ambiguous patterns', () => {
    expect(isValidModelName('')).toBe(false);
    expect(isValidModelName('a//b')).toBe(false);
    const long = 'x'.repeat(MODEL_NAME_MAX_LENGTH + 1);
    expect(isValidModelName(long)).toBe(false);
  });

  it('documents colon is in MODEL_NAME_PATTERN (regression guard)', () => {
    expect(MODEL_NAME_PATTERN.source).toContain(':');
  });
});
