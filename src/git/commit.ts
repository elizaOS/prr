import type { SimpleGit } from 'simple-git';
import { spawn, execSync, execFileSync } from 'child_process';
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
 * Result of a push attempt, indicating whether it was rejected due to being behind.
 */
export interface PushResult {
  success: boolean;
  rejected?: boolean;  // True if push was rejected because remote has newer commits
  error?: string;
}

/**
 * Push changes to remote with timeout and signal handling.
 * 
 * WHY spawn instead of simple-git: simple-git's promises can't be cancelled,
 * and the underlying git process keeps running even after timeout. Using
 * spawn directly lets us SIGKILL the process on timeout or Ctrl+C.
 * 
 * WHY 30s timeout (reduced from 60s): Push should be fast. If it takes longer,
 * something is wrong (auth prompt, network). 30s is still generous.
 * 
 * Returns PushResult instead of throwing for rejected pushes, allowing caller
 * to handle pull-and-retry logic.
 */
export async function push(git: SimpleGit, branch: string, force = false, githubToken?: string): Promise<PushResult> {
  const PUSH_TIMEOUT_MS = 30_000; // 30 seconds (reduced from 60)
  const redactAuth = (text: string) => text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
  
  // Get the workdir from the git instance
  const workdir = (git as any)._baseDir || process.cwd();
  
  // Check if remote URL has token, inject if missing
  // WHY: Token may be stripped or repo cloned without it
  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd: workdir, encoding: 'utf8' }).trim();
    const hasTokenInUrl = remoteUrl.includes('@') && remoteUrl.startsWith('https://');
    
    if (!hasTokenInUrl && githubToken && remoteUrl.startsWith('https://')) {
      // Inject token into URL
      const authUrl = remoteUrl.replace('https://', `https://${githubToken}@`);
      execFileSync('git', ['remote', 'set-url', 'origin', authUrl], { cwd: workdir });
      debug('Injected token into remote URL for push');
    } else if (!hasTokenInUrl && !githubToken) {
      debug('WARNING: Remote URL does not contain token and no token provided - push may fail');
    } else {
      debug('Pre-push check', { hasTokenInUrl });
    }
  } catch (e) {
    debug('Could not check/set remote URL', { error: String(e) });
  }
  
  const args = ['push', 'origin', branch];
  if (force) args.push('--force');
  
  const fullCommand = `git ${args.join(' ')}`;
  debug('Starting git push', { command: fullCommand, workdir });
  
  return new Promise((resolve) => {
    const gitProcess = spawn('git', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    // Log output as it comes in (git push progress goes to stderr)
    gitProcess.stdout?.on('data', (data) => { 
      stdout += data.toString(); 
      debug('git push stdout', redactAuth(data.toString().trim()));
    });
    gitProcess.stderr?.on('data', (data) => { 
      stderr += data.toString();
      // Show progress (git push writes progress to stderr)
      const line = redactAuth(data.toString().trim());
      if (line && !line.includes('Username') && !line.includes('Password')) {
        debug('git push progress', line);
      }
    });
    
    // Timeout - kill the process
    const timeout = setTimeout(() => {
      killed = true;
      gitProcess.kill('SIGKILL');
      // Include the command in error for debugging
      const errMsg = [
        `Push timed out after 30 seconds.`,
        `Command: ${fullCommand}`,
        `Workdir: ${workdir}`,
        `This usually means:`,
        `  - Network issue (check connectivity)`,
        `  - Auth issue (token missing/expired)`,
        `  - Git waiting for interactive input`,
        stderr ? `stderr: ${redactAuth(stderr)}` : '',
      ].filter(Boolean).join('\n');
      resolve({ success: false, error: errMsg });
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
        resolve({ success: true });
      } else {
        // Check if push was rejected due to being behind remote
        const isRejected = stderr.includes('rejected') && 
          (stderr.includes('fetch first') || stderr.includes('non-fast-forward'));
        
        if (isRejected) {
          debug('Push rejected - remote has newer commits', { stderr: redactAuth(stderr) });
          resolve({ 
            success: false, 
            rejected: true,
            error: 'Push rejected: remote has newer commits. Need to pull first.',
          });
        } else {
          resolve({ 
            success: false,
            error: `Git push failed with code ${code}\nCommand: ${fullCommand}\nWorkdir: ${workdir}\nstderr: ${redactAuth(stderr)}`,
          });
        }
      }
    });
    
    gitProcess.on('error', (err) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      resolve({ 
        success: false,
        error: `Git push failed: ${err.message}\nCommand: ${fullCommand}\nWorkdir: ${workdir}`,
      });
    });
  });
}

