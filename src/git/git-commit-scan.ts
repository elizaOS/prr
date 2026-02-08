/**
 * Scan committed fixes from git history
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

export async function scanCommittedFixes(git: SimpleGit, branch: string): Promise<string[]> {
  try {
    // Find the base branch - try common names
    const baseBranches = ['origin/main', 'origin/master', 'origin/develop'];
    let baseBranch: string | null = null;
    
    for (const candidate of baseBranches) {
      try {
        await git.raw(['rev-parse', '--verify', candidate]);
        baseBranch = candidate;
        break;
      } catch {
        // Branch doesn't exist, try next
      }
    }
    
    // If no common base branch found, fall back to searching all history
    // This is less precise but won't fail
    // Note: simple-git doesn't handle --grep properly, so use raw git command
    const logArgs = baseBranch
      ? ['log', '--grep=prr-fix:', '--format=%B', `${baseBranch}..${branch}`]
      : ['log', '--grep=prr-fix:', '--format=%B', '-n', '100'];
    
    debug('scanCommittedFixes', { baseBranch, branch, logArgs });
    const logOutput = await git.raw(logArgs);
    
    const commentIds: string[] = [];
    
    // Parse all prr-fix:ID markers from commit messages
    if (logOutput) {
      const lines = logOutput.split('\n');
      for (const line of lines) {
        const match = line.match(/^prr-fix:(.+)$/);
        if (match) {
          commentIds.push(match[1].trim().toLowerCase());
        }
      }
    }
    
    return commentIds;
  } catch (error) {
    debug('Failed to scan committed fixes', { error });
    return [];
  }
}
