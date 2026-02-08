/**
 * Iteration commit logic
 */
import type { SimpleGit } from 'simple-git';
import { stageAll, type CommitResult } from './git-commit-core.js';
import { buildCommitMessage, stripMarkdownForCommit } from './git-commit-message.js';

export async function commitIteration(
  git: SimpleGit,
  verifiedCommentIds: string[],
  iterationNumber: number,
  fixedIssues?: Array<{ filePath: string; comment: string }>
): Promise<CommitResult | null> {
  // Check if there are changes to commit
  const status = await git.status();
  const hasChanges = !status.isClean();
  
  if (!hasChanges || verifiedCommentIds.length === 0) {
    return null; // Nothing to commit
  }

  await stageAll(git);

  // Build commit message with prr-fix markers (normalized to lowercase)
  const markers = verifiedCommentIds
    .map(id => `prr-fix:${id.toLowerCase()}`)
    .join('\n');
  
  // Generate a meaningful commit message from the fixed issues
  const commitMsg = fixedIssues && fixedIssues.length > 0
    ? buildCommitMessage(fixedIssues, [])
    : 'fix: address review comments';
  
  const firstLine = commitMsg.split('\n')[0];
  
  const message = [
    firstLine,
    '',
    `Iteration ${iterationNumber}`,
    '',
    markers,
  ].join('\n');

  // Skip pre-commit hooks for automated commits
  const result = await git.commit(message, { '--no-verify': null });

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
  };
}
