import type { SimpleGit } from 'simple-git';

export interface CommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

export async function squashCommit(
  git: SimpleGit,
  message: string,
  body?: string
): Promise<CommitResult> {
  // Stage all changes
  await stageAll(git);

  // Build commit message
  const fullMessage = body ? `${message}\n\n${body}` : message;

  // Commit
  const result = await git.commit(fullMessage);

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
  };
}

export async function push(git: SimpleGit, branch: string, force = false): Promise<void> {
  const args = force ? ['--force'] : [];
  await git.push('origin', branch, args);
}

export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const result = await git.branch();
  return result.current;
}

export async function getLastCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || '';
}

export function buildCommitMessage(issuesFixed: string[], lessonsLearned: string[]): string {
  const lines: string[] = ['fix: address review comments', ''];

  if (issuesFixed.length > 0) {
    lines.push('Issues addressed:');
    for (const issue of issuesFixed) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (lessonsLearned.length > 0) {
    lines.push('Notes:');
    for (const lesson of lessonsLearned) {
      lines.push(`- ${lesson}`);
    }
  }

  return lines.join('\n');
}
