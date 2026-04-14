import { describe, expect, it } from 'vitest';
import { normalizeReviewBotAuthorLabel } from '../tools/prr/github/bot-author-normalize.js';

describe('normalizeReviewBotAuthorLabel', () => {
  it('maps known bot logins to short labels', () => {
    expect(normalizeReviewBotAuthorLabel('claude[bot]')).toBe('Claude');
    expect(normalizeReviewBotAuthorLabel('Claude')).toBe('Claude');
    expect(normalizeReviewBotAuthorLabel('cursor[bot]')).toBe('Cursor');
    expect(normalizeReviewBotAuthorLabel('Cursor')).toBe('Cursor');
    expect(normalizeReviewBotAuthorLabel('greptile-apps[bot]')).toBe('Greptile');
    expect(normalizeReviewBotAuthorLabel('copilot-pull-request-reviewer[bot]')).toBe('Copilot');
  });

  it('strips generic [bot] suffix for unknown apps', () => {
    expect(normalizeReviewBotAuthorLabel('myapp[bot]')).toBe('myapp');
  });

  it('passes through human logins', () => {
    expect(normalizeReviewBotAuthorLabel('octocat')).toBe('octocat');
  });

  it('handles empty input', () => {
    expect(normalizeReviewBotAuthorLabel('')).toBe('unknown');
    expect(normalizeReviewBotAuthorLabel('   ')).toBe('unknown');
  });
});
