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

export function hasConflictMarkers(content: string): boolean {
  return /^<{7}\s|^={7}\s|^>{7}\s/m.test(content);
}

/**
 * True if a `<<<<<<<` appears again before the first `=======` for that region (nested / botched merge).
 * WHY: Audits showed CHANGELOG prompts with back-to-back `<<<<<<< HEAD` — LLM resolution is unreliable;
 * deterministic keep-ours may also fail; warn the operator early.
 */
export function hasNestedConflictMarkers(content: string): boolean {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('<<<<<<<')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.startsWith('=======') || line.startsWith('>>>>>>>')) break;
      if (line.startsWith('<<<<<<<')) return true;
    }
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
