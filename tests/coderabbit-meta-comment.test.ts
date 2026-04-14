import { describe, it, expect } from 'vitest';
import { isCodeRabbitMetaComment } from '../tools/prr/github/api.js';

function cr(body: string, author = 'coderabbitai[bot]') {
  return { author, body };
}

describe('isCodeRabbitMetaComment', () => {
  it('returns false for non-CodeRabbit authors', () => {
    expect(isCodeRabbitMetaComment(cr('ℹ️ Recent review info', 'cursor[bot]'))).toBe(false);
  });

  it('detects Recent review info prefix', () => {
    expect(isCodeRabbitMetaComment(cr('ℹ️ Recent review info\n\nSomething'))).toBe(true);
  });

  it('detects configuration blurb', () => {
    const body = '**Configuration used:** Learn more\n**Review profile:** CHILL';
    expect(isCodeRabbitMetaComment(cr(body))).toBe(true);
  });

  it('detects auto-generated reply HTML comment', () => {
    expect(
      isCodeRabbitMetaComment(cr('<!-- This is an auto-generated reply by CodeRabbit -->\nHi')),
    ).toBe(true);
  });

  it('detects short Actions performed meta', () => {
    expect(isCodeRabbitMetaComment(cr('✅ Actions performed\n\nDone.'))).toBe(true);
  });

  it('does not treat very long Actions performed bodies as meta', () => {
    const filler = 'x'.repeat(2100);
    expect(isCodeRabbitMetaComment(cr(`✅ Actions performed\n\n${filler}`))).toBe(false);
  });

  it('returns false for normal review-shaped CodeRabbit text', () => {
    expect(
      isCodeRabbitMetaComment(
        cr(
          '### Issue: missing null check\n\nIn `src/foo.ts` line 12, `bar` may be undefined. Add a guard.',
        ),
      ),
    ).toBe(false);
  });
});
