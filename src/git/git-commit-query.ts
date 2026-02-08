/**
 * Git information queries
 */
import type { SimpleGit } from 'simple-git';

export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const result = await git.branch();
  return result.current;
}

export async function getLastCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  if (!log.latest) {
    throw new Error('No commits found');
  }
  return log.latest.hash;
}
