import { describe, expect, it } from 'vitest';
import {
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

  it('detects .git in this checkout', () => {
    expect(hasPrrGitMetadata()).toBe(true);
  });

  it('formatPrrStartupVersionLine includes version', () => {
    const line = formatPrrStartupVersionLine();
    expect(line).toMatch(/^PRR \d+\.\d+\.\d+/);
  });
});
