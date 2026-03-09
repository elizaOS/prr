/**
 * File snapshots and unified diff generation. Used to capture state before runner and compute diffs after.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTwoFilesPatch } from 'diff';

/**
 * Read listed files from dir. Returns map of relative path -> content. Missing files get ''.
 */
export function snapshotFiles(dir: string, files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of files) {
    const full = join(dir, rel);
    if (!existsSync(full)) {
      map.set(rel, '');
      continue;
    }
    try {
      const content = readFileSync(full, 'utf-8');
      map.set(rel, content);
    } catch {
      map.set(rel, '');
    }
  }
  return map;
}

/**
 * Return the set of paths that changed between before and after.
 */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const path of allPaths) {
    if ((before.get(path) ?? '') !== (after.get(path) ?? '')) out.add(path);
  }
  return out;
}

/**
 * Generate unified diffs for all changed files. Uses (oldStr, newStr) order: before then after.
 */
export function computeDiffs(before: Map<string, string>, after: Map<string, string>): string {
  const parts: string[] = [];
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const path of allPaths) {
    const oldStr = before.get(path) ?? '';
    const newStr = after.get(path) ?? '';
    if (oldStr === newStr) continue;
    const patch = createTwoFilesPatch(path, path, oldStr, newStr, 'before', 'after');
    parts.push(patch);
  }
  return parts.join('\n');
}
