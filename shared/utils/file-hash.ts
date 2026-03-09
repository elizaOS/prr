/**
 * Fast content hash for files (status invalidation, chronic-attempt filtering).
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';

function hashBuffer(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 12);
}

/** Async: compute content hash for a file (workdir-relative path). */
export async function hashFileContent(workdir: string, filePath: string): Promise<string> {
  try {
    const content = await readFile(join(workdir, filePath), 'utf-8');
    return hashBuffer(content);
  } catch {
    return '__missing__';
  }
}

/** Sync: compute content hash for an absolute file path. */
export function hashFileContentSync(fullPath: string): string {
  try {
    const content = readFileSync(fullPath, 'utf-8');
    return hashBuffer(content);
  } catch {
    return '__missing__';
  }
}
