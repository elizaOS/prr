import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { pathTrackedAtGitHead } from '../tools/prr/workflow/helpers/git-path-at-head.js';

function git(workdir: string, args: string[]) {
  execFileSync('git', args, { cwd: workdir, stdio: 'pipe' });
}

describe('pathTrackedAtGitHead', () => {
  it('returns true when path exists at HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-gpath-'));
    try {
      git(dir, ['init', '-b', 'main']);
      git(dir, ['config', 'user.email', 't@test']);
      git(dir, ['config', 'user.name', 't']);
      writeFileSync(join(dir, 'a.txt'), 'x');
      git(dir, ['add', 'a.txt']);
      git(dir, ['commit', '-m', 'init']);
      expect(pathTrackedAtGitHead(dir, 'a.txt')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when path is not at HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-gpath-'));
    try {
      git(dir, ['init', '-b', 'main']);
      git(dir, ['config', 'user.email', 't@test']);
      git(dir, ['config', 'user.name', 't']);
      writeFileSync(join(dir, 'a.txt'), 'x');
      git(dir, ['add', 'a.txt']);
      git(dir, ['commit', '-m', 'init']);
      expect(pathTrackedAtGitHead(dir, 'nope.txt')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false after file removed in latest commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-gpath-'));
    try {
      git(dir, ['init', '-b', 'main']);
      git(dir, ['config', 'user.email', 't@test']);
      git(dir, ['config', 'user.name', 't']);
      writeFileSync(join(dir, 'a.txt'), 'x');
      git(dir, ['add', 'a.txt']);
      git(dir, ['commit', '-m', 'init']);
      git(dir, ['rm', 'a.txt']);
      git(dir, ['commit', '-m', 'rm']);
      expect(pathTrackedAtGitHead(dir, 'a.txt')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for synthetic paths', () => {
    expect(pathTrackedAtGitHead('/tmp', '(PR comment)')).toBeNull();
    expect(pathTrackedAtGitHead('/tmp', '')).toBeNull();
  });
});
