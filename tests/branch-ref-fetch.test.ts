import { describe, expect, it } from 'vitest';
import { isBranchRefSafeForOriginFetch } from '../shared/git/git-conflicts.js';

describe('isBranchRefSafeForOriginFetch', () => {
  it('accepts typical branch names', () => {
    expect(isBranchRefSafeForOriginFetch('main')).toBe(true);
    expect(isBranchRefSafeForOriginFetch('feature/foo-bar')).toBe(true);
    expect(isBranchRefSafeForOriginFetch('1.x')).toBe(true);
  });

  it('rejects empty, .., and obvious junk', () => {
    expect(isBranchRefSafeForOriginFetch('')).toBe(false);
    expect(isBranchRefSafeForOriginFetch('a..b')).toBe(false);
    expect(isBranchRefSafeForOriginFetch('bad branch')).toBe(false);
    expect(isBranchRefSafeForOriginFetch('x:y')).toBe(false);
  });
});
