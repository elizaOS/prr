/**
 * Path helpers for PRR. Used when building allowedPaths / TARGET FILE(S) so we never
 * send absolute or internal paths to the fixer (avoids "file outside workdir" and wasted LLM calls).
 */

import { join } from 'path';
import { existsSync } from 'fs';

/** Segments that indicate an internal path not under the repo (e.g. .cursor plans, .prr state). */
const INTERNAL_PATH_SEGMENTS = ['.cursor', '.prr', 'root'];

/**
 * Extension variants to try when the review path is not found (pill-output #9).
 * Maps "given extension" -> [candidate extensions to try]. E.g. tsconfig.js often refers to tsconfig.json.
 */
const EXTENSION_VARIANT_MAP: Record<string, string[]> = {
  '.js': ['.json', '.ts', '.jsx', '.mjs', '.cjs'],
  '.ts': ['.tsx', '.js', '.json'],
  '.tsx': ['.ts', '.jsx'],
  '.jsx': ['.tsx', '.js'],
  '.mjs': ['.js', '.cjs'],
  '.cjs': ['.js', '.mjs'],
};

/**
 * Try to resolve a path that doesn't exist by checking common extension variants.
 * WHY: Review comments sometimes reference tsconfig.js when only tsconfig.json exists, or
 * a .ts file when the repo has .tsx; dismissing as "file not found" wastes the fix loop.
 * Returns the first path (original or variant) that exists, or the original path.
 * Mapping rules: see EXTENSION_VARIANT_MAP; .d.ts fragments try same dir and types/ dir.
 *
 * @param workdir - **PR clone root** (absolute path where the target repo is checked out — same as `SimpleGit`'s top-level). **Not** `process.cwd()` of the prr process unless they happen to match.
 * @param path - Repo-relative path from the review comment.
 */
export function tryResolvePathWithExtensionVariants(workdir: string, path: string): string {
  const full = join(workdir, path);
  if (existsSync(full)) return path;
  if (path.endsWith('.d.ts') || path === '.d.ts') {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    const typeDirs = [dir, join(dir, 'types'), 'types', 'typings'];
    for (const d of typeDirs) {
      const candidate = d === '.' ? base : `${d}/${base}`;
      if (existsSync(join(workdir, candidate))) return candidate;
    }
    return path;
  }
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
  const variants = EXTENSION_VARIANT_MAP[ext];
  if (variants) {
    const base = path.slice(0, path.length - ext.length);
    for (const v of variants) {
      const candidate = base + v;
      if (existsSync(join(workdir, candidate))) return candidate;
    }
  }
  return path;
}

/** Top-level dirs that are typical repo source (not node_modules or external package refs from comments). */
const REPO_TOP_LEVEL = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'plugins', 'scripts', 'test', 'tests', 'docs', 'build', 'tools', 'shared',
  '.github', 'config', 'public', 'components', 'db', 'migrations', 'api', 'server', 'client', 'examples',
  'types', 'typings', 'benchmarks',
]);

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

/** Resolution kind from `resolveTrackedPathDetailed` (solvability) — used only for dismissal mapping. */
export type TrackedPathResolutionKind =
  | 'exact'
  | 'suffix'
  | 'body-hint'
  | 'ambiguous'
  | 'missing'
  | 'fragment';

/**
 * True when the review path cannot denote a single repo file (extension-only / bot fragments).
 * WHY: Distinguish from real root files like `.env` — do **not** use "starts with dot, no slash"
 * alone (that would misclassify `.env` as a fragment; pill-output / audit).
 */
export function isReviewPathFragment(rawPath: string): boolean {
  const t = normalizeRepoPath(rawPath);
  if (!t) return true;
  if (t === '.' || t === '..') return true;
  if (/^\.(d\.ts|ts|tsx|js|jsx|mjs|cjs)$/i.test(t)) return true;
  if (!t.includes('/') && /^d\.ts$/i.test(t)) return true;
  return false;
}

/**
 * True when the adversarial **final audit** should not call the LLM for this review path.
 * WHY: GitHub synthetic paths (`(PR comment)`), empty paths, and path **fragments** (e.g. bare `.d.ts`)
 * produce only "(file not found or unreadable)"-style snippets — the model cannot verify code and often
 * returns bogus UNFIXED, wasting tokens (prompts.log / output.log audits).
 */
export function shouldSkipFinalAuditLlmForPath(path: string | undefined | null): boolean {
  const p = path?.trim() ?? '';
  if (!p) return true;
  if (p === '(PR comment)') return true;
  return isReviewPathFragment(p);
}

/**
 * When a tracked file is not found after resolution, pick a single dismissal category.
 * WHY: Same logical case must not flip between missing-file and path-unresolved (pill-output).
 */
export function pathDismissCategoryForNotFound(
  reviewPath: string,
  resolutionKind: TrackedPathResolutionKind
): 'missing-file' | 'path-unresolved' {
  if (resolutionKind === 'fragment' || resolutionKind === 'ambiguous') return 'path-unresolved';
  if (isReviewPathFragment(reviewPath)) return 'path-unresolved';
  return 'missing-file';
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
  if (normalized.includes('node_modules') || normalized.startsWith('dist/')) return false;
  const first = normalized.split('/')[0];
  if (first && !REPO_TOP_LEVEL.has(first) && /^[a-z@][a-z0-9.-]*$/.test(first)) return false;
  return true;
}

/**
 * Filter an array of paths to only those allowed for fix (repo-relative, not internal).
 * Normalizes path segment encoding (e.g. "2F" prefix from URL-encoded "/") so TARGET FILE(S)
 * never show artifacts like "packages/.../2Fmessage-service.test.ts".
 */
export function filterAllowedPathsForFix(paths: string[]): string[] {
  const normalized = paths
    .map(normalizePathSegmentEncoding)
    .map(normalizePathForAllow);
  return [...new Set(normalized)].filter(isPathAllowedForFix);
}
