import { describe, expect, it } from 'vitest';
import { parseRepoSpec, normalizeGithubLogin } from '../tools/contributor-sheet/parse-input.js';
import { buildHeuristicSheet } from '../tools/contributor-sheet/heuristics.js';
import type { AuthorPrRow } from '../tools/contributor-sheet/types.js';
import { buildRichLlmDigest } from '../tools/contributor-sheet/build-llm-digest.js';

describe('contributor-sheet parseRepoSpec', () => {
  it('parses owner/repo', () => {
    expect(parseRepoSpec('BabylonSocial/babylon')).toEqual({
      owner: 'BabylonSocial',
      repo: 'babylon',
    });
  });
  it('parses https URL', () => {
    expect(parseRepoSpec('https://github.com/elizaOS/eliza/pulls?q=author')).toEqual({
      owner: 'elizaOS',
      repo: 'eliza',
    });
  });
  it('strips .git', () => {
    expect(parseRepoSpec('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
  });
});

describe('contributor-sheet normalizeGithubLogin', () => {
  it('accepts typical login', () => {
    expect(normalizeGithubLogin('tcm390')).toBe('tcm390');
  });
  it('rejects empty', () => {
    expect(() => normalizeGithubLogin('  ')).toThrow(/empty/);
  });
});

describe('contributor-sheet heuristics', () => {
  it('detects repeated normalized titles', () => {
    const rows: AuthorPrRow[] = [
      {
        number: 1,
        title: 'fix: hello world',
        state: 'closed',
        htmlUrl: 'https://example/1',
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: '2020-01-02T00:00:00Z',
        closedAt: '2020-01-02T00:00:00Z',
        merged: false,
      },
      {
        number: 2,
        title: 'fix(web): hello world',
        state: 'closed',
        htmlUrl: 'https://example/2',
        createdAt: '2020-02-01T00:00:00Z',
        updatedAt: '2020-02-03T00:00:00Z',
        closedAt: '2020-02-02T00:00:00Z',
        merged: true,
      },
    ];
    const { markdown, repeatedTitleClusters } = buildHeuristicSheet('o', 'r', 'u', rows);
    expect(repeatedTitleClusters.length).toBeGreaterThanOrEqual(1);
    expect(markdown).toContain('merged');
    expect(markdown).toContain('closed without merge');
  });
});

describe('contributor-sheet buildRichLlmDigest', () => {
  it('includes catalog and thread marker', () => {
    const rows: AuthorPrRow[] = [
      {
        number: 1,
        title: 'fix: a',
        state: 'merged',
        htmlUrl: 'x',
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: '2020-01-02T00:00:00Z',
        closedAt: null,
        merged: true,
        details: {
          body: 'Hello from body',
          additions: 1,
          deletions: 2,
          changedFiles: 3,
          issueComments: [{ kind: 'issue', author: 'reviewer', createdAt: '2020-01-01T12:00:00Z', body: 'LGTM' }],
          reviewInline: [],
          reviewSubmitted: [],
        },
      },
    ];
    const { text, catalogTruncated } = buildRichLlmDigest('o', 'r', 'u', rows, {
      maxCatalogHead: 50,
      maxCatalogTail: 50,
      maxTotalChars: 50_000,
    });
    expect(catalogTruncated).toBe(false);
    expect(text).toContain('PART 1');
    expect(text).toContain('PART 2');
    expect(text).toContain('Hello from body');
    expect(text).toContain('LGTM');
  });
});
