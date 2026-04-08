import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimpleGit } from 'simple-git';
import { scanCommittedFixes, clearScanCommittedFixesCache } from '../shared/git/git-commit-scan.js';

beforeEach(() => {
  clearScanCommittedFixesCache();
});

describe('scanCommittedFixes cache', () => {
  it('skips git log on cache hit for same workdir, branch, and HEAD', async () => {
    let logCalls = 0;
    const git = {
      raw: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          if (args[2] === 'origin/main') return 'abc123\n';
          const err = new Error('unknown ref');
          throw err;
        }
        if (args[0] === 'log') {
          logCalls++;
          return 'prr-fix:IC_cached_marker\n';
        }
        return '';
      }),
    } as unknown as SimpleGit;

    const a = await scanCommittedFixes(git, 'feature/x', { workdir: '/tmp/prr-w', headSha: 'deadbeef01' });
    expect(logCalls).toBe(1);
    await scanCommittedFixes(git, 'feature/x', { workdir: '/tmp/prr-w', headSha: 'deadbeef01' });
    expect(a).toEqual(['IC_cached_marker']);
    expect(logCalls).toBe(1);
  });

  it('captures multiple prr-fix markers on one commit message line', async () => {
    const git = {
      raw: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          if (args[2] === 'origin/main') return 'abc\n';
          throw new Error('no');
        }
        if (args[0] === 'log') {
          return 'prr-fix:IC_a prr-fix:IC_b\n';
        }
        return '';
      }),
    } as unknown as SimpleGit;

    const ids = await scanCommittedFixes(git, 'feature/y');
    expect(ids.sort()).toEqual(['IC_a', 'IC_b'].sort());
  });

  it('does not use cache when workdir or headSha omitted', async () => {
    let logCalls = 0;
    const git = {
      raw: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          if (args[2] === 'origin/main') return 'abc\n';
          throw new Error('no');
        }
        if (args[0] === 'log') {
          logCalls++;
          return 'prr-fix:IC_one\n';
        }
        return '';
      }),
    } as unknown as SimpleGit;

    await scanCommittedFixes(git, 'b');
    await scanCommittedFixes(git, 'b');
    expect(logCalls).toBe(2);
  });
});
