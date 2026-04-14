import { describe, expect, it } from 'vitest';
import { extractJson, extractJsonLenient } from '../tools/pill/llm/parse-json.js';

describe('extractJsonLenient', () => {
  it('parses plain JSON like extractJson', () => {
    const raw = '{"summary":"ok","improvements":[]}';
    expect(extractJsonLenient(raw)).toEqual(JSON.parse(raw));
    expect(extractJson(raw)).toEqual(JSON.parse(raw));
  });

  it('recovers when prose appears before the real object (pill DIRECTORY echo)', () => {
    const raw = `[CONTEXT]

DIRECTORY TREE
foo/

Here is the JSON:
{"pitch":"p","summary":"s","improvements":[]}`;
    expect(() => extractJson(raw)).toThrow();
    expect(extractJsonLenient<{ pitch?: string; summary?: string; improvements?: unknown[] }>(raw)).toEqual({
      pitch: 'p',
      summary: 's',
      improvements: [],
    });
  });

  it('uses later candidate when first brace is invalid JSON', () => {
    const raw = `{ not json }

{"summary":"good","improvements":[]}`;
    expect(() => extractJson(raw)).toThrow();
    expect(extractJsonLenient(raw)).toEqual({ summary: 'good', improvements: [] });
  });
});
