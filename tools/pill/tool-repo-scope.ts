/**
 * Post-filter pill improvements so pill-output.md lists only paths in THIS monorepo
 * (tools/, shared/, tests/, docs/, …), not paths from the PR clone described in logs.
 *
 * WHY: Logs are full of clone paths (apps/, src/, packages/); the audit LLM often echoes them.
 * Default ON when targetDir contains tools/prr (this layout). Opt out: PILL_TOOL_REPO_SCOPE_FILTER=0.
 */
import { existsSync } from 'fs';
import { join, posix } from 'path';

/** Path prefixes allowed when tool-repo scope filter is active (posix-style, trailing slash). */
export const TOOL_REPO_PATH_PREFIXES = [
  'tools/',
  'shared/',
  'tests/',
  'docs/',
  'generated/',
  '.cursor/',
  '.github/',
] as const;

/** Root files allowed when filter is active (no slash). */
export const TOOL_REPO_ROOT_FILES = new Set([
  'AGENTS.md',
  'README.md',
  'DEVELOPMENT.md',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.workspace.ts',
  '.env.example',
  '.gitignore',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.cjs',
  'bun.lock',
  'bun.lockb',
]);

function isSafeRepoRelativePath(normalized: string): boolean {
  const parts = normalized.split('/');
  let depth = 0;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (depth === 0) return false;
      depth--;
    } else {
      depth++;
    }
  }
  return true;
}

/** Normalize LLM `file` field to a safe repo-relative posix path, or "" if invalid. */
export function normalizeImprovementFilePath(file: string): string {
  let p = file.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (!p) return '';
  const normalized = posix.normalize(p);
  if (posix.isAbsolute(normalized)) return '';
  if (!isSafeRepoRelativePath(normalized)) return '';
  return normalized;
}

/** True if path is under this repo’s tool layout (when filter applies). */
export function isPathInToolRepositoryScope(normalizedPath: string): boolean {
  if (!normalizedPath) return false;
  if (TOOL_REPO_ROOT_FILES.has(normalizedPath)) return true;
  for (const pre of TOOL_REPO_PATH_PREFIXES) {
    const dir = pre.slice(0, -1);
    if (normalizedPath === dir || normalizedPath.startsWith(pre)) return true;
  }
  return false;
}

export function detectToolMonorepoLayout(targetDir: string): boolean {
  try {
    return existsSync(join(targetDir, 'tools', 'prr'));
  } catch {
    return false;
  }
}

/**
 * Whether to apply the scope filter. Env overrides auto-detect:
 * - 0 / false / off / no → off
 * - 1 / true / on / yes → on
 * - unset → on iff tools/prr exists under targetDir
 */
export function resolveToolRepoScopeFilter(targetDir: string, envValue: string | undefined): boolean {
  const v = envValue?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  return detectToolMonorepoLayout(targetDir);
}

export interface FileRef {
  file: string;
}

export function filterImprovementsByToolRepoScope<T extends FileRef>(items: T[]): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  for (const item of items) {
    const n = normalizeImprovementFilePath(item.file);
    if (isPathInToolRepositoryScope(n)) kept.push(item);
  }
  return { kept, dropped: items.length - kept.length };
}
