/**
 * Git diff and change queries
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';


export async function getChangedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];
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
  }
}

export async function hasChanges(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

