import { describe, it, expect } from 'vitest';
import { stripMarkdownForCommit } from '../shared/git/git-commit-message.js';

describe('stripMarkdownForCommit', () => {
  it('strips fixed-set emoji prefixes (legacy bots)', () => {
    expect(stripMarkdownForCommit('⚠️ Fix the handler')).toBe('Fix the handler');
    expect(stripMarkdownForCommit('✅ Add validation')).toBe('Add validation');
  });

  it('strips arbitrary extended pictographic prefix (Unicode property)', () => {
    // U+1F6A8 POLICE CARS REVOLVING LIGHT — unlikely to be in the fixed alternation list
    expect(stripMarkdownForCommit('\u{1F6A8} Alert: fix null check')).toBe('Alert: fix null check');
  });

  it('strips ZWJ emoji sequences at start', () => {
    const family = '👨‍👩‍👧‍👦 Family plan: update docs';
    expect(stripMarkdownForCommit(family)).toBe('Family plan: update docs');
  });
});
