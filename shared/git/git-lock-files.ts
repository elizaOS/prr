/**
 * Lock file utilities for conflict detection
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function isLockFile(filepath: string): boolean {
  return /(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|Pipfile\.lock|poetry\.lock|composer\.lock|cargo\.lock)$/i.test(filepath);
}

export function getLockFileInfo(filepath: string): { deletePattern: string; regenerateCmd: string } | null {
  const lower = filepath.toLowerCase();
  if (lower.endsWith('bun.lock')) return { deletePattern: '**/bun.lock', regenerateCmd: 'bun install' };
  if (lower.endsWith('bun.lockb')) return { deletePattern: '**/bun.lockb', regenerateCmd: 'bun install' };
  if (lower.endsWith('package-lock.json')) return { deletePattern: '**/package-lock.json', regenerateCmd: 'npm install' };
  if (lower.endsWith('yarn.lock')) return { deletePattern: '**/yarn.lock', regenerateCmd: 'yarn install' };
  if (lower.endsWith('pnpm-lock.yaml')) return { deletePattern: '**/pnpm-lock.yaml', regenerateCmd: 'pnpm install' };
  if (lower.endsWith('gemfile.lock')) return { deletePattern: '**/Gemfile.lock', regenerateCmd: 'bundle install' };
  if (lower.endsWith('pipfile.lock')) return { deletePattern: '**/Pipfile.lock', regenerateCmd: 'pipenv lock' };
  if (lower.endsWith('poetry.lock')) return { deletePattern: '**/poetry.lock', regenerateCmd: 'poetry lock' };
  if (lower.endsWith('composer.lock')) return { deletePattern: '**/composer.lock', regenerateCmd: 'composer install' };
  if (lower.endsWith('cargo.lock')) return { deletePattern: '**/Cargo.lock', regenerateCmd: 'cargo build' };
  return null;
}

/** Trim leading whitespace so indented conflict markers still match (merge tools rarely indent, but be safe). */
function t(line: string): string {
  return line.trimStart();
}

export function isGitConflictOpenLine(trimmed: string): boolean {
  return trimmed.startsWith('<<<<<<<');
}

export function isGitConflictCloseLine(trimmed: string): boolean {
  return trimmed.startsWith('>>>>>>>');
}

/** True when the line is Git's middle separator only: exactly seven `=` and optional trailing spaces. */
export function isGitConflictMiddleLine(trimmed: string): boolean {
  return /^={7}\s*$/.test(trimmed);
}

/**
 * One-line doc heading above a setext `=======` underline (narrow).
 * WHY: Orphan `=======` between normal sentences (failed merge) must still count as conflict.
 */
function looksLikeSetextHeadingLine(s: string): boolean {
  const line = s.trim();
  if (!line || line.length > 120) return false;
  if (looksLikeCodeOrStructuredLine(line)) return false;
  if (isGitConflictOpenLine(line) || isGitConflictCloseLine(line) || isGitConflictMiddleLine(line)) return false;
  // Multi-word Title Case (e.g. "API Overview")
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s*$/.test(line)) return true;
  // Single capitalized word / phrase token (e.g. "Roadmap", "v2")
  if (/^[A-Z][a-zA-Z0-9.-]{0,48}$/.test(line)) return true;
  // Short ALL CAPS heading
  if (/^[A-Z][A-Z0-9 ,&:+\-]{1,50}$/.test(line) && !/[a-z]/.test(line.slice(1))) return true;
  return false;
}

/**
 * Heuristic: line looks like source, config, or structured markup — not a one-line doc heading.
 */
