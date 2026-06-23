import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { isTrackedGitSubmodulePath } from '../shared/git/git-submodule-path.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

describe('isTrackedGitSubmodulePath', () => {
  it('returns true for a path recorded as mode 160000 in the index', () => {
    const parent = mkdtempSync(join(tmpdir(), 'prr-submod-parent-'));
    tempDirs.push(parent);
    const child = join(parent, 'child-repo');
    mkdirSync(child, { recursive: true });

    git(child, ['init', '-b', 'main']);
    writeFileSync(join(child, 'README.md'), '# child\n', 'utf8');
    git(child, ['add', 'README.md']);
    git(child, [
      '-c',
      'user.email=test@test',
      '-c',
      'user.name=test',
      'commit',
      '-m',
      'init',
    ]);
    const childHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: child,
      encoding: 'utf8',
    }).trim();

    git(parent, ['init', '-b', 'main']);
    writeFileSync(join(parent, 'root.txt'), 'root\n', 'utf8');
    git(parent, ['add', 'root.txt']);
    git(parent, ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'root']);
    // Avoid `git submodule add` (file:// transport may be disabled); record a real gitlink in the index.
    git(parent, ['update-index', '--add', '--cacheinfo', `160000,${childHead},plugins/plugin-sql`]);
    git(parent, ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'add gitlink']);

    expect(isTrackedGitSubmodulePath(parent, 'plugins/plugin-sql')).toBe(true);
    expect(isTrackedGitSubmodulePath(parent, 'root.txt')).toBe(false);
    expect(isTrackedGitSubmodulePath(parent, 'nope')).toBe(false);
  });

  it('returns false for a non-git directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-submod-nogit-'));
    tempDirs.push(dir);
    expect(isTrackedGitSubmodulePath(dir, 'anything')).toBe(false);
  });
});