/**
 * Result of pushWithRetry
 */
export interface PushWithRetryResult {
  success: boolean;
  error?: string;
  conflictedFiles?: string[];  // Files with conflicts if rebase failed
}

/**
 * Push with auto-retry on rejection.
 * If push is rejected because remote has newer commits, fetches and rebases, then retries.
 * 
 * WHY: Common scenario when CodeRabbit or another user pushes while prr is working.
 * Auto-retry makes the workflow smoother without manual intervention.
 * 
 * WHY rebase instead of merge: Keeps history clean. Our fix commits go on top.
 * 
 * NEW: onConflict callback allows caller to resolve conflicts (e.g., with LLM).
 * If provided and conflicts occur, calls callback. If callback returns true (resolved),
 * continues the rebase and retries push.
 */
export async function pushWithRetry(
  git: SimpleGit, 
  branch: string, 
  options?: { 
    force?: boolean; 
    onPullNeeded?: () => void; 
    githubToken?: string;
    onConflict?: (conflictedFiles: string[]) => Promise<boolean>;  // Returns true if conflicts resolved
    maxRetries?: number;  // Max push retries (default 3)
  }
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 3;
  let attempts = 0;
  
  while (attempts < maxRetries) {
    attempts++;
    const result = await push(git, branch, options?.force, options?.githubToken);
    
    if (result.success) {
      return;
    }
    
    if (!result.rejected) {
      // Non-rejected failure (auth, network, etc.) - don't retry
      throw new Error(result.error || 'Push failed');
    }
    
    // Push was rejected - remote has newer commits
    debug(`Push rejected (attempt ${attempts}/${maxRetries}), attempting fetch + rebase + retry`);
    options?.onPullNeeded?.();
    
    // Fetch and rebase to handle divergent branches
    try {
      // First fetch
      await git.fetch('origin', branch);
      debug('Fetch successful');
      
      // Then rebase our commits on top of remote
      await git.rebase([`origin/${branch}`]);
      debug('Rebase successful, retrying push');
      // Loop continues to retry push
    } catch (syncError) {
      const syncMsg = syncError instanceof Error ? syncError.message : String(syncError);
      debug('Rebase failed', { error: syncMsg, attempt: attempts });
      
      // Check if it's a conflict
      if (syncMsg.includes('CONFLICT') || syncMsg.includes('conflict')) {
        // Get conflicted files
        const status = await git.status();
        const conflictedFiles = status.conflicted || [];
        
        // If we have a conflict handler, try to use it
        if (options?.onConflict && conflictedFiles.length > 0) {
          debug('Calling onConflict handler', { files: conflictedFiles });
          
          try {
            const resolved = await options.onConflict(conflictedFiles);
            
            if (resolved) {
              // Conflicts resolved - stage files and continue rebase
              debug('Conflicts resolved by handler, continuing rebase');
              await git.add('.');
              
              try {
                await git.rebase(['--continue']);
                debug('Rebase continued successfully');
                // Loop continues to retry push
                continue;
              } catch (continueError) {
                // Rebase continue failed - check if more conflicts or done
                const continueMsg = continueError instanceof Error ? continueError.message : String(continueError);
                if (continueMsg.includes('No changes') || continueMsg.includes('nothing to commit')) {
                  // Rebase is actually done
                  debug('Rebase complete (no more changes)');
                  continue;
                }
                // More conflicts - could loop but for now bail
                debug('Rebase continue failed', { error: continueMsg });
              }
            }
          } catch (handlerError) {
            debug('onConflict handler failed', { error: handlerError });
          }
        }
        
        // Handler didn't resolve or no handler - abort rebase
        try {
          await git.rebase(['--abort']);
        } catch {
          // Ignore abort errors
        }
        
        throw new Error(`Push rejected and rebase has conflicts in: ${conflictedFiles.join(', ')}. Manual resolution needed.\nOriginal: ${result.error}`);
      }
      
      // Non-conflict rebase failure - abort and throw
      try {
        await git.rebase(['--abort']);
      } catch {
        // Ignore abort errors
      }
      
      throw new Error(`Push rejected and sync failed: ${syncMsg}\nOriginal: ${result.error}`);
    }
  }
  
  // Exhausted retries
  throw new Error(`Push failed after ${maxRetries} attempts. Remote may be receiving concurrent pushes.`);
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
 * Commit verified fixes from an iteration with prr-fix markers for recovery.
 * 
 * WHY markers: On restart, we scan git log for these markers to recover which
 * fixes were verified, even if the state file is lost or corrupted.
 * 
 * WHY check status first: Prevents "nothing to commit" errors. Also handles
 * case where changes were already committed or the fixer made no changes.
 * 
 * Returns null if no changes to commit.
 */
export async function commitIteration(
  git: SimpleGit,
  verifiedCommentIds: string[],
  iterationNumber: number
): Promise<CommitResult | null> {
  // Check if there are changes to commit (Trap 2)
  const status = await git.status();
  const hasChanges = status.modified.length || status.created.length || status.deleted.length;
  
  if (!hasChanges || verifiedCommentIds.length === 0) {
    return null; // Nothing to commit
  }

  await stageAll(git);

  // Build commit message with prr-fix markers (normalized to lowercase - Trap 6)
  const markers = verifiedCommentIds
    .map(id => `prr-fix:${id.toLowerCase()}`)
    .join('\n');
  
  const message = [
    `fix(prr): address ${verifiedCommentIds.length} review comment(s)`,
    '',
    `Iteration ${iterationNumber}`,
    '',
    markers,
  ].join('\n');

  // Skip pre-commit hooks for automated commits (Trap 10)
  const result = await git.commit(message, { '--no-verify': null });

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
  };
}

