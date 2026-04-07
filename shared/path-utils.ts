/**
 * Path helpers for PRR. Used when building allowedPaths / TARGET FILE(S) for the fixer and
 * when normalizing review paths (diff prefixes, extension variants, fragments).
 *
 * ## Allowed paths — WHY open by default (Cycle 72)
 *
 * Historically we rejected any path whose first segment looked like an npm package name unless
 * it appeared in a static `REPO_TOP_LEVEL` list. **WHY that seemed right:** comment bodies can
 * mention paths such as `lodash/fp/merge.js` that must not become editable targets. In practice
 * those paths almost never exist in the clone; `pathExists` / injection already fail safely.
 * **What went wrong:** repos with legitimate top-level dirs not in the static set (`agent/`,
 * `cmd/`, `contracts/`, …) had **every** issue on those files stripped from allowedPaths and
 * injection — the model could not see the file, edits were rejected, and iterations burned with
 * no progress. **Default today:** allow any repo-relative path that passes **hard deny** rules
 * only (absolute paths, `node_modules`, `dist/`, `.cursor` / `.prr` / `root` segments). **Opt-in
 * strict:** `PRR_STRICT_ALLOWED_PATHS=1` restores the first-segment heuristic; then
 * `setDynamicRepoTopLevelDirs(prChangedFiles)` adds first segments from the PR diff so
 * non-standard roots touched by the PR are still allowed without editing the static list.
 */

import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Legacy “package-like first segment” filter for `isPathAllowedForFix`.
 *
 * **WHY it exists:** In strict mode, block paths whose first segment looks like an external
 * package id (`foo-bar/baz`) unless it is in `REPO_TOP_LEVEL` or `dynamicRepoTopLevel`, to reduce
 * noise from pasted dependency paths in review bodies.
 *
 * **WHY default is off:** Same heuristic blocked real monorepo roots; audits showed silent
 * empty allowlists and wrong-file / couldNotInject churn outweighed the rare bad path case.
 */
const strictAllowedPaths = /^(1|true|yes)$/i.test(process.env.PRR_STRICT_ALLOWED_PATHS ?? '');

/** Segments that indicate an internal path not under the repo (e.g. .cursor plans, .prr state). */
const INTERNAL_PATH_SEGMENTS = ['.cursor', '.prr', 'root'];

/**
 * Extension variants to try when the review path is not found (pill-output #9).
 * Maps "given extension" -> [candidate extensions to try]. E.g. tsconfig.js often refers to tsconfig.json.
 */
const EXTENSION_VARIANT_MAP: Record<string, string[]> = {
  '.js': ['.json', '.ts', '.jsx', '.mjs', '.cjs'],
  '.json': ['.js', '.ts', '.cjs', '.mjs'],
  '.ts': ['.tsx', '.js', '.json', '.mts', '.cts'],
  '.tsx': ['.ts', '.jsx'],
  '.jsx': ['.tsx', '.js'],
  '.mjs': ['.js', '.cjs'],
  '.cjs': ['.js', '.mjs'],
};

/**
 * First path segment after `a/` or `b/` must look like a repo root for us to strip (pill / review diff paths).
 * WHY: Avoid turning a real top-level folder literally named `a/` into a wrong path.
 */
const GIT_DIFF_PREFIX_STRIP_FIRST_SEGMENTS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'plugins',
  'scripts',
  'test',
  'tests',
  'docs',
  'build',
  'tools',
  'shared',
  '.github',
  'config',
  'public',
  'components',
  'db',
  'migrations',
  'api',
  'server',
  'client',
  'examples',
  'types',
  'typings',
  'benchmarks',
]);

/**
 * Strip unified-diff `a/` or `b/` prefix from review paths (e.g. `a/packages/foo/bar.ts` → `packages/foo/bar.ts`).
 * See solvability / path resolution (pill-output audit).
 */
export function stripGitDiffPathPrefix(rawPath: string): string {
  const t = normalizeRepoPath(rawPath);
  const m = /^(a|b)\/(.+)$/.exec(t);
  if (!m) return t;
  const rest = m[2]!;
  const first = rest.split('/')[0] ?? '';
  if (!first) return t;
  // WHY dynamicRepoTopLevel: under strict allowed paths, odd roots only strip when in REPO_TOP_LEVEL
  // or PR changed files; open mode does not need it for allow checks but diff paths like
  // `a/agent/foo.ts` still benefit from stripping once `setDynamicRepoTopLevelDirs` ran.
  if (GIT_DIFF_PREFIX_STRIP_FIRST_SEGMENTS.has(first) || dynamicRepoTopLevel.has(first) || first.startsWith('@')) {
    return rest;
  }
  if (first === 'package.json' || first === 'pnpm-lock.yaml' || first === 'bun.lockb') {
    return rest;
  }
  return t;
}

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
  path = stripGitDiffPathPrefix(path);
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

