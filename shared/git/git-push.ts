/**
 * Git push operations with timeout, retry, and recovery
 * 
 * WHY this is the largest git module (328 lines):
 * Push is the most complex git operation we perform:
 * - Process management (spawn for timeout control)
 * - Authentication (one-shot auth URL for push)
 * - Error handling (parse stderr for specific error types)
 * - Retry logic (pull and push again on rejection)
 * 
 * WHY use spawn() instead of simple-git:
 * simple-git's push() returns a Promise that can't be cancelled. If it hangs,
 * the process runs forever. spawn() gives us direct process control so we can
 * SIGKILL on timeout or Ctrl+C interruption.
 * 
 * WHY one-shot auth URL instead of modifying remote:
 * HTTPS auth for push requires credentials. Instead of using `git remote set-url`
 * which persists the token to .git/config (security risk if SIGKILL leaves it
 * exposed), we pass the auth URL directly in the push command:
 *   git push https://token@github.com/... HEAD:branch
 * This way the token is never written to disk.
 * 
 * DESIGN: This module is intentionally kept together despite its size because
 * the push logic is tightly coupled - timeout handling, auth, and retry all
 * interact with each other.
 */
import type { SimpleGit } from 'simple-git';
import { spawn, execFileSync } from 'child_process';
import { debug } from '../logger.js';
import { cleanupGitState, continueRebase } from './git-merge.js';

/** Redact credentials from URLs in error messages before logging. WHY: Git errors can contain remote URLs with tokens. */
function redactUrlCredentials(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}

/**
 * Result of a git push operation.
 * Canonical definition; commit.ts re-exports for backward compatibility.
 */
export interface PushResult {
  success: boolean;
  rejected?: boolean;
  error?: string;
  /** True when push succeeded but remote already had our commits (nothing to push).
   * WHY: Caller skips the post-push bot wait when nothing was pushed to avoid a 300s wait. */
  nothingToPush?: boolean;
}

/**
 * Push changes to remote with timeout and signal handling.
 * Canonical implementation; commit.ts re-exports for backward compatibility.
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

  // Get the workdir from the git instance
  // WHY multiple fallbacks: simple-git internal _baseDir may be undefined in some versions
  // Use git rev-parse as the most reliable source
  let workdir: string;
  try {
    // Most reliable: ask git itself for the repo root
    workdir = (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    // Fallback to internal property or cwd
    workdir = (git as any)._baseDir || process.cwd();
    debug('Using fallback workdir', { workdir, method: (git as any)._baseDir ? '_baseDir' : 'cwd' });
  }
  
  // Prefer one-shot auth URL when we have a token so push never prompts in CI.
  // WHY: Even when origin URL contains @ (hasTokenInUrl), git can still prompt "could not read Password"
  // in CI (e.g. stored URL is https://git@github.com/... or token expired). Using the token we have
  // for this run avoids that; one-shot URL is not persisted to .git/config.
  let authPushUrl: string | null = null;
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workdir, encoding: 'utf8' }).trim();
    const hasTokenInUrl = remoteUrl.includes('@') && remoteUrl.startsWith('https://');
    // Strip any existing credentials so we inject the current token (CI may pass a fresh GITHUB_TOKEN).
    const baseHttpsUrl = remoteUrl.startsWith('https://') && hasTokenInUrl
      ? 'https://' + remoteUrl.replace(/^https:\/\/[^@]+@/, '')
      : remoteUrl;
    if (githubToken && baseHttpsUrl.startsWith('https://')) {
      authPushUrl = baseHttpsUrl.replace('https://', `https://${githubToken}@`);
      debug('Pre-push check', { hasTokenInUrl, usingAuthUrl: true });
    } else if (!hasTokenInUrl && !githubToken) {
      debug('WARNING: Remote URL does not contain token and no token provided - push may fail');
    } else {
      debug('Pre-push check', { hasTokenInUrl });
    }
  } catch (e) {
    debug('Could not check remote URL', { error: redactUrlCredentials(String(e)) });
  }
  
  // Build push args: use one-shot auth URL if available, otherwise push to origin
  // WHY one-shot auth URL: Token is passed directly in command, never written to .git/config
  const args = authPushUrl
    ? ['push', authPushUrl, `HEAD:${branch}`]
    : ['push', 'origin', branch];
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
    let settled = false;
    const settle = (result: { success: boolean; nothingToPush?: boolean; rejected?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    
    // Log output as it comes in (git push progress goes to stderr)
    gitProcess.stdout?.on('data', (data) => { 
      stdout += data.toString(); 
      debug('git push stdout', redactUrlCredentials(data.toString().trim()));
    });
    gitProcess.stderr?.on('data', (data) => { 
      stderr += data.toString();
      // Show progress (git push writes progress to stderr)
      const line = redactUrlCredentials(data.toString().trim());
      if (line && !line.includes('Username') && !line.includes('Password')) {
        debug('git push progress', line);
      }
    });
    
    // Timeout - kill the process
    const timeout = setTimeout(() => {
      killed = true;
      gitProcess.kill('SIGKILL');
      const errMsg = [
        `Push timed out after 30 seconds.`,
        `Command: ${fullCommand}`,
        `Workdir: ${workdir}`,
        `This usually means:`,
        `  - Network issue (check connectivity)`,
        `  - Auth issue (token missing/expired)`,
        `  - Git waiting for interactive input`,
        stderr ? `stderr: ${redactUrlCredentials(stderr)}` : '',
      ].filter(Boolean).join('\n');
      settle({ success: false, error: errMsg });
    }, PUSH_TIMEOUT_MS);
    
    // Handle Ctrl+C - kill the git process and settle so callers don't hang
    const sigintHandler = () => {
      killed = true;
      gitProcess.kill('SIGKILL');
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      settle({ success: false, error: 'Push cancelled by user (SIGINT)' });
    };
    process.on('SIGINT', sigintHandler);
    
    gitProcess.on('close', (code) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      
      if (killed) {
        // Timeout or SIGINT already settled the promise
        return;
      }
      
      if (code === 0) {
        const nothingToPush = /everything up-to-date/i.test(stderr) || /everything up-to-date/i.test(stdout);
        debug('Git push completed', { branch, nothingToPush });
        settle({ success: true, nothingToPush: nothingToPush || undefined });
      } else {
        const isRejected = stderr.includes('rejected') && 
          (stderr.includes('fetch first') || stderr.includes('non-fast-forward'));
        
        if (isRejected) {
          debug('Push rejected - remote has newer commits', { stderr: redactUrlCredentials(stderr) });
          settle({ 
            success: false, 
            rejected: true,
            error: 'Push rejected: remote has newer commits. Need to pull first.',
          });
        } else {
          settle({ 
            success: false,
            error: `Git push failed with code ${code}\nCommand: ${fullCommand}\nWorkdir: ${workdir}\nstderr: ${redactUrlCredentials(stderr)}`,
          });
        }
      }
    });
    
    gitProcess.on('error', (err) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      settle({ 
        success: false,
        error: `Git push failed: ${err.message}\nCommand: ${fullCommand}\nWorkdir: ${workdir}`,
      });
    });
  });
}

/**
 * Result of pushWithRetry when push succeeds.
 */
