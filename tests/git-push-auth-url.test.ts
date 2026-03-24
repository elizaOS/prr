import { describe, expect, it } from 'vitest';
import {
  buildHttpsPushUrlWithToken,
  httpsRemoteHasUserinfo,
  stripHttpsUserinfo,
} from '../shared/git/git-push-auth-url.js';

describe('stripHttpsUserinfo', () => {
  it('removes user:pass from https GitHub URL', () => {
    expect(stripHttpsUserinfo('https://old:secret@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('removes token-as-username style URL', () => {
    expect(stripHttpsUserinfo('https://ghp_xxx@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('leaves ssh and plain https unchanged (no userinfo)', () => {
    expect(stripHttpsUserinfo('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
    expect(stripHttpsUserinfo('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });
});

describe('httpsRemoteHasUserinfo', () => {
  it('is true when credentials are embedded', () => {
    expect(httpsRemoteHasUserinfo('https://x:y@github.com/a/b.git')).toBe(true);
    expect(httpsRemoteHasUserinfo('https://token@github.com/a/b.git')).toBe(true);
  });

  it('is false for bare https and ssh', () => {
    expect(httpsRemoteHasUserinfo('https://github.com/a/b.git')).toBe(false);
    expect(httpsRemoteHasUserinfo('git@github.com:a/b.git')).toBe(false);
  });
});

describe('buildHttpsPushUrlWithToken', () => {
  it('sets PAT as username and clears password', () => {
    const out = buildHttpsPushUrlWithToken('https://github.com/org/repo.git', 'ghp_abcd');
    expect(out).toBe('https://ghp_abcd@github.com/org/repo.git');
  });

  it('URL-encodes special characters in the token', () => {
    const out = buildHttpsPushUrlWithToken('https://github.com/org/repo.git', 'tok:en@x');
    expect(out).toContain('%3A');
    expect(out).toContain('%40');
    expect(out).not.toContain('tok:en@x@');
  });
});
