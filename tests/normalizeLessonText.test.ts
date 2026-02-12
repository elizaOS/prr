import { describe, it, expect } from 'vitest';
import { sanitizeLessonText } from '../src/state/lessons.js';

// Tests for normalizeLessonText behavior
// Uses sanitizeLessonText as the public API (see normalize-lesson-text.test.ts for real tests)

describe('normalizeLessonText', () => {
  const normalize = (text: string) => sanitizeLessonText(text);

  it('should remove markdown code fences', () => {
    const result = normalize('Some lesson with ```typescript\ncode\n``` embedded');
    expect(result).not.toBeNull();
    expect(result).not.toContain('```');
  });

  it('should remove inline code backticks', () => {
    const result = normalize('Use `execSync` with shell false');
    expect(result).not.toBeNull();
    expect(typeof result === 'string').toBe(true);
    expect(result).not.toContain('`');
  });

  it('should remove URLs', () => {
    const result = normalize('Check https://example.com for details about the fix');
    expect(result).not.toBeNull();
    expect(result).not.toContain('https://');
  });

  it('should normalize "made no changes" variants', () => {
    const input = 'tool made no changes without explanation';
    const result = normalize(input);
    expect(result).not.toBeNull();
    expect(result).toContain('made no changes');
  });

  it('should normalize "made no changes" with missing separator before trying', () => {
    const input = 'tool made no changestrying different approach';
    const result = normalize(input);
    expect(result).not.toBeNull();
    expect(result).toContain('made no changes - ');
  });

  it('should normalize "made no changes" with missing separator before already', () => {
    const input = 'fixer made no changes  already includes all runners';
    const result = normalize(input);
    expect(result).not.toBeNull();
    expect(result).toContain('made no changes - already');
  });

  it.todo('should trim and cleanup trailing colons/dashes');
  it.todo('should remove (inferred) artifacts');
  it.todo('should collapse multiple hyphens');
});
