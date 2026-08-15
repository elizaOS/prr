import { execFileSync } from 'child_process';

/**
 * Normalize a repo-relative path for git index lookups.
 */
function normalizeRepoRelativePath(repoRelativePath: string): string {
  return repoRelativePath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/**
 * True when the path is recorded in the index as a git submodule (mode 160000, gitlink).
 *
 * WHY: Review bots often anchor threads on submodule roots (e.g. `plugins/plugin-sql`).
 * There is no regular file text at line N; snippet reads fail and PRR used to dismiss as
 * generic stale / "unreadable". This check uses the index so it works even when the
 * submodule is not checked out in the worktree.
 */
export function isTrackedGitSubmodulePath(workdir: string, repoRelativePath: string): boolean {
  const normalized = normalizeRepoRelativePath(repoRelativePath);
  if (!normalized) return false;
  try {
    const out = execFileSync('git', ['ls-files', '-s', '--', normalized], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024,
    });
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^160000\s+\S+\s+\d\t(.+)$/);
      if (m) {
        const indexedPath = normalizeRepoRelativePath(m[1]!);
        if (indexedPath === normalized) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
