/**
 * Git conflict checking and fetch-with-capture.
 *
 * WHY spawn instead of simple-git for fetch: simple-git's fetch() can hang indefinitely
 * on network or credential prompts; we need a timeout and to surface git's stdout/stderr
 * so users see e.g. "Password for 'https://...':" and can fix auth (token injection).
 * WHY one-shot auth URL for fetch: repos cloned without token in the URL prompt for
 * password; we have GITHUB_TOKEN in config—using it for fetch/pull avoids the prompt
 * without writing secrets to .git/config.
 */
import type { SimpleGit } from 'simple-git';
import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { debug } from '../logger.js';
import { redactUrlCredentials } from './redact-url.js';

/** Configurable via PRR_FETCH_TIMEOUT_MS (default 60s). Large repos or slow connections may need more. */
const FETCH_TIMEOUT_MS = typeof process.env.PRR_FETCH_TIMEOUT_MS !== 'undefined' && process.env.PRR_FETCH_TIMEOUT_MS !== ''
  ? Math.max(5000, parseInt(process.env.PRR_FETCH_TIMEOUT_MS, 10) || 60_000)
  : 60_000;

export interface FetchOptions {
  /** GitHub token for one-shot auth when remote URL has no credentials. Avoids password prompt. */
  githubToken?: string;
}

/**
 * Run git fetch via spawn so we can capture stdout/stderr and show them on timeout.
 * When githubToken is provided and origin is HTTPS without credentials, uses one-shot
 * auth URL (same as push) so fetch does not prompt for password.
 */
export async function fetchOriginBranch(
  git: SimpleGit,
  branch: string,
  options?: FetchOptions
): Promise<void> {
  let workdir: string;
  try {
    workdir = (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    workdir = (git as { _baseDir?: string })._baseDir || process.cwd();
    debug('Fetch using fallback workdir', { workdir });
  }
  const gitDir = join(workdir, '.git');
  if (!existsSync(gitDir)) {
    throw new Error(
      `Resolved workdir "${workdir}" is not a git repository (no .git directory). ` +
        'Fetch would run in the wrong directory. Check that the git instance is bound to a valid repo.'
    );
  }

  // Ref names must not contain space, ~, ^, :, ?, *, [, \, or control chars (git check-ref-format).
  // When using refspec we inject branch into refs/heads/...; invalid chars would produce a bad refspec.
  const safeForRefspec = branch.length > 0 && !/[\s\\~^:?*[\x00-\x1f\x7f]/.test(branch) && !branch.includes('..');

  let args: string[];
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workdir, encoding: 'utf8' }).trim();
    const hasTokenInUrl = remoteUrl.includes('@') && remoteUrl.startsWith('https://');
    if (safeForRefspec && !hasTokenInUrl && options?.githubToken && remoteUrl.startsWith('https://')) {
      const authUrl = remoteUrl.replace('https://', `https://${options.githubToken}@`);
      // WHY refspec: fetch <url> <refspec> updates refs/remotes/origin/branch so git.status() behind/ahead is correct.
      args = ['fetch', authUrl, `refs/heads/${branch}:refs/remotes/origin/${branch}`];
      debug('Fetch with one-shot auth URL');
    } else {
      args = ['fetch', 'origin', branch];
    }
  } catch (err) {
    debug('Fetch URL construction failed, falling back to plain fetch origin branch', {
      err: err instanceof Error ? err.message : String(err),
      branch,
    });
    args = ['fetch', 'origin', branch];
  }

  debug('Starting git fetch', { command: `git ${args.join(' ')}`, workdir });

  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    // WHY settle guard: timeout kills process then 'close' fires; we must resolve/reject only once.
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      clearTimeout(timeout);
      proc.kill('SIGKILL');
      settle(() => {
        const out = [
          `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check network and remote access (origin/${branch}). Set PRR_FETCH_TIMEOUT_MS for slow connections.`,
          '',
          'Output from git fetch:',
          stdout ? `stdout:\n${redactUrlCredentials(stdout)}` : '',
          stderr ? `stderr:\n${redactUrlCredentials(stderr)}` : '',
        ].filter(Boolean).join('\n');
        reject(new Error(out));
      });
    }, FETCH_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      settle(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `git fetch exited ${code}\nstdout:\n${redactUrlCredentials(stdout)}\nstderr:\n${redactUrlCredentials(stderr)}`
            )
          );
        }
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      settle(() =>
        reject(new Error(`git fetch failed: ${err.message}\nstderr: ${redactUrlCredentials(stderr)}`))
      );
    });
  });
}

export interface ConflictStatus {
  hasConflicts: boolean;
  conflictedFiles: string[];
  behindBy: number;
  aheadBy: number;
}


/**
 * Check for merge conflicts and behind/ahead counts. WHY options.githubToken: unblocks fetch when remote has no credentials.
 *
 * **Limitation:** `hasConflicts` / `conflictedFiles` reflect **in-progress** merge/rebase state only
 * (`git status` conflicted paths). After a plain `fetch`, latent conflicts with `origin/<branch>` are **not**
 * detected here. Callers use this after operations that may leave conflict markers, or together with
 * explicit merge attempts (e.g. base-branch merge). See pill-output.md #32.
 */
export async function checkForConflicts(
  git: SimpleGit,
  branch: string,
  options?: FetchOptions
): Promise<ConflictStatus> {
  debug('Checking for conflicts', { branch });

  await fetchOriginBranch(git, branch, options);

  const status = await git.status();

  // Check if there are merge conflicts (only when merge/rebase is in progress — not latent vs remote)
  const conflictedFiles = status.conflicted || [];

  // Check how far behind/ahead we are
  const behind = status.behind || 0;
  const ahead = status.ahead || 0;

  debug('Conflict check result', { conflicted: conflictedFiles.length, behind, ahead });

  return {
    hasConflicts: conflictedFiles.length > 0,
    conflictedFiles,
    behindBy: behind,
    aheadBy: ahead,
  };
}

/**
 * Quick check if remote has new commits without full conflict detection.
 * 
 * WHY: During fix iterations, we want to detect if someone pushed to the PR
 * so we can pull and re-verify instead of wasting cycles on stale code.
 * 
 * @returns Number of commits we're behind, or 0 if up-to-date
 * WHY options.githubToken: same as checkForConflicts—fetch used during fix loop must not prompt for password.
 */
export async function checkRemoteAhead(
  git: SimpleGit,
  branch: string,
  options?: FetchOptions
): Promise<{ behind: number; ahead: number }> {
  debug('Quick check for remote commits', { branch });

  await fetchOriginBranch(git, branch, options);

  const status = await git.status();

  return {
    behind: status.behind || 0,
    ahead: status.ahead || 0,
  };
}

/**
 * Pull latest changes from remote, handling divergent branches and local changes.
 * 
 * WHY rebase: Keeps history clean. prr's commits should go on top of remote changes.
 * WHY auto-stash: Interrupted runs leave uncommitted changes that block pulls.
 * 
 * Flow:
 * 1. Stash any uncommitted changes
 * 2. Fetch latest from remote
 * 3. If branches diverged, rebase local commits on top of remote
 * 4. Pop stash and handle any conflicts
 */
