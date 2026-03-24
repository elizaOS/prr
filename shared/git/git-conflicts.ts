/**
 * Git conflict checking and fetch-with-capture.
 *
 * **Workdir / cwd:** `fetchOriginBranch` resolves the directory from the bound **`SimpleGit`** instance
 * (`rev-parse --show-toplevel`) — that is the **PR clone checkout**, not necessarily `process.cwd()`.
 * Fallback `_baseDir || process.cwd()` is a last resort when rev-parse fails; prefer a correctly scoped git instance.
 *
 * WHY spawn instead of simple-git for fetch: simple-git's fetch() can hang indefinitely
 * on network or credential prompts; we need a timeout and to surface git's stdout/stderr
 * so users see e.g. "Password for 'https://...':" and can fix auth (token injection).
 * WHY one-shot auth URL for fetch: repos cloned without token in the URL prompt for
 * password; we have GITHUB_TOKEN in config—using it for fetch/pull avoids the prompt
 * without writing secrets to .git/config.
 */
import type { SimpleGit } from 'simple-git';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { debug, formatNumber } from '../logger.js';
import { redactUrlCredentials } from './redact-url.js';

const execFileAsync = promisify(execFile);

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Parse `PRR_FETCH_TIMEOUT_MS` from env (default 60s, min 5s when valid).
 * Exported for tests; **`fetchOriginBranch`** uses a value parsed once at module load from **`process.env`**.
 */
export function parseFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRR_FETCH_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_FETCH_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    debug('PRR_FETCH_TIMEOUT_MS is set but not a valid integer; using default', {
      raw,
      defaultMs: formatNumber(DEFAULT_FETCH_TIMEOUT_MS),
    });
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  return Math.max(5000, n);
}

/** Configurable via PRR_FETCH_TIMEOUT_MS (default 60s). Large repos or slow connections may need more. */
const FETCH_TIMEOUT_MS = parseFetchTimeoutMs();

/**
 * True when `branch` is safe to embed in `refs/heads/<branch>` for fetch refspec.
 * Uses `git check-ref-format --branch` when quick checks pass.
 */
export function isBranchRefSafeForOriginFetch(branch: string): boolean {
  if (!branch || branch.includes('..')) return false;
  if (/[\s\\~^:?*[\x00-\x1f\x7f]/.test(branch)) return false;
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

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

  // Ref names must pass `git check-ref-format --branch` (stricter than a lone regex; pill audit).
  // When using refspec we inject branch into refs/heads/...; invalid names produce a bad refspec or unsafe spawn args.
  const safeForRefspec = isBranchRefSafeForOriginFetch(branch);

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
      let skipReason: string | undefined;
      if (!safeForRefspec) skipReason = 'branch ref not safe for embedded refspec';
      else if (!remoteUrl.startsWith('https://')) skipReason = 'origin remote is not https';
      else if (!options?.githubToken) skipReason = 'no githubToken in options';
      else if (hasTokenInUrl) skipReason = 'remote URL already embeds credentials';
      if (skipReason) {
        debug('Fetch using plain git fetch origin (one-shot auth not used)', { skipReason, branch });
      }
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
          `Fetch timed out after ${formatNumber(Math.round(FETCH_TIMEOUT_MS / 1000))}s. Check network and remote access (origin/${branch}). Set PRR_FETCH_TIMEOUT_MS for slow connections.`,
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
        reject(
            new Error(
              `git fetch failed: ${redactUrlCredentials(err.message)}\nstderr: ${redactUrlCredentials(stderr)}`
            )
          )
      );
    });
  });
}

export interface ConflictStatus {
  /** True when `git status` reports conflicted paths (in-progress merge/rebase). */
  hasConflicts: boolean;
  conflictedFiles: string[];
  behindBy: number;
  aheadBy: number;
  /**
   * True when `git merge-tree` predicts conflicts if `origin/<branch>` were merged into `HEAD`,
   * but the working tree is not yet in a conflicted merge state.
   */
  latentConflictWithOrigin: boolean;
  /** Paths reported by the dry-merge probe (subset of files that would conflict). */
  latentConflictedFiles: string[];
  /** Set when the probe did not run (unsupported, disabled, or missing ref). */
  latentProbeNote?: string;
  /**
   * True when `git merge-tree` predicts conflicts merging `origin/<prBase>` into `HEAD`
   * (PR branch checkout vs PR base tip). Aligns with GitHub **mergeable / dirty** (vs PR↔remote-tip only).
   */
  latentConflictWithPrBase: boolean;
  latentConflictedFilesWithPrBase: string[];
  /** Set when the PR-base probe did not run (disabled, missing ref, or same as PR branch). */
  latentProbePrBaseNote?: string;
}

