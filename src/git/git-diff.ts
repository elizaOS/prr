/**
 * Git diff and change queries
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

/**
 * Map (path -> (oldLine -> newLine)) from git diff base..head.
 * WHY: After push, review comment line numbers refer to pre-push code; re-mapping
 * reduces WRONG_LOCATION when the fixer looks up code at the comment's line.
 * Only context lines (unchanged) are mapped; deleted/added lines are skipped.
 */
export async function computeLineMapFromDiff(
  git: SimpleGit,
  baseRef: string,
  headRef: string
): Promise<Map<string, Map<number, number>>> {
  const out = new Map<string, Map<number, number>>();
  let raw: string;
  try {
    raw = await git.raw(['diff', `${baseRef}..${headRef}`]);
  } catch (err) {
    debug('Line map diff failed', { baseRef, headRef, error: err instanceof Error ? err.message : String(err) });
    return out;
  }
  const lines = raw.split('\n');
  let path: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const diffFile = line.match(/^diff --git a\/.+? b\/(.+)/);
    if (diffFile) {
      path = diffFile[1];
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && path) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[3], 10);
      continue;
    }
    if (path && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) {
      if (line.startsWith(' ') || line.startsWith('-')) {
        if (line.startsWith(' ')) {
          let fileMap = out.get(path);
          if (!fileMap) {
            fileMap = new Map();
            out.set(path, fileMap);
          }
          fileMap.set(oldLine, newLine);
        }
        oldLine++;
      }
      if (line.startsWith(' ') || line.startsWith('+')) newLine++;
    }
  }
  return out;
}


export async function getChangedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return [...new Set([
          ...status.modified,
          ...status.created,
          ...status.not_added,
          ...status.deleted,
          ...status.renamed.map((r) => r.to),
      ])];
}

export async function getDiff(git: SimpleGit, file?: string): Promise<string> {
  if (file) {
    return git.diff(['--', file]);
  }
  return git.diff();
}

export async function getDiffForFile(git: SimpleGit, file: string): Promise<string> {
  try {
    return await git.diff(['HEAD', '--', file]);
  } catch {
    // File might be new (untracked), try --no-index diff
    try {
      return await git.diff(['--no-index', '/dev/null', file]);
    } catch (err) {
      // Log error but return empty - file may not exist or have permission issues
      debug('Failed to get diff for file', { file, error: err instanceof Error ? err.message : String(err) });
      return '';
    }
  // Note: handles known exit code 1 as a valid case for file differences without failing
  }
}

export async function hasChanges(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

/**
 * Detect if a file has been corrupted by automated fix attempts.
 *
 * Compares the current working tree version against the base branch version.
 * Returns { corrupted: true, reason, baseContent } if the file shows signs of corruption:
 * - Duplicate method/function definitions (≥3 occurrences)
 * - Brace imbalance growth compared to the base version
 * - Tool-artifact remnants (search/replace XML markup)
 * - Diff from base has grown significantly (>2x)
 *
 * @param baseBranch - The base branch to compare against (e.g. "origin/dev")
 * @returns { corrupted: false } if file is healthy, or { corrupted: true, reason?: string, baseContent?: string } if corrupted
 */
export async function detectFileCorruption(
  git: SimpleGit,
  filePath: string,
  baseBranch: string
): Promise<{ corrupted: boolean; reason?: string; baseContent?: string }> {
  try {
    // Get the base branch version of the file
    let baseContent: string;
    try {
      baseContent = await git.show([`${baseBranch}:${filePath}`]);
    } catch {
      // File doesn't exist in base branch — can't be corrupted by us
      return { corrupted: false };
    }

    // Get current working tree content
    let currentContent: string;
    try {
      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const cwd = await git.revparse(['--show-toplevel']);
      currentContent = readFileSync(resolve(cwd.trim(), filePath), 'utf-8');
    } catch {
      return { corrupted: false };
    }

    const baseLines = baseContent.split('\n').length;
    const currentLines = currentContent.split('\n').length;
    const currentLower = currentContent.toLowerCase();

    // Heuristic 1: Duplicate method/function definitions
    // A sign of layered failed search/replace attempts
    // Note: Only match `(` not `<` to avoid false positives on generic type exports like `export type Foo<T>`
    const methodPattern = /(?:public|private|protected|async|export)\s+(?:function\s+)?(\w+)\s*\(/g;
    const methodCounts = new Map<string, number>();
    let match;
    while ((match = methodPattern.exec(currentContent)) !== null) {
      const name = match[1];
      methodCounts.set(name, (methodCounts.get(name) || 0) + 1);
    }
    const duplicateMethods = [...methodCounts.entries()].filter(([, count]) => count >= 3);
    if (duplicateMethods.length > 0) {
      const names = duplicateMethods.map(([name, count]) => `${name}(×${count})`).join(', ');
      return {
        corrupted: true,
        reason: `Duplicate method definitions detected: ${names}`,
        baseContent,
      };
    }

    // Heuristic 2: Orphaned code indicators
    // Unbalanced braces suggest structural damage
    const openBraces = (currentContent.match(/\{/g) || []).length;
    const closeBraces = (currentContent.match(/\}/g) || []).length;
    const braceImbalance = Math.abs(openBraces - closeBraces);
    const baseBraceOpen = (baseContent.match(/\{/g) || []).length;
    const baseBraceClose = (baseContent.match(/\}/g) || []).length;
    const baseBraceImbalance = Math.abs(baseBraceOpen - baseBraceClose);
    if (braceImbalance > baseBraceImbalance + 3) {
      return {
        corrupted: true,
        reason: `Structural damage: brace imbalance grew from ${baseBraceImbalance} to ${braceImbalance}`,
        baseContent,
      };
    }

    // Heuristic 3: Tool artifact remnants inside the code
    if (currentLower.includes('<search>') || currentLower.includes('<replace>') ||
        currentLower.includes('</change>') || currentLower.includes('<change path=')) {
      return {
        corrupted: true,
        reason: 'Tool markup (search/replace XML) found inside source file',
        baseContent,
      };
    }

    // Heuristic 4: File has grown significantly
    if (currentLines > baseLines * 2) {
      return {
        corrupted: true,
        reason: `File length has more than doubled (${baseLines} → ${currentLines} lines)`,
        baseContent,
      };
    }

    return { corrupted: false };
  } catch (err) {
    debug('Corruption detection failed', { filePath, error: err instanceof Error ? err.message : String(err) });
    return { corrupted: false };
  }
}

