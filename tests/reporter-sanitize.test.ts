import { describe, it, expect } from 'vitest';
import { sanitizeCommentForDisplay } from '../tools/prr/ui/reporter.js';

describe('sanitizeCommentForDisplay', () => {
  it('treats undefined/null as empty string (AAR / summary paths)', () => {
    expect(sanitizeCommentForDisplay(undefined)).toBe('');
    expect(sanitizeCommentForDisplay(null)).toBe('');
  });

  it('still strips HTML for normal bodies', () => {
    expect(sanitizeCommentForDisplay('<p>Hi</p>')).toBe('Hi');
  });
});
