import { existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  findPrrGitMetadataDir,
  formatPrrStartupVersionLine,
  getPrrPackageRoot,
  getPrrPackageVersion,
  hasPrrGitMetadata,
} from '../shared/prr-runtime-meta.js';

describe('prr-runtime-meta', () => {
  it('finds this repo package root and version from package.json', () => {
    const root = getPrrPackageRoot();
    expect(root).toMatch(/prr$/);
    const v = getPrrPackageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('detects .git walking up from package root', () => {
    expect(hasPrrGitMetadata()).toBe(true);
    const gitDir = findPrrGitMetadataDir();
    expect(gitDir).toBeDefined();
    expect(existsSync(join(gitDir!, '.git'))).toBe(true);
    const pkg = getPrrPackageRoot();
    expect(gitDir === pkg || pkg.startsWith(gitDir! + '/') || pkg.startsWith(gitDir! + '\\')).toBe(true);
  });

  it('formatPrrStartupVersionLine includes version', () => {
    const line = formatPrrStartupVersionLine();
    expect(line).toMatch(/^PRR \d+\.\d+\.\d+/);
  });
});
