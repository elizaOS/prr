/**
 * Iteration commit logic - commits with prr-fix markers for recovery
 * 
 * WHY this module exists:
 * Iteration commits have special requirements (markers for recovery, skip hooks,
 * specific message format) that don't belong in generic commit operations.
 * 
 * WHY prr-fix markers:
 * On restart after interruption (Ctrl+C, crash), we scan git log for these
 * markers to recover which issues were already verified and committed. This
 * is more reliable than state files which can be lost or corrupted.
 * 
 * WHY skip hooks (--no-verify):
 * Pre-commit hooks are designed for human commits, not automated iterations.
 * They can block automation (e.g., requiring ticket numbers) or add unwanted
 * changes (e.g., auto-formatting that conflicts with fixer output).
 * 
 * USAGE: Called by fix iteration workflow after verification succeeds.
 */
import type { SimpleGit } from 'simple-git';
import { stageAll, runPreCommitChecks, type CommitResult } from './git-commit-core.js';
import { buildCommitMessage, stripMarkdownForCommit } from './git-commit-message.js';

/**
 * Create one commit per file for a set of verified issues (cleaner history).
 * Use when multiple issues were fixed in one iteration — each file gets its own commit.
 */
export async function commitIterationPerFile(
  git: SimpleGit,
  issuesWithDetails: Array<{ commentId: string; filePath: string; comment: string }>,
  iterationNumber: number
): Promise<{ committedIds: string[]; filesCommitted: number }> {
  const committedIds: string[] = [];
  if (issuesWithDetails.length === 0) return { committedIds, filesCommitted: 0 };

  const byFile = new Map<string, typeof issuesWithDetails>();
  for (const issue of issuesWithDetails) {
    const list = byFile.get(issue.filePath) ?? [];
    list.push(issue);
    byFile.set(issue.filePath, list);
  }

  let filesCommitted = 0;
  for (const [filePath, issues] of byFile) {
    await git.add(filePath);
    await runPreCommitChecks(git);

    const staged = await git.diff(['--cached', '--name-only']);
    const stagedFiles = staged ? staged.trim().split('\n').filter(Boolean) : [];
    if (stagedFiles.length === 0) continue;

    const markers = issues.map((i) => `prr-fix:${i.commentId.toLowerCase()}`).join('\n');
    const commitMsg = buildCommitMessage(
      issues.map((i) => ({ filePath: i.filePath, comment: i.comment })),
      []
    );
    const firstLine = commitMsg.split('\n')[0];
    const message = [firstLine, '', `Iteration ${iterationNumber}`, '', markers].join('\n');

    await git.commit(message, { '--no-verify': null });
    for (const i of issues) committedIds.push(i.commentId);
    filesCommitted++;
  }

  return { committedIds, filesCommitted };
}

/**
 * Create a commit for a completed fix iteration with recovery markers
 * 
 * WHY check hasChanges first:
 * Prevents "nothing to commit" errors when the fixer didn't actually modify
 * any files. This can happen if the issue was already fixed or if the fixer
 * determined no changes were needed.
 * 
 * WHY return null instead of throwing:
 * No changes is a valid state, not an error. The caller can decide how to
 * handle it (e.g., log a message, try a different approach).
 * 
 * WHY normalize comment IDs to lowercase:
 * GitHub's GraphQL API sometimes returns IDs with inconsistent casing.
 * Normalizing ensures we can reliably match markers during recovery.
 * 
 * WHY include iteration number:
 * Makes it easy to see the sequence of fix attempts in git log. Also helps
 * identify which iteration a particular fix came from when debugging.
 * 
 * @param git - SimpleGit instance for the repository
 * @param verifiedCommentIds - GitHub comment IDs that were successfully fixed
 * @param iterationNumber - Current iteration count (for logging/tracking)
 * @param fixedIssues - Optional details about what was fixed (for better commit message)
 * @returns Commit result, or null if nothing to commit
 */
export async function commitIteration(
  git: SimpleGit,
  verifiedCommentIds: string[],
  iterationNumber: number,
  fixedIssues?: Array<{ filePath: string; comment: string }>
): Promise<CommitResult | null> {
  // Check if there are changes to commit
  // WHY: Prevents "nothing to commit" errors if fixer made no changes
  const status = await git.status();
  const hasChanges = !status.isClean();
  
  if (!hasChanges || verifiedCommentIds.length === 0) {
    return null; // Nothing to commit
  }

  await stageAll(git);
  await runPreCommitChecks(git);

  const staged = await git.diff(['--cached', '--name-only']);
  const stagedFiles = staged ? staged.trim().split('\n').filter(Boolean) : [];
  if (stagedFiles.length === 0) {
    return null; // Everything was unstaged by pre-commit checks (e.g. tool artifacts, empty test files)
  }

  // Build prr-fix markers for recovery
  // WHY lowercase: GitHub IDs have inconsistent casing, normalize for reliable matching
  const markers = verifiedCommentIds
    .map(id => `prr-fix:${id.toLowerCase()}`)
    .join('\n');
  
  // Generate a meaningful commit message from the fixed issues
  // WHY: Better than generic "fix iteration N" - shows what actually changed
  const commitMsg = fixedIssues && fixedIssues.length > 0
    ? buildCommitMessage(fixedIssues, [])
    : 'fix: address review comments';
  
  const firstLine = commitMsg.split('\n')[0];
  
  // Format: <summary>\n\nIteration N\n\nprr-fix:id1\nprr-fix:id2\n...
  const message = [
    firstLine,
    '',
    `Iteration ${iterationNumber}`,
    '',
    markers,
  ].join('\n');

  // Skip pre-commit hooks for automated commits
  // WHY --no-verify: Hooks are for humans, can block automation or add unwanted changes
  const result = await git.commit(message, { '--no-verify': null });

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
    stagedFiles,
  };
}