/**
 * Scan git log for prr-fix markers to recover verification state.
 * 
 * WHY: Git commits are durable. On restart, we can recover which fixes were
 * already verified by scanning the commit history for our markers.
 * 
 * Scope to branch commits (Trap 1): Only search commits that are on this branch
 * since it diverged from main, avoiding false positives from merged commits.
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
    // This is less precise but won't fail
    const logArgs: string[] = baseBranch 
      ? [`${baseBranch}..${branch}`, '--grep=prr-fix:', '--format=%B%n---COMMIT_END---']
      : ['--grep=prr-fix:', '--format=%B%n---COMMIT_END---', '-n', '100'];  // Limit to last 100 commits
    
    debug('scanCommittedFixes', { baseBranch, branch, logArgs });
    const log = await git.log(logArgs);
    
    const commentIds: string[] = [];
    
    // Parse all prr-fix:ID markers from commit messages
    if (log.all && log.all.length > 0) {
      for (const commit of log.all) {
        const fullMessage = commit.message || commit.body || '';
        // Match prr-fix: followed by non-whitespace (normalize to lowercase)
        const matches = fullMessage.matchAll(/prr-fix:(\S+)/gi);
        for (const match of matches) {
          commentIds.push(match[1].toLowerCase());
        }
      }
    }
    
    // Dedupe in case the same fix was committed multiple times
    return [...new Set(commentIds)];
  } catch (error) {
    debug('scanCommittedFixes error', { error: String(error) });
    return []; // No commits or error - safe to continue
  }
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
    // NOTE: Using alternation instead of character class because emojis like ⚠️ have combining characters
    .replace(/^(?:⚠️|🔴|🟡|🟢|✅|❌|💡|📝|🐛)+\s*/gu, '')
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
