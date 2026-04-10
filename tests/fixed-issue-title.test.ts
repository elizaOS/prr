import { describe, it, expect } from 'vitest';
import { getFixedIssueTitle } from '../tools/prr/ui/reporter.js';

describe('getFixedIssueTitle', () => {
  it('returns first non-empty line with heading markers stripped', () => {
    expect(getFixedIssueTitle('## Null check in handler\n\nDetails here.')).toBe(
      'Null check in handler',
    );
  });

  it('skips generic first lines when a better line follows', () => {
    const body = 'Summary\n\nUse optional chaining for foo.bar access.';
    expect(getFixedIssueTitle(body)).toBe('Use optional chaining for foo.bar access.');
  });

  it('skips # Summary same as plain Summary', () => {
    expect(getFixedIssueTitle('# Summary\n\nReal issue title')).toBe('Real issue title');
  });

  it('returns generic line when it is the only line', () => {
    expect(getFixedIssueTitle('Summary')).toBe('Summary');
  });

  it('falls back when no non-empty lines after trim', () => {
    expect(getFixedIssueTitle('')).toBe('');
    // No line survives `.trim().filter(Boolean)`; fallback is raw slice(0, 80)
    expect(getFixedIssueTitle('   \n  \n  ')).toBe('   \n  \n  ');
  });

  it('returns full first line when it is long (no truncation in loop)', () => {
    const one = 'x'.repeat(120);
    expect(getFixedIssueTitle(one)).toBe(one);
  });
});
