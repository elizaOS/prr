/**
 * Git merge operations
 */
import type { SimpleGit } from 'simple-git';
import { spawn } from 'child_process';
import { debug } from '../logger.js';

/**
 * Continue an in-progress rebase without opening an editor.
 * Sets GIT_EDITOR=true then runs git.rebase(['--continue']).
 * WHY: git rebase --continue invokes the configured editor (e.g. nano) to edit the
 * commit message. In non-interactive environments (prr workdir, CI) there is no TTY,
 * so the editor fails with "Standard input is not a terminal" or "problem with the
 * editor 'editor'. Please supply the message using -m or -F". GIT_EDITOR=true is a
 * no-op that exits 0, so git keeps the default (replayed) message. One helper for
 * all rebase --continue call sites keeps behavior consistent.
 */
export async function continueRebase(git: SimpleGit): Promise<void> {
  process.env.GIT_EDITOR = 'true';
  await git.rebase(['--continue']);
}

export async function getConflictedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return status.conflicted || [];
}

export async function abortMerge(git: SimpleGit): Promise<void> {
  try {
    await git.merge(['--abort']);
  } catch {
    // May fail if no merge in progress, ignore
  }
}

/** Run a git command in workdir with stdout/stderr suppressed so we don't flood the user with "fatal: No rebase in progress" etc. */
async function gitQuiet(workdir: string, args: string[]): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd: workdir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.on('close', (code) => resolve({ exitCode: code }));
    proc.on('error', () => resolve({ exitCode: null }));
  });
}

