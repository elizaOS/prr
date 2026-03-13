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
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { debug } from '../logger.js';
import { cleanupGitState, continueRebase } from './git-merge.js';
import { redactUrlCredentials } from './redact-url.js';

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
  
  // Prefer Authorization header (like actions/checkout) so push never prompts in CI.
  // WHY: Embedding token in URL (https://TOKEN@...) can fail in CI with "could not read Password"
  // when the token contains special characters or git uses a credential helper that ignores URL auth.
  // Using http.https://github.com/.extraheader with Basic auth is reliable and matches GitHub Actions.
  let authConfigArgs: string[] = [];
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workdir, encoding: 'utf8' }).trim();
    const hasTokenInUrl = remoteUrl.includes('@') && remoteUrl.startsWith('https://');
    const baseHttpsUrl = remoteUrl.startsWith('https://') && hasTokenInUrl
      ? 'https://' + remoteUrl.replace(/^https:\/\/[^@]+@/, '')
      : remoteUrl;
    if (githubToken && baseHttpsUrl.startsWith('https://')) {
      // AUTHORIZATION: basic base64(token:) — GitHub accepts token as username, empty password.
      const basicAuth = Buffer.from(`${githubToken}:`, 'utf8').toString('base64');
      authConfigArgs = [
        'credential.helper=',
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`,
      ];
      debug('Pre-push check', { hasTokenInUrl, usingAuthHeader: true });
    } else if (githubToken && !baseHttpsUrl.startsWith('https://')) {
      debug('Remote URL is SSH — token injection skipped; push will use SSH credentials.');
    } else if (!hasTokenInUrl && !githubToken) {
      debug('WARNING: Remote URL does not contain token and no token provided - push may fail');
    } else {
      debug('Pre-push check', { hasTokenInUrl });
    }
  } catch (e) {
    debug('Could not check remote URL', { error: redactUrlCredentials(String(e)) });
  }

  // Push to origin; when we have a token, -c options supply auth for this command only.
  const args = ['push', 'origin', `HEAD:${branch}`];
  if (force) args.push('--force');
  const pushArgs = authConfigArgs.length > 0
    ? [...authConfigArgs.flatMap((v) => ['-c', v]), ...args]
    : args;

  const fullCommand = `git ${pushArgs.join(' ')}`;
  debug('Starting git push', { command: redactUrlCredentials(fullCommand), workdir });

  const spawnEnv = { ...process.env };
  if (authConfigArgs.length > 0) {
    spawnEnv.GIT_TERMINAL_PROMPT = '0';  // Never prompt for credentials (CI has no TTY)
  }

  return new Promise((resolve) => {
    const gitProcess = spawn('git', pushArgs, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
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
        `Command: ${redactUrlCredentials(fullCommand)}`,
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
      if (killed) return;
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
          // WHY: output.log audit babylon#1213 — push failed with "refusing to allow a Personal Access Token to create or update workflow … without `workflow` scope". Surface a clear hint.
          const workflowScopeDenied = /refusing to allow.*(?:create or update workflow|workflow.*without.*workflow.*scope)/i.test(stderr) || /without\s*[`']workflow[`']\s*scope/i.test(stderr);
          const baseError = `Git push failed with code ${code}\nCommand: ${redactUrlCredentials(fullCommand)}\nWorkdir: ${workdir}\nstderr: ${redactUrlCredentials(stderr)}`;
          const error = workflowScopeDenied
            ? `${baseError}\n\nHint: GitHub rejected the push because your token does not have the 'workflow' scope. To modify .github/workflows files, add the workflow scope to your Personal Access Token, or fix workflow files manually.`
            : baseError;
          settle({ success: false, error });
        }
      }
    });
    
    gitProcess.on('error', (err) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      settle({ 
        success: false,
        error: `Git push failed: ${err.message}\nCommand: ${redactUrlCredentials(fullCommand)}\nWorkdir: ${workdir}`,
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
  /** True when nothingToPush occurred after a rebase (e.g. remote already had commits from a previous run). Callers can show a more specific message. */
  nothingToPushAfterRebase?: boolean;
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
 * On rebase failure we run rebase --abort only (no cleanupGitState, to preserve caller's commits).
 * WHY: Abort preserves commits; full cleanup is for stale/corrupt state so the next run
 * doesn't hit "rebase-merge directory already exists".
 */
async function removeStuckRebaseDirs(git: SimpleGit): Promise<void> {
  try {
    const wd = (await git.revparse(['--show-toplevel'])).trim();
    const gitDir = join(wd, '.git');
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const p = join(gitDir, name);
      if (existsSync(p)) {
        rmSync(p, { recursive: true });
        debug('Removed stuck rebase dir so next run can proceed', { path: name });
      }
    }
  } catch {
    // best-effort
  }
}

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
  const maxRetries = (Number.isInteger(requestedRetries) && requestedRetries >= 0)
    ? requestedRetries
    : 0;
  if (maxRetries !== requestedRetries) {
    debug('pushWithRetry: invalid maxRetries, using 0 (one attempt)', { requestedRetries });
  }
  const maxAttempts = maxRetries + 1;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const result = await push(git, branch, options?.force, options?.githubToken);

    if (result.success) {
      if (result.nothingToPush && attempts > 1) {
        debug('Push after rebase resulted in nothing-to-push — remote already has these commits (likely from a previous run)');
      }
      return {
        success: true,
        nothingToPush: result.nothingToPush,
        nothingToPushAfterRebase: result.nothingToPush && attempts > 1,
      };
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

    const ref = `origin/${branch}`;
    try {
      await git.raw(['rev-parse', '--verify', ref]);
      debug('Rebase target verified', { ref });
    } catch {
      // Ref may be missing when repo was cloned with --single-branch (refspec doesn't include this branch).
      // Add refspec and fetch so rebase has a valid upstream (same pattern as git-clone-core additionalBranches).
      debug('Rebase target missing locally, adding refspec and fetching', { ref });
      try {
        await git.raw(['remote', 'set-branches', '--add', 'origin', branch]);
        await git.fetch('origin', branch);
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        throw new Error(
          `Branch ${branch} does not exist on remote (fetch failed). If using a single-branch clone, create the branch on the remote first. ${msg}`
        );
      }
    }

    // Fetch and rebase to handle divergent branches
    try {
      await git.fetch('origin', branch);
      debug('Fetch successful');

      await git.raw(['rev-parse', '--verify', ref]);
      debug('Rebase target verified before rebase', { ref });

      // Then rebase our commits on top of remote
      await git.rebase([ref]);
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
        
        // WHY only abort, not cleanupGitState: cleanupGitState does reset --hard + clean -fd and
        // destroys the caller's commits (e.g. split-exec's cherry-picks). Abort preserves commits.
        try {
          await git.rebase(['--abort']);
        } catch (abortErr) {
          debug('rebase --abort failed (rebase state may be stale); not running cleanup to preserve local commits', { err: String(abortErr) });
          await removeStuckRebaseDirs(git);
        }
        let workdirMsg = '';
        try {
          const workdir = (await git.revparse(['--show-toplevel'])).trim();
          const fileList = conflictedFiles.join(' ');
          const allWorkflow = conflictedFiles.every((f) => f.startsWith('.github/workflows/'));
          const resolveCmd = allWorkflow
            ? `git checkout --theirs -- ${fileList} && git add ${fileList} && git rebase --continue`
            : `git add ${fileList} && git rebase --continue`;
          workdirMsg = `\nWorkdir: ${workdir}\nResolve then continue: cd ${workdir} && ${resolveCmd}`;
        } catch {
          // best-effort
        }
        throw new Error(`Push rejected and rebase has conflicts in: ${conflictedFiles.join(', ')}. Manual resolution needed.${workdirMsg}\nOriginal: ${result.error}`);
      }

      // Non-conflict rebase failure (e.g. invalid upstream when ref wasn't fetched). Abort only; do not cleanup.
      try {
        await git.rebase(['--abort']);
      } catch (abortErr) {
        debug('rebase --abort failed; not running cleanup to preserve local commits', { err: String(abortErr) });
        await removeStuckRebaseDirs(git);
      }
      const refHint = /invalid upstream|ref.*not found/i.test(syncMsg)
        ? ' If using a --single-branch clone, ensure the branch ref was fetched (e.g. additionalBranches or git remote set-branches --add origin <branch>).'
        : '';
      throw new Error(`Push rejected and sync failed: ${syncMsg}${refHint}\nOriginal: ${result.error}`);
    }
  }
  
  // Exhausted retries
  throw new Error(`Push failed after ${maxAttempts} attempts. Remote may be receiving concurrent pushes.`);
}

