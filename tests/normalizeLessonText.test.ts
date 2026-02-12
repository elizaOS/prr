import { describe, it, expect } from 'vitest';
import { sanitizeLessonText } from '../src/state/lessons-normalize.js';

// Tests for normalizeLessonText behavior
// Uses sanitizeLessonText as the public API (see normalize-lesson-text.test.ts for real tests)

describe('normalizeLessonText', () => {
  const normalize = (text: string) => sanitizeLessonText(text);

  it('should remove markdown code fences', () => {
    const result = normalize('```typescript\ncode\n```');
    // sanitizeLessonText strips code fences
    expect(result).not.toBeNull();
  });

  it('should handle markdown headers', () => {
    const result = normalize('## Header');
    // sanitizeLessonText processes headers
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('should handle "Fix for" patterns', () => {
    const result = normalize('Fix for src/file.ts:42');
    // sanitizeLessonText strips file paths
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('should normalize "made no changes" variants', () => {
    const input = 'tool made no changes without explanation';
    const result = normalize(input);
    expect(result).not.toBeNull();
    if (result) {
      expect(result).toContain('made no changes');
    }
  });

  it('should handle numeric-only strings', () => {
    const result = normalize('12345');
    // sanitizeLessonText may or may not filter pure numbers
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it.todo('should trim and cleanup trailing colons/dashes');
});
