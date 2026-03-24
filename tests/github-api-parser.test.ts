import { describe, expect, it } from 'vitest';
import { parseMarkdownReviewIssues } from '../tools/prr/github/api.js';
import { parseBranchSpec, normalizeCompareBranch } from '../tools/prr/github/types.js';

describe('parseBranchSpec', () => {
  it('parses owner/repo@branch shorthand', () => {
    const result = parseBranchSpec('owner/repo@feature-branch');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'feature-branch' });
  });

  it('parses owner/repo:branch shorthand', () => {
    const result = parseBranchSpec('owner/repo:feature-branch');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'feature-branch' });
  });

  it('parses branch names with slashes', () => {
    const result = parseBranchSpec('owner/repo@feature/siwe/auth');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'feature/siwe/auth' });
  });

  it('parses GitHub tree URL', () => {
    const result = parseBranchSpec('https://github.com/owner/repo/tree/main');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });
  });

  it('parses tree URL with branch containing slashes', () => {
    const result = parseBranchSpec('https://github.com/owner/repo/tree/feature/siwe');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'feature/siwe' });
  });

  it('strips query parameters from tree URL', () => {
    const result = parseBranchSpec('https://github.com/owner/repo/tree/main?tab=readme');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });
  });

  it('strips fragment from tree URL', () => {
    const result = parseBranchSpec('https://github.com/owner/repo/tree/main#installation');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });
  });

  it('strips trailing slashes from branch name', () => {
    const result = parseBranchSpec('https://github.com/owner/repo/tree/main/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });
  });

  it('returns null for plain branch name (no repo context)', () => {
    const result = parseBranchSpec('feature-branch');
    expect(result).toBeNull();
  });

  it('returns null for invalid input', () => {
    const result = parseBranchSpec('not-a-valid-spec');
    expect(result).toBeNull();
  });
});

describe('normalizeCompareBranch', () => {
  it('returns plain branch name as-is', () => {
    const result = normalizeCompareBranch('v1-develop');
    expect(result).toBe('v1-develop');
  });

  it('extracts branch from owner/repo@branch format', () => {
    const result = normalizeCompareBranch('owner/repo@v1-develop');
    expect(result).toBe('v1-develop');
  });

  it('extracts branch from tree URL', () => {
    const result = normalizeCompareBranch('https://github.com/owner/repo/tree/v1-develop');
    expect(result).toBe('v1-develop');
  });

  it('extracts branch with slashes from tree URL', () => {
    const result = normalizeCompareBranch('https://github.com/owner/repo/tree/feature/auth/siwe');
    expect(result).toBe('feature/auth/siwe');
  });

  it('strips query parameters when extracting branch', () => {
    const result = normalizeCompareBranch('https://github.com/owner/repo/tree/main?foo=bar');
    expect(result).toBe('main');
  });

  it('throws on repo mismatch when currentOwner/currentRepo provided', () => {
    expect(() => {
      normalizeCompareBranch('other/repo@branch', 'owner', 'repo');
    }).toThrow('--compare repo (other/repo) does not match branch repo (owner/repo)');
  });

  it('allows matching repo when currentOwner/currentRepo provided', () => {
    const result = normalizeCompareBranch('owner/repo@v1-develop', 'owner', 'repo');
    expect(result).toBe('v1-develop');
  });

  it('throws on invalid structured input', () => {
    expect(() => {
      normalizeCompareBranch('https://github.com/invalid-url');
    }).toThrow('Invalid --compare value');
  });
});

describe('parseMarkdownReviewIssues', () => {
  describe('parseBranchSpec', () => {
    it('parses valid branch specifications', () => {
      expect(parseBranchSpec('owner/repo@branch')).toEqual({ owner: 'owner', repo: 'repo', branch: 'branch' });
      expect(parseBranchSpec('owner/repo:branch')).toEqual({ owner: 'owner', repo: 'repo', branch: 'branch' });
      expect(parseBranchSpec('https://github.com/owner/repo/tree/branch')).toEqual({ owner: 'owner', repo: 'repo', branch: 'branch' });
    });

    it('handles special cases', () => {
      expect(parseBranchSpec('owner/repo@feature/branch')).toEqual({ owner: 'owner', repo: 'repo', branch: 'feature/branch' });
      expect(parseBranchSpec('https://github.com/owner/repo/tree/branch?foo=bar#readme')).toEqual({ owner: 'owner', repo: 'repo', branch: 'branch' });
      expect(parseBranchSpec('https://github.com/owner/repo/tree/branch/')).toEqual({ owner: 'owner', repo: 'repo', branch: 'branch' });
    });

    it('returns null for invalid inputs', () => {
      expect(parseBranchSpec('invalid')).toBeNull();
      expect(parseBranchSpec('owner/repo')).toBeNull();
      expect(parseBranchSpec('https://github.com/owner/repo')).toBeNull();
    });
  });

  describe('normalizeCompareBranch', () => {
    it('returns plain branch name unchanged', () => {
      expect(normalizeCompareBranch('develop')).toBe('develop');
      expect(normalizeCompareBranch('feature/branch')).toBe('feature/branch');
    });

    it('extracts branch from valid specifications', () => {
      expect(normalizeCompareBranch('owner/repo@branch')).toBe('branch');
      expect(normalizeCompareBranch('https://github.com/owner/repo/tree/branch')).toBe('branch');
    });

    it('validates matching repo', () => {
      expect(normalizeCompareBranch('owner/repo@branch', 'owner', 'repo')).toBe('branch');
      expect(() => normalizeCompareBranch('other/repo@branch', 'owner', 'repo')).toThrow(
        '--compare repo (other/repo) does not match branch repo (owner/repo)'
      );
    });

    it('throws for invalid formats', () => {
      expect(() => normalizeCompareBranch('https://github.com/owner/repo')).toThrow('Invalid --compare value');
    });
    it('treats owner/repo without @ or : as plain branch name', () => {
      // Implementation allows plain branch names; owner/repo is returned as-is when it does not match branch spec (no @ or :).
      expect(normalizeCompareBranch('owner/repo')).toBe('owner/repo');
    });
  });
  it('skips summary/status recap table items', () => {
    const markdown = `## Findings

| Location | Suggestion |
| --- | --- |
| logger.ts | Add JSDoc |
| reply.ts | Still missing tests |`;

    expect(parseMarkdownReviewIssues(markdown)).toEqual([]);
  });

  it('keeps explicit bare-file issues when they are written as actionable items', () => {
    const markdown = `## Blocking Issues

### 1. Missing tests
Add tests for \`reply.ts:106\` so the new path is covered.`;

    expect(parseMarkdownReviewIssues(markdown)).toEqual([
      expect.objectContaining({
        path: 'reply.ts',
        line: 106,
      }),
    ]);
  });
});

