import { describe, expect, it } from 'vitest';
import { stripSeverityFraming, wordSetJaccard } from '../tools/prr/workflow/helpers/review-body-normalize.js';

describe('stripSeverityFraming', () => {
  it('strips critical bug prefix before backtick symbol', () => {
    const s = '**Critical Bug** — `_multiplier` is not defined';
    expect(stripSeverityFraming(s)).toContain('`_multiplier`');
    expect(stripSeverityFraming(s).toLowerCase()).not.toMatch(/^\*\*critical/);
  });

  it('strips emoji severity line starts', () => {
    const s = '🚨 High — missing null check in `foo`';
    expect(stripSeverityFraming(s)).toContain('`foo`');
  });
});

describe('wordSetJaccard', () => {
  it('scores high when bodies share many substantive words', () => {
    const a =
      '`_multiplier` is undefined in rate-limit RELAXED CRITICAL BURST presets after rename to rateLimitMultiplier';
    const b =
      'rate-limit presets RELAXED CRITICAL BURST still reference `_multiplier` but variable is rateLimitMultiplier';
    expect(wordSetJaccard(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it('scores low for unrelated bodies', () => {
    const a = 'Add tests for `reply.ts` coverage';
    const b = 'Security: rotate API keys in `config.ts`';
    expect(wordSetJaccard(a, b)).toBeLessThan(0.25);
  });
});
