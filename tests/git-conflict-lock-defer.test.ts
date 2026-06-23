import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  lockRegenerationRequiresCleanPackageJson,
  packageJsonHasConflictMarkers,
} from '../tools/prr/git/git-conflict-lockfiles.js';

describe('lock regeneration vs package.json', () => {
  it('lockRegenerationRequiresCleanPackageJson is true for bun/npm/yarn/pnpm locks', () => {
    expect(lockRegenerationRequiresCleanPackageJson(['bun.lock'])).toBe(true);
    expect(lockRegenerationRequiresCleanPackageJson(['package-lock.json'])).toBe(true);
    expect(lockRegenerationRequiresCleanPackageJson(['yarn.lock'])).toBe(true);
    expect(lockRegenerationRequiresCleanPackageJson(['pnpm-lock.yaml'])).toBe(true);
  });

  it('lockRegenerationRequiresCleanPackageJson is false for non-JS lockfiles', () => {
    expect(lockRegenerationRequiresCleanPackageJson(['Cargo.lock'])).toBe(false);
    expect(lockRegenerationRequiresCleanPackageJson(['Gemfile.lock'])).toBe(false);
  });

  it('packageJsonHasConflictMarkers detects markers', () => {
    const dir = join(tmpdir(), `prr-pkg-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'package.json'),
        '{\n  "name": "x"\n<<<<<<< HEAD\n}\n=======\n,\n"b":1\n}\n>>>>>>> other\n',
        'utf-8'
      );
      expect(packageJsonHasConflictMarkers(dir)).toBe(true);
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}', 'utf-8');
      expect(packageJsonHasConflictMarkers(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