export interface PushWithRetryResult {
  success: boolean;
  error?: string;
  conflictedFiles?: string[];  // Files with conflicts if rebase failed
  /** True when remote already had our commits (nothing to push). Skip bot wait. */
  nothingToPush?: boolean;
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
 *
 * On rebase failure we try rebase --abort first, then cleanupGitState only if abort fails.
 * WHY: Abort preserves commits; full cleanup is for stale/corrupt state so the next run
 * doesn't hit "rebase-merge directory already exists".
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
): Promise<PushWithRetryResult> {
  const requestedRetries = options?.maxRetries ?? 3;
  const maxRetries = Number.isInteger(requestedRetries) && requestedRetries >= 0
    ? requestedRetries
    : 3;
  const maxAttempts = maxRetries + 1;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const result = await push(git, branch, options?.force, options?.githubToken);

    if (result.success) {
      return { success: true, nothingToPush: result.nothingToPush };
    }
    
    if (!result.rejected) {
      // Non-rejected failure (auth, network, etc.) - don't retry
      throw new Error(result.error || 'Push failed');
    }
    if (attempts >= maxAttempts) {
      break;
    }
    
    // Push was rejected - remote has newer commits
    debug(`Push rejected (attempt ${attempts}/${maxAttempts}), attempting fetch + rebase + retry`);
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
      debug('Rebase failed', { error: redactUrlCredentials(syncMsg), attempt: attempts });
      
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
                await continueRebase(git);
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
                debug('Rebase continue failed', { error: redactUrlCredentials(continueMsg) });
              }
            }
          } catch (handlerError) {
            const handlerMsg = handlerError instanceof Error ? handlerError.message : String(handlerError);
            debug('onConflict handler failed', { error: redactUrlCredentials(handlerMsg) });
          }
        }
        
        // WHY try abort first: rebase --abort restores pre-rebase state with all commits intact.
        // cleanupGitState does reset --hard + clean -fd (correct for stuck state but destructive).
        // If abort fails (e.g. stale/corrupt rebase-merge dir), full cleanup unblocks the next run.
        try {
          await git.rebase(['--abort']);
        } catch {
          await cleanupGitState(git);
        }
        throw new Error(`Push rejected and rebase has conflicts in: ${conflictedFiles.join(', ')}. Manual resolution needed.\nOriginal: ${result.error}`);
      }

      // Same as above: abort first so commits are preserved; full cleanup only when abort fails.
      try {
        await git.rebase(['--abort']);
      } catch {
        await cleanupGitState(git);
      }
      throw new Error(`Push rejected and sync failed: ${syncMsg}\nOriginal: ${result.error}`);
    }
  }
  
  // Exhausted retries
  throw new Error(`Push failed after ${maxAttempts} attempts. Remote may be receiving concurrent pushes.`);
}

