import { describe, it, expect } from 'vitest';
import {
  computeBudget,
  computePerFixVerifyCurrentCodeBudget,
  fitToBudget,
  truncateNumberedCodeAroundAnchor,
} from '../shared/prompt-budget.js';

describe('prompt-budget', () => {
  it('computeBudget returns positive availableForCode', () => {
    const b = computeBudget({ model: 'openai/gpt-4o-mini', reservedChars: 20_000 });
    expect(b.availableForCode).toBeGreaterThan(5_000);
    expect(b.inputCeilingChars).toBeGreaterThan(b.availableForCode);
  });

  it('fitToBudget returns full file when under maxChars', () => {
    const raw = 'a\nb\nc';
    const { content, truncated } = fitToBudget(raw, 2, 10_000);
    expect(truncated).toBe(false);
    expect(content).toContain('1: a');
    expect(content).toContain('3: c');
  });

  it('truncateNumberedCodeAroundAnchor keeps anchor vicinity', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}: line${i + 1}`);
    const big = lines.join('\n');
    const out = truncateNumberedCodeAroundAnchor(big, 25, 400);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('line25');
  });

  it('computePerFixVerifyCurrentCodeBudget shrinks with more fixes', () => {
    const one = computePerFixVerifyCurrentCodeBudget('openai/gpt-4o-mini', 1);
    const many = computePerFixVerifyCurrentCodeBudget('openai/gpt-4o-mini', 12);
    expect(many).toBeLessThanOrEqual(one);
  });
});
