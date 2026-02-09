import { describe, it } from 'vitest';

// Tests for normalizeLessonText behavior
// Uses sanitizeLessonText as the public API (see normalize-lesson-text.test.ts for real tests)

describe('normalizeLessonText', () => {
  it.todo('should remove markdown code fences');
  it.todo('should remove markdown headers');
  it.todo('should remove bold/emphasis markers');
  it.todo('should remove list markers');
  it.todo('should remove comment tokens (//, /*, *)');
  it.todo('should remove access modifiers (public/private/protected)');
  it.todo('should remove declaration keywords');
  it.todo('should remove (inferred) prefix');
  it.todo('should strip file extensions (.ts, .js, .md, .json, .yml)');
  it.todo('should remove trailing type/line-number patterns like "a:123"');
  it.todo('should normalize "made no changes" variants');
  it.todo('should return null for "chars truncated" patterns');
  it.todo('should return null for "Fix for" patterns');
  it.todo('should return null for numeric-only strings');

  // Test edge cases
  it.todo('should handle combined/edge inputs');

  // Test trimming and cleanup
  it.todo('should trim and cleanup trailing colons/dashes');
});
