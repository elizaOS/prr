/**
 * Whether a review path exists as a tracked blob at `HEAD` in `workdir`.
 * **WHY:** Final audit uses full-file/snippet reads that return a placeholder when missing;
 * `git ls-tree` distinguishes "deleted at HEAD" from read errors without relying on throw/empty
 * ambiguity in older Rule 6 checks.
 */

import { execFileSync } from 'child_process';

/**
 * @returns `true` if `path` is listed at `HEAD`, `false` if not tracked at `HEAD`, `null` if git failed.
 */
export function pathTrackedAtGitHead(workdir: string, rawPath: string): boolean | null {
  if (!rawPath || rawPath === '(PR comment)') return null;
  try {
    const gitPath = rawPath.replace(/\\/g, '/');
    const out = execFileSync(
      'git',
      ['ls-tree', '--name-only', 'HEAD', '--', gitPath],
      { cwd: workdir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 2 * 1024 * 1024 },
    ).trim();
    return out.length > 0;
  } catch {
    return null;
  }
}
