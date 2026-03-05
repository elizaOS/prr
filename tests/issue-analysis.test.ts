import { describe, it, expect } from 'vitest';
import { parseLineReferencesFromBody } from '../tools/prr/workflow/issue-analysis.js';

describe('parseLineReferencesFromBody', () => {
  it('extracts "around lines N - M" (CodeRabbit format)', () => {
    const body = 'In `@src/foo.ts` around lines 52 - 93, fix the issue.';
    expect(parseLineReferencesFromBody(body)).toEqual([52, 93]);
  });

  it('extracts "lines N-M"', () => {
    const body = 'Duplicate block at lines 70-78.';
    expect(parseLineReferencesFromBody(body)).toEqual([70, 78]);
  });

  it('extracts "at line N" and "on line N"', () => {
    const body = 'At line 128 we call createReadStream. On line 129 we close it.';
    expect(parseLineReferencesFromBody(body)).toEqual([128, 129]);
  });

  it('extracts "Line N" (capital L)', () => {
    const body = 'Line 45 has the null check.';
    expect(parseLineReferencesFromBody(body)).toEqual([45]);
  });

  it('extracts #LN and #LN-LM (LOCATIONS-style)', () => {
    const body = 'See #L100 and #L200-L210.';
    expect(parseLineReferencesFromBody(body)).toEqual([100, 200, 210]);
  });

  it('returns sorted, de-duplicated 1-based line numbers', () => {
    const body = 'Lines 93 and 52. Also around lines 52 - 93.';
    expect(parseLineReferencesFromBody(body)).toEqual([52, 93]);
  });

  it('does not match HTTP status or port numbers', () => {
    const body = 'HTTP 404 error. Connect to port 8080. Version 2.0.';
    expect(parseLineReferencesFromBody(body)).toEqual([]);
  });

  it('does not match "pipeline" or "deadline"', () => {
    const body = 'The pipeline runs in stage 2. Deadline is line 10.';
    // "line 10" should match; "pipeline" and "deadline" should not add line numbers
    expect(parseLineReferencesFromBody(body)).toEqual([10]);
  });

  it('skips lines containing sed -n / cat -n (CodeRabbit script blocks)', () => {
    const body = `Some comment about the code.
\`\`\`shell
sed -n '225,245p' file.ts
\`\`\`
The actual issue is at line 100.`;
    expect(parseLineReferencesFromBody(body)).toEqual([100]);
  });

  it('returns empty array for empty or whitespace input', () => {
    expect(parseLineReferencesFromBody('')).toEqual([]);
    expect(parseLineReferencesFromBody('   ')).toEqual([]);
  });
});
