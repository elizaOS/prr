import { describe, expect, it } from 'vitest';
import { parseMarkdownReviewIssues, parseBranchSpec, normalizeCompareBranch } from '../tools/prr/github/api.js';

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
      expect(() => normalizeCompareBranch('owner/repo')).toThrow('Invalid --compare value');
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
