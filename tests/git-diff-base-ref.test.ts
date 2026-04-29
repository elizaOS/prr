import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveRemoteTrackingRefForPrBase } from '../shared/git/git-diff.js';
import type { SimpleGit } from 'simple-git';

describe('resolveRemoteTrackingRefForPrBase', () => {
  let revparseResults: Map<string, string>;

  beforeEach(() => {
    revparseResults = new Map([
      ['upstream/develop', 'sha-up'],
      ['origin/develop', 'sha-or'],
    ]);
  });

  function mockGit(): SimpleGit {
    return {
      revparse: vi.fn(async (args: string[]) => {
        const ref = args[0];
        if (revparseResults.has(ref)) return revparseResults.get(ref)!;
        throw new Error(`unknown ref ${ref}`);
      }),
    } as unknown as SimpleGit;
  }

  it('prefers upstream/base when baseRepoCloneUrl is set (fork PR)', async () => {
    revparseResults.delete('origin/develop');
    const ref = await resolveRemoteTrackingRefForPrBase(mockGit(), {
      baseBranch: 'develop',
      baseRepoCloneUrl: 'https://github.com/upstream/repo.git',
    });
    expect(ref).toBe('upstream/develop');
  });

  it('falls back to origin/base when upstream missing but origin exists', async () => {
    revparseResults.delete('upstream/develop');
    const ref = await resolveRemoteTrackingRefForPrBase(mockGit(), {
      baseBranch: 'develop',
      baseRepoCloneUrl: 'https://github.com/upstream/repo.git',
    });
    expect(ref).toBe('origin/develop');
  });

  it('prefers origin first when not a fork clone (no baseRepoCloneUrl)', async () => {
    const ref = await resolveRemoteTrackingRefForPrBase(mockGit(), { baseBranch: 'develop' });
    expect(ref).toBe('origin/develop');
  });

  it('returns first candidate when neither ref exists (caller diff will fail empty)', async () => {
    revparseResults.clear();
    const ref = await resolveRemoteTrackingRefForPrBase(mockGit(), {
      baseBranch: 'develop',
      baseRepoCloneUrl: 'https://github.com/x/y.git',
    });
    expect(ref).toBe('upstream/develop');
  });
});
