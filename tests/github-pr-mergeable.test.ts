import { describe, expect, it } from 'vitest';
import {
  applyFreshPrInfoFromRest,
  githubPrMergeableUnknown,
  githubPrSaysNotMergeable,
} from '../tools/prr/github/pr-mergeable.js';
import type { PRInfo } from '../tools/prr/github/types.js';

function pr(partial: Partial<PRInfo>): PRInfo {
  return {
    owner: 'o',
    repo: 'r',
    number: 1,
    title: 't',
    body: '',
    branch: 'feat',
    baseBranch: 'main',
    headSha: 'abc',
    cloneUrl: 'https://github.com/o/r.git',
    mergeable: true,
    mergeableState: 'clean',
    ...partial,
  };
}

describe('githubPrSaysNotMergeable', () => {
  it('is true when mergeable is false', () => {
    expect(githubPrSaysNotMergeable(pr({ mergeable: false, mergeableState: 'clean' }))).toBe(true);
  });

  it('is true when mergeableState is dirty (case-insensitive)', () => {
    expect(githubPrSaysNotMergeable(pr({ mergeable: true, mergeableState: 'DIRTY' }))).toBe(true);
  });

  it('is false when clean and mergeable true', () => {
    expect(githubPrSaysNotMergeable(pr({ mergeable: true, mergeableState: 'clean' }))).toBe(false);
  });

  it('is false when mergeable null (unknown)', () => {
    expect(githubPrSaysNotMergeable(pr({ mergeable: null, mergeableState: 'unknown' }))).toBe(false);
  });
});

describe('githubPrMergeableUnknown', () => {
  it('is true only when mergeable is null', () => {
    expect(githubPrMergeableUnknown(pr({ mergeable: null }))).toBe(true);
    expect(githubPrMergeableUnknown(pr({ mergeable: false }))).toBe(false);
  });
});

describe('applyFreshPrInfoFromRest', () => {
  it('mutates merge fields and headSha from fresh', () => {
    const target = pr({ mergeable: null, mergeableState: 'unknown', headSha: 'old', title: 'old' });
    const fresh = pr({ mergeable: false, mergeableState: 'dirty', headSha: 'new', title: 'new', body: 'b' });
    applyFreshPrInfoFromRest(target, fresh);
    expect(target.mergeable).toBe(false);
    expect(target.mergeableState).toBe('dirty');
    expect(target.headSha).toBe('new');
    expect(target.title).toBe('new');
    expect(target.body).toBe('b');
    expect(target.branch).toBe('feat');
  });
});