/**
 * Typical first-segment names for repo source trees. **Used when `PRR_STRICT_ALLOWED_PATHS=1`:**
 * together with `dynamicRepoTopLevel`, paths whose first segment matches `/^[a-z@][a-z0-9.-]*$/`
 * must appear here or in the PR changed-file set or they are rejected. **WHY keep the set:**
 * strict mode operators get predictable defaults without listing every possible root. **WHY not
 * rely on this alone:** the list cannot cover every customer repo; open default + dynamic set
 * covers the common failure mode (Cycle 72).
 */
const REPO_TOP_LEVEL = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'plugins', 'scripts', 'test', 'tests', 'docs', 'build', 'tools', 'shared',
  '.github', 'config', 'public', 'components', 'db', 'migrations', 'api', 'server', 'client', 'examples',
  'types', 'typings', 'benchmarks',
  /** E2e / integration roots — WHY: strict mode would otherwise reject Playwright/Cypress trees. */
  'e2e', 'playwright', 'cypress', 'fixtures', 'integration', 'wdio',
]);

/**
 * First path segments seen on files changed in the PR (`git diff --name-only` base...HEAD).
 *
 * **WHY:** When `PRR_STRICT_ALLOWED_PATHS=1`, this extends `REPO_TOP_LEVEL` so roots that only
 * appear in *this* PR (e.g. `agent/`) are not misclassified as “external package” paths.
 * **WHY still call it when strict mode is off:** `stripGitDiffPathPrefix` uses the same set so
 * unified-diff-style paths like `a/agent/foo.ts` normalize correctly after analysis runs.
 */
const dynamicRepoTopLevel = new Set<string>();

/**
 * Record PR top-level segments before building issues / prompts / runner allowlists.
 * **Call site:** `processCommentsAndPrepareFixLoop` after resolving `changedFiles` (fresh diff or
 * analysis cache), before `findUnresolvedIssues`.
 *
 * **WHY before analysis:** `getEffectiveAllowedPathsForNewIssue` → `filterAllowedPathsForFix` runs
 * during issue construction; without this, strict mode + cache miss would filter valid targets.
 */
export function setDynamicRepoTopLevelDirs(changedFiles: string[]): void {
  dynamicRepoTopLevel.clear();
  for (const file of changedFiles) {
    const normalized = normalizeRepoPath(file);
    const first = normalized.split('/')[0];
    if (!first || first === '.' || first === '..') continue;
    if (first === 'node_modules' || first === 'dist') continue;
    if (INTERNAL_PATH_SEGMENTS.some(seg => first === seg)) continue;
    dynamicRepoTopLevel.add(first);
  }
}

/** Visible for testing. */
export function getDynamicRepoTopLevelDirs(): ReadonlySet<string> {
  return dynamicRepoTopLevel;
}

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
 * Whether a string may appear in the fixer allowlist / injection set.
 *
 * **Always denied (hard rules — WHY):**
 * - Absolute paths — would escape the clone or hit host paths from pasted plans.
 * - `.cursor`, `.prr`, leading `root/` segment — tool state, not PR product code.
 * - `node_modules` (anywhere), `dist/` prefix — generated or vendored; editing is unsafe/noisy.
 *
 * **Optional strict segment rule:** When `PRR_STRICT_ALLOWED_PATHS=1`, reject paths whose first
 * segment looks like a package id unless it is in `REPO_TOP_LEVEL` or `dynamicRepoTopLevel`.
 * **Default (strict off):** any other repo-relative path is allowed so reviews can target
 * adjacent files and uncommon roots without silent stripping (see file-level WHY above).
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
  if (strictAllowedPaths) {
    const first = normalized.split('/')[0];
    if (first && !REPO_TOP_LEVEL.has(first) && !dynamicRepoTopLevel.has(first) && /^[a-z@][a-z0-9.-]*$/.test(first)) return false;
  }
  return true;
}

/**
 * Deduplicate and filter paths through `isPathAllowedForFix`.
 * **WHY normalize encoding first:** GitHub-linked comments can leave `%2F` artifacts as `2F` in
 * a segment; we fix that so TARGET FILE(S) and runner sets stay consistent (pill-output audit).
 */
export function filterAllowedPathsForFix(paths: string[]): string[] {
  const normalized = paths
    .map(normalizePathSegmentEncoding)
    .map(normalizePathForAllow);
  return [...new Set(normalized)].filter(isPathAllowedForFix);
}
