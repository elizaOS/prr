/**
 * Restore-from-base heuristic: when the fixer output says the file is corrupted
 * or to restore from base, run `git show origin/<base>:<path>` and write the
 * file so the next iteration gets a clean slate instead of retrying on corrupted content.
 */
import type { SimpleGit } from 'simple-git';
import { resolve } from 'path';
import { writeFileSync } from 'fs';
import { debug } from '../logger.js';
import { PROTECTED_DIRS } from '../git/git-commit-core.js';
import type { UnresolvedIssue } from '../analyzer/types.js';

/**
 * Parse fixer/LLM output for "restore from base" or "file corrupted" intent.
 * Returns the path to restore if found (from regex or first unresolved issue), or null.
 */
export function parseRestoreFromBaseIntent(
  output: string,
  unresolvedIssues: UnresolvedIssue[]
): string | null {
  if (!output || output.length < 20) return null;
  const hasIntent =
    /restore\s+(?:this\s+)?file\s+from\s+base/i.test(output) ||
    /file\s+(?:is|has\s+been)\s+corrupted/i.test(output) ||
    /restore\s+from\s+base/i.test(output) ||
    /git\s+show\s+origin\/\S+:\S+/.test(output);
  if (!hasIntent) return null;

  // Try to extract path from "git show origin/dev:path" style
  const gitShowMatch = output.match(/git\s+show\s+origin\/[^\s:]+:([^\s>\n]+)/i);
  if (gitShowMatch && gitShowMatch[1]) {
    const path = gitShowMatch[1].trim();
    if (path && !path.includes('..') && path.length < 300) return path;
  }

  // Fallback: single unresolved issue's file
  if (unresolvedIssues.length === 1) return unresolvedIssues[0].comment.path;
  if (unresolvedIssues.length > 1) {
    // Prefer a path that appears in the output (e.g. "restore lib/privy-sync.ts from base")
    for (const issue of unresolvedIssues) {
      const p = issue.comment.path;
      if (output.includes(p)) return p;
    }
    return null;
  }
  return null;
}

/**
 * Restore a single file from the base branch. Returns the path if successful, null otherwise.
 * Skips protected dirs and validates path is under workdir.
 */
export async function restoreFileFromBase(
  git: SimpleGit,
  workdir: string,
  baseBranch: string,
  filePath: string
): Promise<string | null> {
  if (PROTECTED_DIRS.some((dir) => filePath.startsWith(dir))) {
    debug('Restore from base: skipping protected path', { filePath });
    return null;
  }
  const absolutePath = resolve(workdir, filePath);
  if (!absolutePath.startsWith(resolve(workdir))) {
    debug('Restore from base: path escapes workdir', { filePath });
    return null;
  }
  try {
    const content = await git.show([`origin/${baseBranch}:${filePath}`]);
    writeFileSync(absolutePath, content, 'utf-8');
    debug('Restored file from base', { filePath, baseBranch });
    return filePath;
  } catch (e) {
    debug('Restore from base failed', {
      filePath,
      baseBranch,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * If fixer output requests restoring a file from base, do it and return the path restored; else null.
 */
export async function tryRestoreFromBaseIfRequested(
  git: SimpleGit,
  workdir: string,
  baseBranch: string,
  fixerOutput: string,
  unresolvedIssues: UnresolvedIssue[]
): Promise<string | null> {
  const path = parseRestoreFromBaseIntent(fixerOutput, unresolvedIssues);
  if (!path || !baseBranch) return null;
  return restoreFileFromBase(git, workdir, baseBranch, path);
}
