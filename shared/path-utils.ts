/**
 * Path helpers for PRR. Used when building allowedPaths / TARGET FILE(S) so we never
 * send absolute or internal paths to the fixer (avoids "file outside workdir" and wasted LLM calls).
 */

/** Segments that indicate an internal path not under the repo (e.g. .cursor plans, .prr state). */
const INTERNAL_PATH_SEGMENTS = ['.cursor', '.prr', 'root'];

/**
 * True if the path is safe to use as an allowed path for the fixer (repo-relative, not internal).
 * WHY: Comment bodies can contain absolute paths (e.g. /root/.cursor/plans/foo.plan.md). Adding
 * those to allowedPaths causes "file outside workdir" and wasted LLM calls.
 */
export function isPathAllowedForFix(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (trimmed.startsWith('/')) return false;
  const normalized = trimmed.replace(/\\/g, '/');
  for (const seg of INTERNAL_PATH_SEGMENTS) {
    if (normalized.includes(`/${seg}/`) || normalized.startsWith(`${seg}/`)) return false;
  }
  return true;
}

/**
 * Filter an array of paths to only those allowed for fix (repo-relative, not internal).
 */
export function filterAllowedPathsForFix(paths: string[]): string[] {
  return paths.filter(isPathAllowedForFix);
}
