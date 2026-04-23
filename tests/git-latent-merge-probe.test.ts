import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { simpleGit } from 'simple-git';
import {
  parseMergeTreeConflictPaths,
  mergeTreeFailureLooksUnsupported,
  probeLatentMergeConflictsWithOrigin,
  checkForConflicts,
} from '../shared/git/git-conflicts.js';

describe('mergeTreeFailureLooksUnsupported', () => {
  it('detects old-git / unknown-option style errors', () => {
    expect(mergeTreeFailureLooksUnsupported("git: 'merge-tree' is not a git command")).toBe(true);
    expect(mergeTreeFailureLooksUnsupported('error: unknown option `write-tree`')).toBe(true);
    expect(mergeTreeFailureLooksUnsupported('CONFLICT (content): Merge conflict in f.txt')).toBe(false);
  });
});

describe('parseMergeTreeConflictPaths', () => {
  it('parses Merge conflict in and CONFLICT lines', () => {
    const s = [
      'CONFLICT (content): Merge conflict in f.txt',
      'CONFLICT (modify/delete): a.txt deleted in topic and modified in HEAD.',
    ].join('\n');
    const paths = parseMergeTreeConflictPaths(s);
    expect(paths).toContain('f.txt');
    expect(paths).toContain('a.txt');
  });
});

function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('probeLatentMergeConflictsWithOrigin', () => {
  let conflictDir: string;
  let cleanDir: string;

  beforeAll(() => {
    conflictDir = mkdtempSync(join(tmpdir(), 'prr-latent-c-'));
    gitRun(conflictDir, ['init', '-b', 'main']);
    gitRun(conflictDir, ['config', 'user.email', 'probe@test.local']);
    gitRun(conflictDir, ['config', 'user.name', 'probe']);
    execFileSync('bash', ['-c', 'echo a > f.txt && git add f.txt && git commit -m base'], {
      cwd: conflictDir,
    });
    gitRun(conflictDir, ['branch', 'other']);
    execFileSync('bash', ['-c', 'echo b >> f.txt && git commit -am main'], { cwd: conflictDir });
    gitRun(conflictDir, ['checkout', 'other']);
    execFileSync('bash', ['-c', 'echo c >> f.txt && git commit -am other'], { cwd: conflictDir });
    gitRun(conflictDir, ['checkout', 'main']);
    const tipOther = gitRun(conflictDir, ['rev-parse', 'other']).trim();
    gitRun(conflictDir, ['update-ref', 'refs/remotes/origin/other', tipOther]);

    cleanDir = mkdtempSync(join(tmpdir(), 'prr-latent-clean-'));
    gitRun(cleanDir, ['init', '-b', 'main']);
    gitRun(cleanDir, ['config', 'user.email', 'probe@test.local']);
    gitRun(cleanDir, ['config', 'user.name', 'probe']);
    execFileSync('bash', ['-c', 'echo x > a.txt && git add a.txt && git commit -m base'], {
      cwd: cleanDir,
    });
    gitRun(cleanDir, ['checkout', '-b', 'add-only']);
    execFileSync('bash', ['-c', 'echo y > g.txt && git add g.txt && git commit -m add'], {
      cwd: cleanDir,
    });
    gitRun(cleanDir, ['checkout', 'main']);
    const tipAdd = gitRun(cleanDir, ['rev-parse', 'add-only']).trim();
    gitRun(cleanDir, ['update-ref', 'refs/remotes/origin/add-only', tipAdd]);
  });

  afterAll(() => {
    rmSync(conflictDir, { recursive: true, force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  });

  it('detects latent conflict with origin/other', async () => {
    const git = simpleGit(conflictDir);
    const r = await probeLatentMergeConflictsWithOrigin(git, 'other');
    expect(r.ran).toBe(true);
    expect(r.hasLatentConflicts).toBe(true);
    expect(r.files).toContain('f.txt');
  });

  it('reports no latent conflict for clean merge', async () => {
    const git = simpleGit(cleanDir);
    const r = await probeLatentMergeConflictsWithOrigin(git, 'add-only');
    expect(r.ran).toBe(true);
    expect(r.hasLatentConflicts).toBe(false);
    expect(r.files).toEqual([]);
  });

  it('respects PRR_DISABLE_LATENT_MERGE_PROBE_BASE for second probe env', async () => {
    const prev = process.env.PRR_DISABLE_LATENT_MERGE_PROBE_BASE;
    process.env.PRR_DISABLE_LATENT_MERGE_PROBE_BASE = '1';
    try {
      const git = simpleGit(cleanDir);
      const r = await probeLatentMergeConflictsWithOrigin(git, 'add-only', {
        disableEnvVar: 'PRR_DISABLE_LATENT_MERGE_PROBE_BASE',
      });
      expect(r.ran).toBe(false);
      expect(r.skipReason).toBe('PRR_DISABLE_LATENT_MERGE_PROBE_BASE');
    } finally {
      if (prev === undefined) delete process.env.PRR_DISABLE_LATENT_MERGE_PROBE_BASE;
      else process.env.PRR_DISABLE_LATENT_MERGE_PROBE_BASE = prev;
    }
  });
});

describe('checkForConflicts PR-base probe', () => {
  let workDir: string;
  let bareDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'prr-latent-prbase-'));
    bareDir = mkdtempSync(join(tmpdir(), 'prr-latent-prbase-bare-'));
    gitRun(workDir, ['init', '-b', 'main']);
    gitRun(workDir, ['config', 'user.email', 'probe@test.local']);
    gitRun(workDir, ['config', 'user.name', 'probe']);
    execFileSync('bash', ['-c', 'echo base > f.txt && git add f.txt && git commit -m base'], {
      cwd: workDir,
    });
    gitRun(workDir, ['checkout', '-b', 'pr']);
    execFileSync('bash', ['-c', 'echo pr >> f.txt && git commit -am pr'], { cwd: workDir });
    gitRun(workDir, ['checkout', 'main']);
    execFileSync('bash', ['-c', 'echo main >> f.txt && git commit -am mainline'], { cwd: workDir });
    gitRun(workDir, ['checkout', 'pr']);
    gitRun(bareDir, ['init', '--bare']);
    gitRun(workDir, ['remote', 'add', 'origin', bareDir]);
    gitRun(workDir, ['push', 'origin', 'main', 'pr']);
    gitRun(workDir, ['branch', '--set-upstream-to=origin/pr', 'pr']);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  it('sets latentConflictWithPrBase when HEAD (pr) conflicts with origin/main', async () => {
    const git = simpleGit(workDir);
    const st = await checkForConflicts(git, 'pr', { prBaseBranch: 'main' });
    expect(st.latentConflictWithOrigin).toBe(false);
    expect(st.latentConflictWithPrBase).toBe(true);
    expect(st.latentConflictedFilesWithPrBase).toContain('f.txt');
  });

  it('skips PR-base probe when prBaseBranch equals branch', async () => {
    const git = simpleGit(workDir);
    const st = await checkForConflicts(git, 'pr', { prBaseBranch: 'pr' });
    expect(st.latentConflictWithPrBase).toBe(false);
    expect(st.latentConflictedFilesWithPrBase).toEqual([]);
  });
});
