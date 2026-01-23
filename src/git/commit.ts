import type { SimpleGit } from 'simple-git';
import { spawn } from 'child_process';
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
 * Push changes to remote with timeout and signal handling.
 * 
 * WHY spawn instead of simple-git: simple-git's promises can't be cancelled,
 * and the underlying git process keeps running even after timeout. Using
 * spawn directly lets us SIGKILL the process on timeout or Ctrl+C.
 * 
 * WHY 60s timeout: Generous for most pushes, but prevents infinite hang
 * if network is unavailable or auth prompt is waiting.
 */
export async function push(git: SimpleGit, branch: string, force = false): Promise<void> {
  const PUSH_TIMEOUT_MS = 60_000; // 60 seconds
  
  // Get the workdir from the git instance
  const workdir = (git as any)._baseDir || process.cwd();
  
  debug('Starting git push', { branch, force, workdir });
  
  const args = ['push', 'origin', branch];
  if (force) args.push('--force');
  
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    gitProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
    gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
    
    // Timeout - kill the process
    const timeout = setTimeout(() => {
      killed = true;
      gitProcess.kill('SIGKILL');
      reject(new Error(`Push timed out after 60 seconds. Check network/auth.\nstderr: ${stderr}`));
    }, PUSH_TIMEOUT_MS);
    
    // Handle Ctrl+C - kill the git process too
    const sigintHandler = () => {
      killed = true;
      gitProcess.kill('SIGKILL');
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
    };
    process.on('SIGINT', sigintHandler);
    
    gitProcess.on('close', (code) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      
      if (killed) return; // Already handled by timeout/sigint
      
      if (code === 0) {
        debug('Git push completed', { branch });
        resolve();
      } else {
        reject(new Error(`Git push failed with code ${code}\nstderr: ${stderr}`));
      }
    });
    
    gitProcess.on('error', (err) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      reject(new Error(`Git push failed: ${err.message}`));
    });
  });
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
