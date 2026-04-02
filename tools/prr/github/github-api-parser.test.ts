import { describe, expect, it } from 'vitest';
import {
  parseBranchSpec,
  parseRepoUrl,
  normalizeCompareBranch,
  extractFullCommitShaFromText,
} from './types.js';

describe('extractFullCommitShaFromText', () => {
  it('returns first 40-char hex sha lowercase', () => {
    const sha = 'a'.repeat(40);
    expect(extractFullCommitShaFromText(`Reviewing commit ${sha} on branch x`)).toBe(sha);
  });

  it('returns undefined when no full sha', () => {
    expect(extractFullCommitShaFromText('only short abc1234 and 1234567')).toBeUndefined();
    expect(extractFullCommitShaFromText(undefined)).toBeUndefined();
    expect(extractFullCommitShaFromText('')).toBeUndefined();
  });

  it('is case-insensitive and ignores partial matches', () => {
    const mixed = 'ABCDEF0123456789abcdef0123456789abcdef01';
    expect(extractFullCommitShaFromText(`x ${mixed} y`)).toBe(mixed.toLowerCase());
  });
});

describe('parseRepoUrl', () => {
  it('parses https://github.com/owner/repo', () => {
    expect(parseRepoUrl('https://github.com/BabylonSocial/babylon')).toEqual({
      owner: 'BabylonSocial',
      repo: 'babylon',
    });
  });

  it('parses GitHub URL with trailing slash or .git', () => {
    expect(parseRepoUrl('https://github.com/owner/repo/')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses owner/repo shorthand', () => {
    expect(parseRepoUrl('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoUrl('BabylonSocial/babylon')).toEqual({ owner: 'BabylonSocial', repo: 'babylon' });
  });

  it('returns null for PR or branch URLs', () => {
    expect(parseRepoUrl('https://github.com/owner/repo/pull/123')).toBeNull();
    expect(parseRepoUrl('owner/repo#456')).toBeNull();
    expect(parseRepoUrl('owner/repo@main')).toBeNull();
    expect(parseRepoUrl('https://github.com/owner/repo/tree/main')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(parseRepoUrl('invalid')).toBeNull();
    expect(parseRepoUrl('owner/repo/extra')).toBeNull();
  });
});

describe('parseBranchSpec', () => {
  it('parses owner/repo@branch format', () => {
    expect(parseBranchSpec('owner/repo@branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'branch'
    });
  });

  it('parses owner/repo@branch with slashes in branch name', () => {
    expect(parseBranchSpec('owner/repo@feature/branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'feature/branch'
    });
  });

  it('parses owner/repo:branch format', () => {
    expect(parseBranchSpec('owner/repo:branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'branch'
    });
  });

  it('parses GitHub tree URL format', () => {
    expect(parseBranchSpec('https://github.com/owner/repo/tree/branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'branch'
    });
  });

  it('handles tree URL with query params and fragments', () => {
    expect(parseBranchSpec('https://github.com/owner/repo/tree/branch?foo=bar#readme')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'branch'
    });
  });

  it('handles tree URL with trailing slash', () => {
    expect(parseBranchSpec('https://github.com/owner/repo/tree/branch/')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'branch'
    });
  });

  it('returns null for invalid inputs', () => {
    expect(parseBranchSpec('invalid')).toBeNull();
    expect(parseBranchSpec('owner/repo')).toBeNull();
    expect(parseBranchSpec('owner/repo/')).toBeNull();
    expect(parseBranchSpec('https://github.com/owner/repo')).toBeNull();
  });
});

describe('normalizeCompareBranch', () => {
  it('returns plain branch name unchanged', () => {
    expect(normalizeCompareBranch('develop')).toBe('develop');
    expect(normalizeCompareBranch('feature/branch')).toBe('feature/branch');
  });

  it('extracts branch from owner/repo@branch', () => {
    expect(normalizeCompareBranch('owner/repo@branch')).toBe('branch');
  });

  it('extracts branch from GitHub tree URL', () => {
    expect(normalizeCompareBranch('https://github.com/owner/repo/tree/branch')).toBe('branch');
  });

  it('validates repo matches when current repo provided', () => {
    expect(normalizeCompareBranch('owner/repo@branch', 'owner', 'repo')).toBe('branch');
    
    expect(() => normalizeCompareBranch('other/repo@branch', 'owner', 'repo')).toThrow(
      '--compare repo (other/repo) does not match branch repo (owner/repo)'
    );
  });

  it('throws on bare repo URL (ambiguous)', () => {
    expect(() => normalizeCompareBranch('https://github.com/owner/repo')).toThrow('Invalid --compare value');
  });

  it('treats owner/repo as plain branch name when no @ or :', () => {
    expect(normalizeCompareBranch('owner/repo')).toBe('owner/repo');
  });
});