export async function cleanupGitState(git: SimpleGit): Promise<void> {
  debug('Cleaning up git state');

  let workdir: string;
  try {
    workdir = (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    workdir = (git as { _baseDir?: string })._baseDir ?? process.cwd();
  }

  // Run abort/reset/clean with stderr suppressed so user doesn't see "fatal: No merge in progress" etc.
  const m = await gitQuiet(workdir, ['merge', '--abort']);
  if (m.exitCode === 0) debug('Aborted in-progress merge');
  const r = await gitQuiet(workdir, ['rebase', '--abort']);
  if (r.exitCode === 0) debug('Aborted in-progress rebase');
  const c = await gitQuiet(workdir, ['cherry-pick', '--abort']);
  if (c.exitCode === 0) debug('Aborted in-progress cherry-pick');
  const reset = await gitQuiet(workdir, ['reset', '--hard', 'HEAD']);
  if (reset.exitCode === 0) debug('Reset to HEAD');
  const clean = await gitQuiet(workdir, ['clean', '-fd']);
  if (clean.exitCode === 0) debug('Cleaned untracked files');
}

export interface MergeBaseResult {
  success: boolean;
  alreadyUpToDate?: boolean;
  conflictedFiles?: string[];
  error?: string;
}

/**
 * Ensure git user.name and user.email are set in the repo so merge/commit don't fail with
 * "Committer identity unknown". In CI (GITHUB_ACTIONS) use the standard bot identity;
 * otherwise use a safe local default so PRR works without global git config.
 */
export async function ensureGitIdentity(git: SimpleGit): Promise<void> {
  try {
    const name = await git.raw(['config', '--get', 'user.name']).then(s => s?.trim());
    if (name && name.length > 0) return;
  } catch {
    // user.name not set
  }
  const inCI = process.env.GITHUB_ACTIONS === 'true';
  const userName = inCI ? 'github-actions[bot]' : 'PRR';
  const userEmail = inCI ? '41898282+github-actions[bot]@users.noreply.github.com' : 'prr@local';
  await git.raw(['config', 'user.name', userName]);
  await git.raw(['config', 'user.email', userEmail]);
  debug('Set git identity for merge/commit', { userName, userEmail });
}

export interface MergeBaseBranchOptions {
  /** When true, do not short-circuit with merge-base; always run git merge. Use when GitHub reports mergeableState === 'behind' so the source branch is actually updated with the target. */
  forceMerge?: boolean;
  /** When true, use --no-ff so a merge commit is always created when there are incoming commits (never fast-forward). Ensures we have a commit to push and GitHub stops showing "out of date with base branch". */
  noFastForward?: boolean;
}

export async function mergeBaseBranch(
  git: SimpleGit,
  baseBranch: string,
  options?: MergeBaseBranchOptions
): Promise<MergeBaseResult> {
  debug('Merging base branch into PR branch', { baseBranch, forceMerge: options?.forceMerge });
  await ensureGitIdentity(git);

  try {
    // WHY explicit refspec: On --single-branch clones the default fetch config only
    // includes the PR branch; a plain fetch does not update origin/<baseBranch>, so
    // the ref can be stale and the merge-base check incorrectly reports "already up-to-date".
    debug('Fetching base branch with explicit refspec', { baseBranch });
    await git.raw(['remote', 'set-branches', '--add', 'origin', baseBranch]);
    await git.fetch(['origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
    
    // Check if we're already up-to-date before trying merge (skip when forceMerge: GitHub said "behind")
    if (!options?.forceMerge) {
      const headSha = await git.revparse(['HEAD']);
      const baseSha = await git.revparse([`origin/${baseBranch}`]);
      const mergeBase = await git.raw(['merge-base', 'HEAD', `origin/${baseBranch}`]).then(s => s.trim());
      if (baseSha.trim() === mergeBase) {
        debug('Already up-to-date with base branch');
        return { success: true, alreadyUpToDate: true };
      }
    }
    
    // Try to merge (--no-ff when requested so we always create a merge commit and have something to push)
    const mergeArgs: string[] = [`origin/${baseBranch}`, '--no-edit'];
    if (options?.noFastForward) mergeArgs.push('--no-ff');
    const headBefore = (await git.revparse(['HEAD'])).trim();
    debug('Attempting merge', { noFastForward: options?.noFastForward, headBefore: headBefore.slice(0, 10) });
    const result = await git.merge(mergeArgs);
    const headAfter = (await git.revparse(['HEAD'])).trim();
    debug('Merge completed', { headBefore: headBefore.slice(0, 10), headAfter: headAfter.slice(0, 10), headMoved: headBefore !== headAfter });
    
    // Detect "Already up to date": simple-git's MergeResult (PullResult & MergeDetail)
    // does not store the "Already up to date" text in any parsed field — the line parsers
    // don't match it, so all fields stay at defaults (result: "success", files: [], etc.).
    // JSON.stringify therefore never contains "Already up to date", making the old string
    // check silently fail. Instead, compare HEAD before/after: if HEAD didn't move, the
    // merge was a no-op regardless of what simple-git reports.
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    const textSaysUpToDate = resultStr.includes('Already up to date') || resultStr.includes('Already up-to-date');
    const headDidNotMove = headBefore === headAfter;
    if (textSaysUpToDate || headDidNotMove) {
      debug('Merge says already up-to-date', { textSaysUpToDate, headDidNotMove });
      return { success: true, alreadyUpToDate: true };
    }
    
    debug('Merge successful');
    return { success: true, alreadyUpToDate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug('Merge failed', { error: message });
    
    // "Already up to date" can come as an error in some git versions
    if (message.includes('Already up to date') || message.includes('Already up-to-date')) {
      return { success: true, alreadyUpToDate: true };
    }
    
    // Check for conflicts
    const status = await git.status();
    if (status.conflicted && status.conflicted.length > 0) {
      await abortMerge(git);
      return { 
        success: false, 
        conflictedFiles: status.conflicted,
        error: 'Merge conflicts detected'
      };
    }
    
    await abortMerge(git);
    return { success: false, error: message };
  }
}

export async function startMergeForConflictResolution(
  git: SimpleGit,
  baseBranch: string,
  mergeMessage: string
): Promise<{ conflictedFiles: string[]; error?: string }> {
  debug('Starting merge for conflict resolution', { baseBranch });
  
  try {
    // WHY explicit refspec: Same as mergeBaseBranch — ensure origin/<baseBranch> is
    // up-to-date so the merge we're about to start sees the real remote tip.
    try {
      await git.fetch(['origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
    } catch {
      // May fail if branch doesn't exist on remote
    }
    
    // Start the merge (will fail with conflicts, that's expected). Only suppress conflict errors;
    // other failures (e.g. ref not found, permission) must propagate so callers don't assume conflicts.
    try {
      await git.merge([`origin/${baseBranch}`, '--no-commit']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConflict = /CONFLICT|conflict|Automatic merge failed|fix conflicts/i.test(msg);
      if (!isConflict) {
        debug('Merge failed (non-conflict), rethrowing', { error: msg });
        throw err;
      }
    }
    
    // Get conflicted files
    const status = await git.status();
    const conflictedFiles = status.conflicted || [];
    
    if (conflictedFiles.length === 0) {
      // No conflicts - either complete the merge or abort if nothing to merge
      if (!status.isClean()) {
        // Staged changes exist from merge - commit them
        const commitResult = await completeMerge(git, mergeMessage);
        if (!commitResult.success) {
          await abortMerge(git);
          return { conflictedFiles: [], error: commitResult.error || 'Failed to complete merge' };
        }
      } else {
        // No changes and no conflicts - merge was a no-op, abort merge state
        await abortMerge(git);
      }
    }

    debug('Merge started, conflicts', { conflictedFiles });
    return { conflictedFiles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { conflictedFiles: [], error: message };
  }
}

export async function markConflictsResolved(git: SimpleGit, files: string[]): Promise<void> {
  debug('Marking conflicts as resolved', { files });
  for (const file of files) {
    await git.add(file);
  }
}

/**
 * Resolve the real git directory (handles worktrees where .git is a file with "gitdir: <path>").
 * WHY: In worktrees, join(root, '.git') is a file; we must read it and resolve the path so
 * existsSync(rebase-merge) works. Shared by completeMerge and repository.ts pull conflict loop.
 */
export async function getResolvedGitDir(git: SimpleGit): Promise<string> {
  const { readFileSync, statSync } = await import('fs');
  const { join, resolve: pathResolve, dirname } = await import('path');
  const root = await git.revparse(['--show-toplevel']).catch(() => null);
  const gitDirRaw = root ? join(root.trim(), '.git') : (await git.revparse(['--git-dir'])).trim();
  const rootDir = root ? pathResolve(root.trim()) : null;
  try {
    const stat = statSync(gitDirRaw);
    if (stat.isFile()) {
      const content = readFileSync(gitDirRaw, 'utf-8');
      const m = content.match(/^gitdir:\s*(.+)$/m);
      const target = m ? m[1].trim() : null;
      const base = rootDir ?? pathResolve(dirname(gitDirRaw));
      return target ? pathResolve(base, target) : pathResolve(gitDirRaw);
    }
    return pathResolve(gitDirRaw);
  } catch {
    return pathResolve(gitDirRaw);
  }
}

/**
 * Complete an in-progress merge or rebase after conflicts were resolved.
 * WHY this exists: After resolveConflicts() we've staged the resolution; we must either
 * `rebase --continue` (rebase) or `commit` (merge). Using the wrong one leaves .git/rebase-merge
 * behind and breaks the next push retry.
 */
export async function completeMerge(git: SimpleGit, message: string): Promise<{ success: boolean; error?: string }> {
  debug('Completing merge commit');
  try {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const resolvedGitDir = await getResolvedGitDir(git);
    const inRebase = existsSync(join(resolvedGitDir, 'rebase-merge')) || existsSync(join(resolvedGitDir, 'rebase-apply'));

    if (inRebase) {
      debug('In rebase - continuing rebase');
      await continueRebase(git);
    } else {
      debug('In merge - committing');
      await git.commit(message);
    }
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}
