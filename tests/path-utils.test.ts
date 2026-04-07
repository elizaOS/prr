/**
 * Unit tests for shared/path-utils.ts.
 * Used in allowed-path filtering and TARGET FILE(S) construction; edge cases include
 * URL-encoded segments, internal paths, node_modules/dist, and repo top-level detection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeRepoPath,
  normalizePathForAllow,
  normalizePathSegmentEncoding,
  isPathAllowedForFix,
  filterAllowedPathsForFix,
  isReviewPathFragment,
  shouldSkipFinalAuditLlmForPath,
  pathDismissCategoryForNotFound,
  stripGitDiffPathPrefix,
  setDynamicRepoTopLevelDirs,
  getDynamicRepoTopLevelDirs,
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
  it('allows any repo-relative path by default (strict mode off)', () => {
    expect(isPathAllowedForFix('elizaos/core/lib/types.d.ts')).toBe(true);
    expect(isPathAllowedForFix('some-pkg/bar')).toBe(true);
    expect(isPathAllowedForFix('agent/typescript/index.ts')).toBe(true);
    expect(isPathAllowedForFix('cmd/server/main.go')).toBe(true);
    expect(isPathAllowedForFix('contracts/ERC20.sol')).toBe(true);
  });
  it('allows repo top-level dirs', () => {
    expect(isPathAllowedForFix('src/foo.ts')).toBe(true);
    expect(isPathAllowedForFix('tools/prr/index.ts')).toBe(true);
    expect(isPathAllowedForFix('shared/logger.ts')).toBe(true);
    expect(isPathAllowedForFix('packages/a/b.ts')).toBe(true);
    expect(isPathAllowedForFix('e2e/smoke.spec.ts')).toBe(true);
    expect(isPathAllowedForFix('playwright/foo.ts')).toBe(true);
    expect(isPathAllowedForFix('cypress/e2e/x.cy.ts')).toBe(true);
    expect(isPathAllowedForFix('fixtures/data.json')).toBe(true);
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

describe('stripGitDiffPathPrefix', () => {
  it('strips a/ or b/ when the next segment is a typical repo root', () => {
    expect(stripGitDiffPathPrefix('a/packages/foo/bar.ts')).toBe('packages/foo/bar.ts');
    expect(stripGitDiffPathPrefix('b/src/index.ts')).toBe('src/index.ts');
    expect(stripGitDiffPathPrefix('a/@scope/pkg/x.ts')).toBe('@scope/pkg/x.ts');
  });
  it('strips for root package.json-style paths', () => {
    expect(stripGitDiffPathPrefix('b/package.json')).toBe('package.json');
  });
  it('does not strip when the first segment is not a known repo root', () => {
    expect(stripGitDiffPathPrefix('a/odd-folder/file.ts')).toBe('a/odd-folder/file.ts');
  });
  it('leaves normal paths unchanged', () => {
    expect(stripGitDiffPathPrefix('packages/foo.ts')).toBe('packages/foo.ts');
  });
});

describe('setDynamicRepoTopLevelDirs', () => {
  afterEach(() => {
    setDynamicRepoTopLevelDirs([]);
  });

  it('hard deny rules still apply regardless of dynamic dirs', () => {
    setDynamicRepoTopLevelDirs(['node_modules/foo/bar.js', 'dist/index.js']);
    expect(isPathAllowedForFix('node_modules/foo/bar.js')).toBe(false);
    expect(isPathAllowedForFix('dist/index.js')).toBe(false);
  });

  it('internal segments denied even if in changed files', () => {
    setDynamicRepoTopLevelDirs(['.cursor/plans/x.md', '.prr/state.json']);
    expect(isPathAllowedForFix('.cursor/plans/x.md')).toBe(false);
    expect(isPathAllowedForFix('.prr/state.json')).toBe(false);
  });

  it('enables stripGitDiffPathPrefix for dynamic dirs', () => {
    expect(stripGitDiffPathPrefix('a/agent/typescript/index.ts')).toBe('a/agent/typescript/index.ts');
    setDynamicRepoTopLevelDirs(['agent/typescript/index.ts']);
    expect(stripGitDiffPathPrefix('a/agent/typescript/index.ts')).toBe('agent/typescript/index.ts');
  });

  it('extracts correct first segments from changed files', () => {
    setDynamicRepoTopLevelDirs([
      'agent/typescript/index.ts',
      'contracts/ERC20.sol',
      'cmd/server/main.go',
      'package.json',
    ]);
    const dirs = getDynamicRepoTopLevelDirs();
    expect(dirs.has('agent')).toBe(true);
    expect(dirs.has('contracts')).toBe(true);
    expect(dirs.has('cmd')).toBe(true);
    expect(dirs.has('package.json')).toBe(true);
  });
});

describe('isReviewPathFragment', () => {
  it('treats extension-only review paths as fragments', () => {
    expect(isReviewPathFragment('.d.ts')).toBe(true);
    expect(isReviewPathFragment('d.ts')).toBe(true);
    expect(isReviewPathFragment('.tsx')).toBe(true);
  });
  it('does not treat real single-segment root files as fragments', () => {
    expect(isReviewPathFragment('.env')).toBe(false);
    expect(isReviewPathFragment('.gitignore')).toBe(false);
  });
  it('does not treat normal paths as fragments', () => {
    expect(isReviewPathFragment('src/foo.ts')).toBe(false);
    expect(isReviewPathFragment('globals.d.ts')).toBe(false);
  });
});

describe('shouldSkipFinalAuditLlmForPath', () => {
  it('skips synthetic PR summary path, empty, and fragments', () => {
    expect(shouldSkipFinalAuditLlmForPath('(PR comment)')).toBe(true);
    expect(shouldSkipFinalAuditLlmForPath('')).toBe(true);
    expect(shouldSkipFinalAuditLlmForPath('   ')).toBe(true);
    expect(shouldSkipFinalAuditLlmForPath(undefined)).toBe(true);
    expect(shouldSkipFinalAuditLlmForPath(null)).toBe(true);
    expect(shouldSkipFinalAuditLlmForPath('.d.ts')).toBe(true);
  });
  it('does not skip normal repo paths', () => {
    expect(shouldSkipFinalAuditLlmForPath('src/foo.ts')).toBe(false);
    expect(shouldSkipFinalAuditLlmForPath('.env')).toBe(false);
    expect(shouldSkipFinalAuditLlmForPath('packages/a/b.ts')).toBe(false);
  });
});

describe('pathDismissCategoryForNotFound', () => {
  it('uses path-unresolved for ambiguous or fragment resolution', () => {
    expect(pathDismissCategoryForNotFound('foo.ts', 'ambiguous')).toBe('path-unresolved');
    expect(pathDismissCategoryForNotFound('x', 'fragment')).toBe('path-unresolved');
  });
  it('uses path-unresolved for fragment-shaped review path even when resolution is missing', () => {
    expect(pathDismissCategoryForNotFound('.d.ts', 'missing')).toBe('path-unresolved');
  });
  it('uses missing-file for normal paths with missing resolution', () => {
    expect(pathDismissCategoryForNotFound('src/nope.ts', 'missing')).toBe('missing-file');
  });
});
