import { describe, expect, it } from 'vitest';
import { parseBranchSpec, normalizeCompareBranch } from './types.js';

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

  it('throws on invalid formats', () => {
    expect(() => normalizeCompareBranch('https://github.com/owner/repo')).toThrow('Invalid --compare value');
    expect(() => normalizeCompareBranch('owner/repo')).toThrow('Invalid --compare value');
  });
});
