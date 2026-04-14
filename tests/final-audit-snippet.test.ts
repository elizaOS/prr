import { describe, expect, it } from 'vitest';
import { finalAuditSnippetLooksTruncatedOrExcerpt } from '../tools/prr/llm/client.js';

describe('finalAuditSnippetLooksTruncatedOrExcerpt', () => {
  it('detects batch clip marker', () => {
    expect(
      finalAuditSnippetLooksTruncatedOrExcerpt('foo\n... (truncated for model context limit — final audit)'),
    ).toBe(true);
  });

  it('detects huge-file excerpt footers from getFullFileForAudit', () => {
    expect(
      finalAuditSnippetLooksTruncatedOrExcerpt(
        '1: a\n... (excerpt only — file has 2,000 lines; centered on line 500)',
      ),
    ).toBe(true);
    expect(
      finalAuditSnippetLooksTruncatedOrExcerpt(
        '... (1,500 more lines omitted — file exceeds 50,000 chars; no line anchor',
      ),
    ).toBe(true);
  });

  it('detects legacy head-only omission', () => {
    expect(finalAuditSnippetLooksTruncatedOrExcerpt('...(500 more lines omitted for size)')).toBe(true);
  });

  it('returns false for normal windowed snippet truncation', () => {
    expect(
      finalAuditSnippetLooksTruncatedOrExcerpt('12: foo\n... (truncated — file has 400 lines total)'),
    ).toBe(false);
  });
});
