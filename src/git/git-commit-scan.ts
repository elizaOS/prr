/**
 * Scan committed fixes from git history - recovery from interruption
 * 
 * WHY this module exists:
 * When prr is interrupted (Ctrl+C, crash, timeout), in-memory state is lost.
 * But git commits are durable. By scanning commit messages for prr-fix markers,
 * we can recover which issues were already verified without re-running verifications.
 * 
 * WHY scan git log instead of state files:
 * - Git commits can't be corrupted or deleted accidentally
 * - Works even if state file is missing or outdated
 * - Provides audit trail of what was actually committed
 * 
 * USAGE: Called at startup to restore verification state from previous runs.
 */
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

/**
 * Scan git commit messages for prr-fix markers to recover verification state
 * 
 * WHY scan only branch-specific commits:
 * Using `base..branch` range ensures we only look at commits created in this PR branch.
 * This prevents false positives from merged commits or commits from other branches.
 * 
 * WHY try multiple base branches:
 * Different repos use different default branch names (main, master, develop).
 * We try common names to maximize compatibility without requiring configuration.
 * 
 * WHY fallback to last 100 commits:
 * If we can't find a base branch (rare), limit search to recent history to avoid
 * scanning thousands of commits. 100 is generous - typical PRs have far fewer.
 * 
 * WHY use raw() instead of simple-git's log():
 * simple-git doesn't support --grep properly, and we need exact control over
 * the git log command for reliable marker detection.
 * 
 * WHY normalize to lowercase:
 * GitHub comment IDs sometimes have inconsistent casing. Normalizing ensures
 * reliable matching against the IDs from the API.
 * 
 * WHY return empty array on error:
 * Failure to scan is not fatal - we'll just start with no recovered state and
 * verify everything fresh. Throwing would prevent startup on minor git issues.
 * 
 * @param git - SimpleGit instance for the repository
 * @param branch - Current PR branch name
 * @returns Array of comment IDs that were previously committed (empty on error)
 */
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
    // WHY limit to 100: Prevents scanning thousands of commits in large repos
    // WHY still safe: Typical PRs have < 20 commits, 100 is very generous
    const logArgs = baseBranch
      ? ['log', '--grep=prr-fix:', '--format=%B', `${baseBranch}..${branch}`]
      : ['log', '--grep=prr-fix:', '--format=%B', '-n', '100'];
    
    debug('scanCommittedFixes', { baseBranch, branch, logArgs });
    const logOutput = await git.raw(logArgs);
    
    const commentIds: string[] = [];
    
    // Parse all prr-fix:ID markers from commit messages
    // Format: One marker per line: "prr-fix:IC_kwDOAbc123_defGHI"
    if (logOutput) {
      const lines = logOutput.split('\n');
      for (const line of lines) {
        const match = line.match(/^prr-fix:(.+)$/);
        if (match) {
          // Preserve original casing from commit messages.
          // WHY NOT lowercase: The state's verifiedFixed array stores IDs in
          // their original case (from the GitHub API). Lowercasing here causes
          // case-sensitive includes() checks to miss existing entries, leading
          // to duplicate IDs accumulating across sessions.
          commentIds.push(match[1].trim());
        }
      }
    }
    
    // Deduplicate: the same ID can appear in multiple commits
    // (e.g., re-verified after a push, or re-committed after interruption)
    return [...new Set(commentIds)];
  } catch (error) {
    // WHY catch and return empty instead of throw:
    // Scan failure shouldn't prevent startup - we'll just verify everything fresh
    debug('Failed to scan committed fixes', { error });
    return [];
  }
}
