/**
 * Git push operations with timeout, retry, and recovery
 * 
 * WHY this is the largest git module (328 lines):
 * Push is the most complex git operation we perform:
 * - Process management (spawn for timeout control)
 * - Authentication (token injection into remote URL)
 * - Error handling (parse stderr for specific error types)
 * - Retry logic (pull and push again on rejection)
 * - Remote URL management (inject token, restore original)
 * 
 * WHY use spawn() instead of simple-git:
 * simple-git's push() returns a Promise that can't be cancelled. If it hangs,
 * the process runs forever. spawn() gives us direct process control so we can
 * SIGKILL on timeout or Ctrl+C interruption.
 * 
 * WHY inject auth token into remote URL:
 * HTTPS auth for push requires credentials. Token injection
 * (https://token@github.com/...) is the most reliable method that works
 * across different git versions and configurations.
 * 
 * WHY restore original remote URL:
 * Tokens are sensitive. Even though workdirs are local-only, we restore the
 * original URL after push to avoid leaving tokens in .git/config.
 * 
 * DESIGN: This module is intentionally kept together despite its size because
 * the push logic is tightly coupled - timeout handling, auth, and retry all
 * interact with each other.
 */
import type { SimpleGit } from 'simple-git';
import { spawn, execFileSync } from 'child_process';
import { debug } from '../logger.js';

export interface PushResult {
  success: boolean;
  rejected?: boolean;
  error?: string;
  /** True when push succeeded but remote already had our commits (nothing to push). */
  nothingToPush?: boolean;
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
  
  // Check if remote URL has token, inject if missing
  // WHY: Token may be stripped or repo cloned without it
  let originalRemoteUrl: string | null = null;
  let updatedRemote = false;
  const restoreRemote = () => {
    if (!updatedRemote || !originalRemoteUrl) return;
    try {
      execFileSync('git', ['remote', 'set-url', 'origin', originalRemoteUrl], { cwd: workdir });
    } catch (e) {
      debug('Failed to restore remote URL', { error: String(e) });
    } finally {
      updatedRemote = false;
    }
  };
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workdir, encoding: 'utf8' }).trim();
    originalRemoteUrl = remoteUrl;
    const hasTokenInUrl = remoteUrl.includes('@') && remoteUrl.startsWith('https://');
    
    if (!hasTokenInUrl && githubToken && remoteUrl.startsWith('https://')) {
      // Inject token into URL
      const authUrl = remoteUrl.replace('https://', `https://${githubToken}@`);
      execFileSync('git', ['remote', 'set-url', 'origin', authUrl], { cwd: workdir });
      updatedRemote = true;
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
      restoreRemote();
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
      restoreRemote();
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
    };
    process.on('SIGINT', sigintHandler);
    
    gitProcess.on('close', (code) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      restoreRemote();
      
      if (killed) return; // Already handled by timeout/sigint
      
      if (code === 0) {
        const nothingToPush = /everything up-to-date/i.test(stderr) || /everything up-to-date/i.test(stdout);
        debug('Git push completed', { branch, nothingToPush });
        resolve({ success: true, nothingToPush: nothingToPush || undefined });
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
      restoreRemote();
      resolve({ 
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
  const maxRetries = options?.maxRetries ?? 3;
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
  throw new Error(`Push failed after ${maxAttempts} attempts. Remote may be receiving concurrent pushes.`);
}

