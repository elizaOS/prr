import { describe, it, expect } from 'vitest';
import { redactUrlCredentials } from '../shared/git/redact-url.js';

describe('redactUrlCredentials', () => {
  it('redacts https://x-access-token:TOKEN@github.com/... (colon in userinfo)', () => {
    const raw =
      'remote https://x-access-token:ghp_secret12345@github.com/org/repo.git';
    expect(redactUrlCredentials(raw)).toBe('remote https://***@github.com/org/repo.git');
  });

  it('redacts simple token@host https URLs', () => {
    expect(redactUrlCredentials('https://abc123@github.com/x')).toBe('https://***@github.com/x');
  });
});
