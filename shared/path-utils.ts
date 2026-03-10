/**
 * Path helpers for PRR. Used when building allowedPaths / TARGET FILE(S) so we never
 * send absolute or internal paths to the fixer (avoids "file outside workdir" and wasted LLM calls).
 */

/** Segments that indicate an internal path not under the repo (e.g. .cursor plans, .prr state). */
const INTERNAL_PATH_SEGMENTS = ['.cursor', '.prr', 'root'];

/**
 * Normalize a path to forward slashes and trim (no leading ./ strip).
 * Use when comparing or splitting paths (e.g. segment count, prefix match).
 */
export function normalizeRepoPath(path: string): string {
  return (path ?? '').trim().replace(/\\/g, '/');
}

/**
 * Normalize for allowed-path set membership: forward slashes + trim + strip leading ./.
 * Use when building allowedSets so " ./foo" and "foo" match.
 */
export function normalizePathForAllow(path: string): string {
  return normalizeRepoPath(path).replace(/^\.\//, '');
}

/**
 * Fix URL-encoding artifacts in path segments (e.g. from GitHub links in comment bodies).
 * A segment like "2Fmessage-service.test.ts" comes from "%2Fmessage..." with % stripped;
 * 2F is hex for '/', so we strip that prefix so the path is valid repo-relative.
 */
export function normalizePathSegmentEncoding(path: string): string {
  const normalized = normalizeRepoPath(path);
  const segments = normalized.split('/').map((seg) => {
    if (/^(2F|2f)[a-zA-Z0-9_.-]/.test(seg)) return seg.slice(2);
    return seg;
  });
  return segments.filter(Boolean).join('/');
}

/**
 * True if the path is safe to use as an allowed path for the fixer (repo-relative, not internal).
 * WHY: Comment bodies can contain absolute paths (e.g. /root/.cursor/plans/foo.plan.md). Adding
 * those to allowedPaths causes "file outside workdir" and wasted LLM calls.
 */
export function isPathAllowedForFix(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (trimmed.startsWith('/')) return false;
  const normalized = normalizeRepoPath(path);
  for (const seg of INTERNAL_PATH_SEGMENTS) {
    if (normalized.includes(`/${seg}/`) || normalized.startsWith(`${seg}/`)) return false;
  }
  return true;
}

/**
 * Filter an array of paths to only those allowed for fix (repo-relative, not internal).
 * Normalizes path segment encoding (e.g. "2F" prefix from URL-encoded "/") so TARGET FILE(S)
 * never show artifacts like "packages/.../2Fmessage-service.test.ts".
 */
export function filterAllowedPathsForFix(paths: string[]): string[] {
  const normalized = paths.map(normalizePathSegmentEncoding);
  return [...new Set(normalized)].filter(isPathAllowedForFix);
}