function looksLikeCodeOrStructuredLine(s: string): boolean {
  if (/^(import|export|default|from)\b/.test(s)) return true;
  if (/^(const|let|var|function|class|interface|type|enum|namespace)\b/.test(s)) return true;
  if (/^(return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|await|async)\b/.test(s)) return true;
  if (/^(def|fn|pub|use|mod|impl|trait)\b/.test(s)) return true;
  if (/^#include\b|^package\b|^module\b/.test(s)) return true;
  if (/^(describe|it|test|expect|beforeEach|afterEach)\b/.test(s)) return true;
  if (/^\s*[`]{3,}/.test(s) || /^```/.test(s.trimStart())) return true;
  if (/^\s*[-*]\s+\[[ x]\]\s/i.test(s)) return true;
  if (/[{][$\w]|[};]\s*$|=>|::|<\/|^\s*[-+*]\s+`/.test(s)) return true;
  if (/^\s*[!%/<>&|[\]]/.test(s)) return true;
  return false;
}

/**
 * Single full line `=======` between a short non-code line and following body — typical setext / doc divider.
 * Only used when there is **no** `<<<<<<<` / `>>>>>>>` anywhere (those always imply conflict).
 */
function isPlausibleMarkdownSevenEqualsDivider(lines: string[], midIdx: number): boolean {
  let p = midIdx - 1;
  while (p >= 0 && lines[p]!.trim() === '') p--;
  if (p < 0) return false;
  const prev = lines[p]!.trim();
  if (!prev || prev.length > 200) return false;
  if (!looksLikeSetextHeadingLine(prev)) return false;
  let n = midIdx + 1;
  while (n < lines.length && lines[n]!.trim() === '') n++;
  if (n >= lines.length) return false;
  const next = lines[n]!.trim();
  if (!next) return false;
  if (isGitConflictOpenLine(next) || isGitConflictCloseLine(next)) return false;
  if (isGitConflictMiddleLine(next)) return false;
  return true;
}

/**
 * True when the file still contains git merge conflict markers or failed cleanup leftovers.
 *
 * Detects:
 * - **`<<<<<<<`** openers (standard regions)
 * - **`>>>>>>>`** closers — including orphan closers from partial cleanup
 * - **`=======`** middle lines: orphan middle, or **multiple** middle-only lines (broken merge); a **single** lone
 *   middle line between a short non-code line and body is treated as markdown setext / divider (not conflict)
 *
 * Uses **trimStart** per line so slightly indented markers still count.
 */
export function hasConflictMarkers(content: string): boolean {
  const lines = content.split('\n');
  let sawOpen = false;
  let sawClose = false;
  const middleIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = t(lines[i]!);
    if (isGitConflictOpenLine(line)) sawOpen = true;
    else if (isGitConflictCloseLine(line)) sawClose = true;
    else if (isGitConflictMiddleLine(line)) middleIndices.push(i);
  }

  if (sawOpen || sawClose) return true;
  if (middleIndices.length === 0) return false;
  if (middleIndices.length >= 2) return true;
  const onlyMid = middleIndices[0]!;
  if (isPlausibleMarkdownSevenEqualsDivider(lines, onlyMid)) return false;
  return true;
}

/**
 * True if a `<<<<<<<` appears again before the first `=======` for that region (nested / botched merge).
 * WHY: Audits showed CHANGELOG prompts with back-to-back `<<<<<<< HEAD` — LLM resolution is unreliable;
 * deterministic keep-ours may also fail; warn the operator early.
 */
export function hasNestedConflictMarkers(content: string): boolean {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ti = t(lines[i]!);
    if (!isGitConflictOpenLine(ti)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const tj = t(lines[j]!);
      if (isGitConflictMiddleLine(tj) || isGitConflictCloseLine(tj)) break;
      if (isGitConflictOpenLine(tj)) return true;
    }
  }
  return false;
}

/**
 * True only when git **open or close** conflict markers appear (`<<<<<<<` / `>>>>>>>`).
 * WHY: `hasConflictMarkers` also flags standalone `=======` lines; markdown (ROADMAP, CHANGELOG)
 * often uses seven equals. Unmerged **index stage-2** blobs from Git should not contain open/close
 * markers — if they do, the blob is corrupt or not a normal ours side. Use this to validate
 * `git show :2:path` before writing deterministic keep-ours (see audit Cycle 66).
 */
export function hasGitConflictOpenOrCloseMarkers(content: string): boolean {
  for (const line of content.split('\n')) {
    const lineTrim = t(line);
    if (isGitConflictOpenLine(lineTrim) || isGitConflictCloseLine(lineTrim)) return true;
  }
  return false;
}

export function findFilesWithConflictMarkers(workdir: string, files: string[]): string[] {
  if (!workdir) return [];

  const conflicted: string[] = [];
  for (const file of files) {
    const fullPath = join(workdir, file);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        if (hasConflictMarkers(content)) {
          conflicted.push(file);
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }
  return conflicted;
}
