import { describe, it, expect } from 'vitest';
import { parseResultCode } from '../tools/prr/workflow/utils.js';

describe('parseResultCode', () => {
  it('parses RESULT: ALREADY_FIXED — detail', () => {
    const output = 'Some text.\nRESULT: ALREADY_FIXED — line 45 has null check\nMore text.';
    const parsed = parseResultCode(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.resultCode).toBe('ALREADY_FIXED');
    expect(parsed!.resultDetail).toBe('line 45 has null check');
  });

  it('parses RESULT with double hyphen delimiter', () => {
    const output = 'RESULT: UNCLEAR -- instructions are ambiguous';
    const parsed = parseResultCode(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.resultCode).toBe('UNCLEAR');
    expect(parsed!.resultDetail).toBe('instructions are ambiguous');
  });

  it('parses optional CAVEAT line', () => {
    const output = `RESULT: ATTEMPTED — added a guard
CAVEAT: may need to handle edge case`;
    const parsed = parseResultCode(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.resultCode).toBe('ATTEMPTED');
    expect(parsed!.resultDetail).toBe('added a guard');
    expect(parsed!.caveat).toBe('may need to handle edge case');
  });

  it('returns null when no RESULT line present', () => {
    expect(parseResultCode('No changes made.')).toBeNull();
    expect(parseResultCode('NO_CHANGES: something')).toBeNull();
    expect(parseResultCode('')).toBeNull();
    expect(parseResultCode('   ')).toBeNull();
  });
});
