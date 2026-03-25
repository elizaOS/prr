/**
 * PRR package version and optional source revision for startup logs and CI provenance.
 *
 * WHY: Operators need to confirm which tool revision ran (especially when PRR is vendored
 * or only dist/ is copied). We show package.json version always; revision from env or
 * `git rev-parse` only when `.git` exists in the prr package root.
 *
 * WHY not GITHUB_SHA: In downstream workflows that runs inside another repo, GITHUB_SHA is
 * that repo's head — not the PRR checkout. Use PRR_GIT_SHA when you want to stamp the PRR commit.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

function getModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Walk up from this file until we find package.json with `"name": "prr"`.
 * Works for source (`shared/`) and compiled (`dist/shared/`) layouts.
 */
export function getPrrPackageRoot(): string {
  let dir = getModuleDir();
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
      if (pkg.name === 'prr') return dir;
    } catch {
      /* missing or invalid */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(getModuleDir(), '..', '..');
}

/** True when the prr root looks like a git checkout (`.git` file or dir, including worktrees). */
export function hasPrrGitMetadata(): boolean {
  return existsSync(join(getPrrPackageRoot(), '.git'));
}

let cachedVersion: string | undefined;

export function getPrrPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const pkgPath = join(getPrrPackageRoot(), 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    cachedVersion = pkg.version?.trim() || '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** Short display for env-provided SHA (40-char → 7). */
function normalizeRevDisplay(raw: string): string {
  const t = raw.trim();
  if (/^[0-9a-f]{40}$/i.test(t)) return t.slice(0, 7);
  return t;
}

/**
 * Optional source revision: PRR_GIT_SHA or PRR_SOURCE_COMMIT (short or full SHA), else
 * `git rev-parse --short HEAD` in the prr package root **only if** `.git` exists there
 * (avoids calling git for vendored / npm-packaged trees with no repo metadata).
 */
export function getPrrSourceRevision(): string | undefined {
  const env = process.env.PRR_GIT_SHA?.trim() || process.env.PRR_SOURCE_COMMIT?.trim();
  if (env) return normalizeRevDisplay(env);
  if (!hasPrrGitMetadata()) return undefined;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: getPrrPackageRoot(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/** CI hint only when prr isn’t a git checkout and no env stamp — vendored/copied install. */
export function shouldSuggestPrrGitShaInCi(): boolean {
  if (process.env.CI !== 'true') return false;
  if (process.env.PRR_GIT_SHA?.trim() || process.env.PRR_SOURCE_COMMIT?.trim()) return false;
  if (hasPrrGitMetadata()) return false;
  return true;
}

/** One-line label for console / output.log (no secrets). */
export function formatPrrStartupVersionLine(): string {
  const v = getPrrPackageVersion();
  const rev = getPrrSourceRevision();
  if (!rev) return `PRR ${v}`;
  return `PRR ${v} (${rev})`;
}
