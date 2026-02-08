/**
 * Lock file utilities for conflict detection
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function isLockFile(filepath: string): boolean {
  return /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|Pipfile\.lock|poetry\.lock|composer\.lock|cargo\.lock)$/i.test(filepath);
}

export function getLockFileInfo(filepath: string): { deletePattern: string; regenerateCmd: string } | null {
  if (filepath.endsWith('package-lock.json')) return { deletePattern: '**/package-lock.json', regenerateCmd: 'npm install' };
  if (filepath.endsWith('yarn.lock')) return { deletePattern: '**/yarn.lock', regenerateCmd: 'yarn install' };
  if (filepath.endsWith('pnpm-lock.yaml')) return { deletePattern: '**/pnpm-lock.yaml', regenerateCmd: 'pnpm install' };
  if (filepath.endsWith('Gemfile.lock')) return { deletePattern: '**/Gemfile.lock', regenerateCmd: 'bundle install' };
  if (filepath.endsWith('Pipfile.lock')) return { deletePattern: '**/Pipfile.lock', regenerateCmd: 'pipenv lock' };
  if (filepath.endsWith('poetry.lock')) return { deletePattern: '**/poetry.lock', regenerateCmd: 'poetry lock' };
  if (filepath.endsWith('composer.lock')) return { deletePattern: '**/composer.lock', regenerateCmd: 'composer install' };
  if (filepath.endsWith('Cargo.lock')) return { deletePattern: '**/Cargo.lock', regenerateCmd: 'cargo build' };
  return null;
}

export function hasConflictMarkers(content: string): boolean {
  return /^<{7}\s|^={7}\s|^>{7}\s/m.test(content);
}

export function findFilesWithConflictMarkers(workdir: string, files: string[]): string[] {
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