async function resolveGitWorkdir(git: SimpleGit): Promise<string> {
  try {
    return (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    return (git as { _baseDir?: string })._baseDir || process.cwd();
  }
}

/**
 * Parse `git merge-tree` stderr/stdout for conflict paths.
 * Handles `Merge conflict in path` and `CONFLICT (type): path ...` (e.g. modify/delete).
 */
export function parseMergeTreeConflictPaths(combinedOutput: string): string[] {
  const files = new Set<string>();
  for (const m of combinedOutput.matchAll(/Merge conflict in (.+)$/gm)) {
    files.add(m[1].trim());
  }
  for (const m of combinedOutput.matchAll(/^CONFLICT \([^)]+\):\s*(\S+)/gm)) {
    files.add(m[1].trim());
  }
  return [...files];
}

export interface LatentMergeProbeResult {
  ran: boolean;
  hasLatentConflicts: boolean;
  files: string[];
  /** Why the probe did not run or could not conclude. */
  skipReason?: string;
}

/**
 * Dry-merge `HEAD` with `origin/<branch>` using `git merge-tree` (Git 2.38+).
 * Does not modify the working tree or index.
 *
 * WHY: After `fetch`, `git status` does not show conflicts until a merge/rebase is in progress.
 * This surfaces the same conflicts GitHub may imply as "dirty" while local `hasConflicts` is false.
 *
 * Opt out: env named by **`options.disableEnvVar`** (default **`PRR_DISABLE_LATENT_MERGE_PROBE`**).
 * For the PR-base probe, use **`PRR_DISABLE_LATENT_MERGE_PROBE_BASE`**.
 */
export async function probeLatentMergeConflictsWithOrigin(
  git: SimpleGit,
  branch: string,
  options?: { disableEnvVar?: string }
): Promise<LatentMergeProbeResult> {
  const envKey = options?.disableEnvVar ?? 'PRR_DISABLE_LATENT_MERGE_PROBE';
  const disable = process.env[envKey]?.trim().toLowerCase();
  if (disable === '1' || disable === 'true' || disable === 'yes') {
    return { ran: false, hasLatentConflicts: false, files: [], skipReason: envKey };
  }

  const cwd = await resolveGitWorkdir(git);
  const remoteRef = `origin/${branch}`;
  const branchOk =
    branch.trim().length > 0 && !/[\s\\~^:?*[\x00-\x1f\x7f]/.test(branch) && !branch.includes('..');
  if (!branchOk) {
    return { ran: false, hasLatentConflicts: false, files: [], skipReason: 'invalid branch name' };
  }

  try {
    execFileSync('git', ['rev-parse', '--verify', remoteRef], { cwd, stdio: 'ignore' });
  } catch {
    return { ran: false, hasLatentConflicts: false, files: [], skipReason: `missing ${remoteRef}` };
  }

  let base: string;
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', remoteRef], { cwd });
    base = stdout.trim();
    if (!base) {
      return { ran: false, hasLatentConflicts: false, files: [], skipReason: 'empty merge-base' };
    }
  } catch {
    return { ran: false, hasLatentConflicts: false, files: [], skipReason: 'merge-base failed' };
  }

  try {
    await execFileAsync(
      'git',
      ['merge-tree', '--name-only', '--write-tree', `--merge-base=${base}`, 'HEAD', remoteRef],
      { cwd, maxBuffer: 32 * 1024 * 1024 }
    );
    return { ran: true, hasLatentConflicts: false, files: [] };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number };
    const out = `${e.stdout?.toString?.() ?? e.stdout ?? ''}\n${e.stderr?.toString?.() ?? e.stderr ?? ''}`;
    const files = parseMergeTreeConflictPaths(out);
    return { ran: true, hasLatentConflicts: true, files };
  }
}

