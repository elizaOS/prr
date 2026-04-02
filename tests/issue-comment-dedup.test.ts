import { describe, expect, it } from 'vitest';
import { deduplicateSameBotAcrossComments } from '../tools/prr/github/issue-comment-dedup.js';
import type { ReviewComment } from '../tools/prr/github/types.js';

function ic(
  id: string,
  author: string,
  path: string,
  line: number | null,
  body: string,
): ReviewComment {
  return {
    id,
    threadId: id,
    author,
    body,
    path,
    line,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('deduplicateSameBotAcrossComments', () => {
  it('merges same author, path, line null, similar bodies — keeps longest', () => {
    const shared =
      '`_multiplier` undefined in rate-limit RELAXED CRITICAL BURST presets variable renamed rateLimitMultiplier';
    const a = ic('ic-1-0', 'Claude', 'packages/lib/middleware/rate-limit.ts', null, shared);
    const b = ic(
      'ic-2-0',
      'Claude',
      'packages/lib/middleware/rate-limit.ts',
      null,
      `${shared} — add regression test and verify AGGRESSIVE preset.`,
    );
    const out = deduplicateSameBotAcrossComments([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('ic-2-0');
    expect(out[0]!.body.length).toBeGreaterThan(a.body.length);
  });

  it('does not merge different bot families on same path', () => {
    const a = ic('ic-1-0', 'Claude', 'foo.ts', null, '`_multiplier` broken in presets same text repeated');
    const b = ic('ic-2-0', 'cursor[bot]', 'foo.ts', null, '`_multiplier` broken in presets same text repeated');
    const out = deduplicateSameBotAcrossComments([a, b]);
    expect(out).toHaveLength(2);
  });

  it('merges cursor[bot] label vs Cursor display name when bodies are similar', () => {
    const body =
      '`_multiplier` undefined in rate-limit RELAXED CRITICAL BURST presets variable renamed rateLimitMultiplier';
    const a = ic('ic-1-0', 'cursor[bot]', 'foo.ts', null, body);
    const b = ic('ic-2-0', 'Cursor', 'foo.ts', null, `${body} extra tail for length`);
    const out = deduplicateSameBotAcrossComments([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.author).toBe('Cursor');
    expect(out[0]!.id).toBe('ic-2-0');
  });

  it('passes through single item', () => {
    const one = ic('ic-1-0', 'Claude', 'x.ts', null, 'only one');
    expect(deduplicateSameBotAcrossComments([one])).toEqual([one]);
  });
});
