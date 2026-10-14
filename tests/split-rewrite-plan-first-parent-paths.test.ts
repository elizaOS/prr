/**
 * Merge commits: plain diff-tree --name-only <sha> is empty; rewrite plan must use first-parent diff.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import simpleGit from 'simple-git';
import { describe, it, expect, afterAll } from 'vitest';
import { getCommitChangedPathsFirstParent } from '../tools/split-rewrite-plan/run.js';

describe('getCommitChangedPathsFirstParent', () => {
  let dir: string | undefined;
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns paths for a merge commit (first-parent diff)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'split-rw-plan-'));
    const git = simpleGit(dir);
    await git.init(['-b', 'main']);
    await git.raw(['config', 'user.email', 't@e.st']);
    await git.raw(['config', 'user.name', 't']);
    writeFileSync(join(dir, 'f.txt'), 'a\n');
    await git.add('f.txt');
    await git.commit('root');
    await git.checkoutLocalBranch('feat');
    writeFileSync(join(dir, 'f.txt'), 'a\nb\n');
    await git.add('f.txt');
    await git.commit('feat change');
    await git.checkout('main');
    writeFileSync(join(dir, 'g.txt'), 'c\n');
    await git.add('g.txt');
    await git.commit('main add');
    await git.checkout('feat');
    await git.merge(['main', '-m', 'merge main']);
    const mergeSha = (await git.revparse(['HEAD'])).trim();
    const empty = (await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-only', mergeSha])).trim();
    expect(empty).toBe('');
    const paths = await getCommitChangedPathsFirstParent(git, mergeSha);
    expect(paths).toContain('g.txt');
  });

  it('returns paths for a normal commit', async () => {
    const d = mkdtempSync(join(tmpdir(), 'split-rw-plan-'));
    const git = simpleGit(d);
    await git.init(['-b', 'main']);
    await git.raw(['config', 'user.email', 't@e.st']);
    await git.raw(['config', 'user.name', 't']);
    writeFileSync(join(d, 'x.txt'), 'a');
    await git.add('x.txt');
    await git.commit('add x');
    const sha = (await git.revparse(['HEAD'])).trim();
    const paths = await getCommitChangedPathsFirstParent(git, sha);
    expect(paths).toEqual(['x.txt']);
    rmSync(d, { recursive: true, force: true });
  });
});
