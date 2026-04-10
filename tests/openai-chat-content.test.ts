import { describe, expect, it } from 'vitest';
import { openAiChatCompletionContentToString } from '../shared/llm/openai-chat-content.js';

describe('openAiChatCompletionContentToString', () => {
  it('returns empty for null/undefined', () => {
    expect(openAiChatCompletionContentToString(null)).toBe('');
    expect(openAiChatCompletionContentToString(undefined)).toBe('');
  });

  it('passes through strings', () => {
    expect(openAiChatCompletionContentToString('YES')).toBe('YES');
  });

  it('concatenates text parts from array content', () => {
    expect(
      openAiChatCompletionContentToString([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ]),
    ).toBe('hello world');
  });

  it('ignores non-text parts', () => {
    expect(
      openAiChatCompletionContentToString([{ type: 'image_url', image_url: { url: 'x' } }]),
    ).toBe('');
  });
});
