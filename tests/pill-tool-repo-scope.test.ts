import { describe, it, expect } from 'vitest';
import {
  normalizeImprovementFilePath,
  isPathInToolRepositoryScope,
  filterImprovementsByToolRepoScope,
  resolveToolRepoScopeFilter,
} from '../tools/pill/tool-repo-scope.js';

describe('tool-repo-scope', () => {
  it('normalizes and rejects unsafe paths', () => {
    expect(normalizeImprovementFilePath('tools/prr/cli.ts')).toBe('tools/prr/cli.ts');
    expect(normalizeImprovementFilePath('./shared/logger.ts')).toBe('shared/logger.ts');
    expect(normalizeImprovementFilePath('..\\..\\etc/passwd')).toBe('');
    expect(normalizeImprovementFilePath('/abs')).toBe('');
  });

  it('accepts allowed prefixes and root files', () => {
    expect(isPathInToolRepositoryScope('tools/prr/foo.ts')).toBe(true);
    expect(isPathInToolRepositoryScope('shared/logger.ts')).toBe(true);
    expect(isPathInToolRepositoryScope('tests/x.test.ts')).toBe(true);
    expect(isPathInToolRepositoryScope('docs/THREAD-REPLIES.md')).toBe(true);
    expect(isPathInToolRepositoryScope('generated/x.json')).toBe(true);
    expect(isPathInToolRepositoryScope('.github/workflows/ci.yml')).toBe(true);
    expect(isPathInToolRepositoryScope('README.md')).toBe(true);
    expect(isPathInToolRepositoryScope('package.json')).toBe(true);
  });

  it('rejects typical clone paths', () => {
    expect(isPathInToolRepositoryScope('src/app/page.tsx')).toBe(false);
    expect(isPathInToolRepositoryScope('packages/foo/index.ts')).toBe(false);
    expect(isPathInToolRepositoryScope('apps/web/main.ts')).toBe(false);
    expect(isPathInToolRepositoryScope('components/Button.tsx')).toBe(false);
  });

  it('filters improvement list', () => {
    const { kept, dropped } = filterImprovementsByToolRepoScope([
      { file: 'tools/prr/cli.ts' },
      { file: 'src/bad.ts' },
      { file: 'shared/logger.ts' },
    ]);
    expect(dropped).toBe(1);
    expect(kept.map((k) => k.file)).toEqual(['tools/prr/cli.ts', 'shared/logger.ts']);
  });

  it('resolveToolRepoScopeFilter respects env', () => {
    expect(resolveToolRepoScopeFilter('/tmp', '0')).toBe(false);
    expect(resolveToolRepoScopeFilter('/tmp', 'false')).toBe(false);
    expect(resolveToolRepoScopeFilter('/tmp', '1')).toBe(true);
    expect(resolveToolRepoScopeFilter('/tmp', undefined)).toBe(false);
    expect(resolveToolRepoScopeFilter(process.cwd(), undefined)).toBe(true);
  });
});
