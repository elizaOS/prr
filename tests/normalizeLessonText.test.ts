import { describe, it, expect } from 'vitest';
import { sanitizeLessonText } from '../src/state/lessons-normalize.js';

// Tests for normalizeLessonText behavior
// Uses sanitizeLessonText as the public API (see normalize-lesson-text.test.ts for real tests)

describe('normalizeLessonText', () => {
  const normalize = (text: string) => sanitizeLessonText(text);

  it('should remove markdown code fences', () => {
    expect(normalize('```typescript\ncode\n```')).toBe('code');
  });

  it('should remove markdown headers', () => {
    expect(normalize('## Header')).toBeNull();
  });

  it('should return null for "Fix for" patterns', () => {
    expect(normalize('Fix for src/file.ts:42')).toBeNull();
  });

  it('should normalize "made no changes" variants', () => {
    const input = 'tool made no changes without explanation';
    expect(normalize(input)).toContain('made no changes');
  });

  it('should return null for numeric-only strings', () => {
    expect(normalize('12345')).toBeNull();
  });

  it('should trim and cleanup trailing colons/dashes', () => {
    const input = 'lesson text: -';
    const result = normalize(input);
    expect(result).not.toBeNull();
    expect(result).not.toMatch(/[:-]$/);
  });
});