/**
 * Check for merge conflicts and behind/ahead counts. WHY options.githubToken: unblocks fetch when remote has no credentials.
 *
 * **`hasConflicts` / `conflictedFiles`:** in-progress merge/rebase only (`git status`).
 * **`latentConflictWithOrigin`:** dry-merge `HEAD` vs `origin/<branch>` (PR head vs remote PR tip).
 * **`latentConflictWithPrBase`:** when **`options.prBaseBranch`** is set and differs from **`branch`**, second probe:
 * dry-merge `HEAD` vs `origin/<prBase>` — closer to GitHub **mergeable / dirty** than PR-tip alone.
 */
export async function checkForConflicts(
  git: SimpleGit,
  branch: string,
  options?: FetchOptions & { prBaseBranch?: string }
): Promise<ConflictStatus> {
  debug('Checking for conflicts', { branch, prBaseBranch: options?.prBaseBranch });

  await fetchOriginBranch(git, branch, options);

  const status = await git.status();

  // Check if there are merge conflicts (only when merge/rebase is in progress — not latent vs remote)
  const conflictedFiles = status.conflicted || [];

  // Check how far behind/ahead we are
  const behind = status.behind || 0;
  const ahead = status.ahead || 0;

  let latentConflictWithOrigin = false;
  let latentConflictedFiles: string[] = [];
  let latentProbeNote: string | undefined;

  let latentConflictWithPrBase = false;
  let latentConflictedFilesWithPrBase: string[] = [];
  let latentProbePrBaseNote: string | undefined;

  if (conflictedFiles.length === 0) {
    const probe = await probeLatentMergeConflictsWithOrigin(git, branch);
    if (probe.ran) {
      latentConflictWithOrigin = probe.hasLatentConflicts;
      latentConflictedFiles = probe.files;
      debug('Latent merge-tree probe', {
        branch,
        latentConflictWithOrigin,
        fileCount: probe.files.length,
      });
    } else if (probe.skipReason) {
      latentProbeNote = probe.skipReason;
      debug('Latent merge-tree probe skipped', { branch, reason: probe.skipReason });
    }

    const prBase = options?.prBaseBranch?.trim();
    const branchTrim = branch.trim();
    const shouldProbePrBase = Boolean(prBase && prBase !== branchTrim && prBase.length > 0);
    if (shouldProbePrBase && prBase) {
      try {
        await fetchOriginBranch(git, prBase, options);
      } catch (err) {
        debug('fetch for PR-base latent probe failed (probe may still use existing ref)', {
          prBase,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      const probeBase = await probeLatentMergeConflictsWithOrigin(git, prBase, {
        disableEnvVar: 'PRR_DISABLE_LATENT_MERGE_PROBE_BASE',
      });
      if (probeBase.ran) {
        latentConflictWithPrBase = probeBase.hasLatentConflicts;
        latentConflictedFilesWithPrBase = probeBase.files;
        debug('Latent merge-tree probe (PR base)', {
          prBase,
          latentConflictWithPrBase,
          fileCount: probeBase.files.length,
        });
      } else if (probeBase.skipReason) {
        latentProbePrBaseNote = probeBase.skipReason;
        debug('Latent merge-tree probe (PR base) skipped', { prBase, reason: probeBase.skipReason });
      }
    }
  }

  debug('Conflict check result', {
    conflicted: conflictedFiles.length,
    behind,
    ahead,
    latent: latentConflictWithOrigin,
    latentFiles: latentConflictedFiles.length,
    latentPrBase: latentConflictWithPrBase,
    latentPrBaseFiles: latentConflictedFilesWithPrBase.length,
  });

  return {
    hasConflicts: conflictedFiles.length > 0,
    conflictedFiles,
    behindBy: behind,
    aheadBy: ahead,
    latentConflictWithOrigin,
    latentConflictedFiles,
    latentProbeNote,
    latentConflictWithPrBase,
    latentConflictedFilesWithPrBase,
    latentProbePrBaseNote,
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
