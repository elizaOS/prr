import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

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

/**
 * Push changes to remote with timeout.
 * 
 * WHY timeout: Git push can hang indefinitely if:
 * - Network is slow/unavailable
 * - Auth prompt is waiting (but we can't respond in non-interactive mode)
 * - Remote is unreachable
 * 
 * 60 second timeout is generous for most pushes.
 */
export async function push(git: SimpleGit, branch: string, force = false): Promise<void> {
  const PUSH_TIMEOUT_MS = 60_000; // 60 seconds
  
  debug('Starting git push', { branch, force });
  
  const args = force ? ['--force'] : [];
  
  const pushPromise = git.push('origin', branch, args);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Push timed out after 60 seconds. Check network/auth.')), PUSH_TIMEOUT_MS);
  });
  
  await Promise.race([pushPromise, timeoutPromise]);
  debug('Git push completed', { branch });
}

export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const result = await git.branch();
  return result.current;
}

export async function getLastCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || '';
}

/**
 * Strip markdown/HTML formatting from text for use in commit messages
 */
export function stripMarkdownForCommit(text: string): string {
  return text
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove markdown emphasis (_text_, *text*, **text**, ~~text~~)
    .replace(/[_*~]{1,2}([^_*~]+)[_*~]{1,2}/g, '$1')
    // Remove markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove common review comment prefixes/emoji patterns
    .replace(/^[⚠️🔴🟡🟢✅❌💡📝🐛]+\s*/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
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
