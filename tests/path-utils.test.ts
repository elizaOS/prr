/**
 * Unit tests for shared/path-utils.ts.
 * Used in allowed-path filtering and TARGET FILE(S) construction; edge cases include
 * URL-encoded segments, internal paths, node_modules/dist, and repo top-level detection.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeRepoPath,
  normalizePathForAllow,
  normalizePathSegmentEncoding,
  isPathAllowedForFix,
  filterAllowedPathsForFix,
} from '../shared/path-utils.js';

describe('normalizeRepoPath', () => {
  it('replaces backslashes with forward slashes', () => {
    expect(normalizeRepoPath('foo\\bar\\baz')).toBe('foo/bar/baz');
  });
  it('trims whitespace', () => {
    expect(normalizeRepoPath('  src/foo.ts  ')).toBe('src/foo.ts');
  });
  it('leaves leading ./ as-is', () => {
    expect(normalizeRepoPath('./src/foo')).toBe('./src/foo');
  });
});

describe('normalizePathForAllow', () => {
  it('strips leading ./', () => {
    expect(normalizePathForAllow('./src/foo')).toBe('src/foo');
  });
  it('normalizes and trims', () => {
    expect(normalizePathForAllow('  ./lib/bar  ')).toBe('lib/bar');
  });
});

describe('normalizePathSegmentEncoding', () => {
  it('strips 2F prefix from URL-encoded segment', () => {
    expect(normalizePathSegmentEncoding('packages/2Fmessage-service.test.ts')).toBe(
      'packages/message-service.test.ts'
    );
  });
  it('leaves normal segments unchanged', () => {
    expect(normalizePathSegmentEncoding('src/foo.ts')).toBe('src/foo.ts');
  });
  it('joins filtered segments', () => {
    expect(normalizePathSegmentEncoding('a/2Fb/c')).toBe('a/b/c');
  });
});

describe('isPathAllowedForFix', () => {
  it('rejects empty or non-string', () => {
    expect(isPathAllowedForFix('')).toBe(false);
    expect(isPathAllowedForFix(null as any)).toBe(false);
  });
  it('rejects absolute paths', () => {
    expect(isPathAllowedForFix('/root/foo')).toBe(false);
    expect(isPathAllowedForFix('/src/bar')).toBe(false);
  });
  it('rejects internal segments', () => {
    expect(isPathAllowedForFix('.cursor/plans/x.plan.md')).toBe(false);
    expect(isPathAllowedForFix('.prr/state.json')).toBe(false);
    expect(isPathAllowedForFix('foo/root/bar')).toBe(false);
  });
  it('rejects node_modules and dist/', () => {
    expect(isPathAllowedForFix('node_modules/foo')).toBe(false);
    expect(isPathAllowedForFix('packages/x/node_modules/y')).toBe(false);
    expect(isPathAllowedForFix('dist/index.js')).toBe(false);
  });
  it('rejects external package-like first segment', () => {
    expect(isPathAllowedForFix('elizaos/core/lib/types.d.ts')).toBe(false);
    expect(isPathAllowedForFix('some-pkg/bar')).toBe(false);
  });
  it('allows repo top-level dirs', () => {
    expect(isPathAllowedForFix('src/foo.ts')).toBe(true);
    expect(isPathAllowedForFix('tools/prr/index.ts')).toBe(true);
    expect(isPathAllowedForFix('shared/logger.ts')).toBe(true);
    expect(isPathAllowedForFix('packages/a/b.ts')).toBe(true);
  });
  it('allows types and typings top-level', () => {
    expect(isPathAllowedForFix('types/index.d.ts')).toBe(true);
  });
});

describe('filterAllowedPathsForFix', () => {
  it('deduplicates and normalizes', () => {
    expect(filterAllowedPathsForFix(['src/foo', '  src/foo  ', './src/foo'])).toEqual(['src/foo']);
  });
  it('filters out disallowed paths', () => {
    expect(
      filterAllowedPathsForFix(['src/a.ts', '/root/x', 'node_modules/y', 'dist/z.js', '.cursor/w'])
    ).toEqual(['src/a.ts']);
  });
  it('applies segment encoding normalization', () => {
    expect(filterAllowedPathsForFix(['packages/2Fmessage-service.test.ts'])).toEqual([
      'packages/message-service.test.ts',
    ]);
  });
});
