import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { resolveTrackedPathWithPrFiles } from '../tools/prr/workflow/helpers/solvability.js';

describe('resolveTrackedPathWithPrFiles', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'prr-rttp-'));
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    mkdirSync(join(dir, 'apps/a'), { recursive: true });
    mkdirSync(join(dir, 'lib/b'), { recursive: true });
    writeFileSync(join(dir, 'apps/a/smoke.js'), '//a');
    writeFileSync(join(dir, 'lib/b/smoke.js'), '//b');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: dir });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for ambiguous basename without PR file list', () => {
    expect(resolveTrackedPathWithPrFiles(dir, 'smoke.js', '', undefined)).toBeNull();
  });

  it('picks unique path when it appears in prChangedFiles', () => {
    expect(resolveTrackedPathWithPrFiles(dir, 'smoke.js', '', ['apps/a/smoke.js'])).toBe('apps/a/smoke.js');
  });
});
