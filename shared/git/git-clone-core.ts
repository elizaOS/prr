/**
 * Git clone and update operations
 *
 * WHY clone/fetch via spawn with stdio inherit: simple-git's clone()/fetch() often don't
 * surface progress (e.g. "Receiving objects: 45%"); the same outputHandler was applied to
 * every subsequent git call (diff, status, etc.) so users saw diffs instead of clone progress.
 * We run only clone and the main fetch via spawn so the user sees those; the returned git
 * instance has no outputHandler so the rest of the run (diffs, status, commit) stays quiet.
 */
import { simpleGit, type SimpleGit } from 'simple-git';
import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { debug } from '../logger.js';
import { DEFAULT_CLONE_TIMEOUT_MS } from '../constants.js';
import { cleanupGitState } from './git-merge.js';

/** Normalize clone URL for comparison: strip credentials and trailing .git so same repo matches. */
function normalizeCloneUrl(url: string): string {
  let u = url.trim();
  // Strip token: https://token@host/path -> https://host/path
  u = u.replace(/^(https?:\/\/)[^@]+@/, '$1');
  if (u.endsWith('.git')) u = u.slice(0, -4);
  return u.toLowerCase();
}

/** Read origin URL from workdir's .git/config (no spawn). Returns null if unreadable or no origin. */
function getOriginFromWorkdir(workdirPath: string): string | null {
  const configPath = join(workdirPath, '.git', 'config');
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf8');
    const match = content.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*(.+?)(?:\r?\n|$)/im);
    if (!match) return null;
    return match[1].trim();
  } catch {
    return null;
  }
}

/** Mtime of .git/FETCH_HEAD or .git for "most recently fetched" ordering. */
function getFetchHeadMtime(workdirPath: string): number {
  const fetchHead = join(workdirPath, '.git', 'FETCH_HEAD');
  if (existsSync(fetchHead)) return statSync(fetchHead).mtimeMs;
  const gitDir = join(workdirPath, '.git');
  return existsSync(gitDir) ? statSync(gitDir).mtimeMs : 0;
}

/**
 * Find another workdir for the same repo to use as git clone --reference (bootstrap from local copy).
 * WHY: Git is distributed; reusing an existing clone only fetches missing objects and is much faster.
 * Scans sibling dirs of workdir (e.g. ~/.prr/work/*), picks one with same origin and latest fetch.
 */
function findReferenceWorkdir(workdir: string, cloneUrl: string): string | null {
  const baseDir = dirname(workdir);
  const wantNorm = normalizeCloneUrl(cloneUrl);
  const candidates: { path: string; mtime: number }[] = [];
  try {
    const names = readdirSync(baseDir, { withFileTypes: true });
    for (const ent of names) {
      if (!ent.isDirectory()) continue;
      const candidatePath = join(baseDir, ent.name);
      if (candidatePath === workdir) continue;
      const gitDir = join(candidatePath, '.git');
      if (!existsSync(gitDir)) continue;
      const origin = getOriginFromWorkdir(candidatePath);
      if (origin == null) continue;
      if (normalizeCloneUrl(origin) !== wantNorm) continue;
      const mtime = getFetchHeadMtime(candidatePath);
      candidates.push({ path: candidatePath, mtime });
    }
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/** Clone timeout in ms. Override with PRR_CLONE_TIMEOUT_MS (default 900s). */
function getCloneTimeoutMs(): number {
  const raw = process.env.PRR_CLONE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CLONE_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_CLONE_TIMEOUT_MS;
}

/** Optional shallow clone: set PRR_CLONE_DEPTH to a positive integer (e.g. 1) for faster large-repo clones; full history otherwise. */
function getCloneDepthArg(): string[] {
  const raw = process.env.PRR_CLONE_DEPTH?.trim();
  if (raw === undefined || raw === '') return [];
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return [];
  return ['--depth', String(n)];
}

export interface GitOperations {
  git: SimpleGit;
  workdir: string;
}


export interface CloneOptions {
  preserveChanges?: boolean;  // If true, don't reset - keep existing uncommitted changes
  /** Fetch these branches after clone/update so refs exist (e.g. split-exec needs origin/targetBranch). */
  additionalBranches?: string[];
}

export async function cloneOrUpdate(
  cloneUrl: string,
  branch: string,
  workdir: string,
  githubToken?: string,
  options?: CloneOptions
): Promise<GitOperations> {
  // Inject token into clone URL for authentication
  let authUrl = cloneUrl;
  if (githubToken && cloneUrl.startsWith('https://')) {
    authUrl = cloneUrl.replace('https://', `https://${githubToken}@`);
  }

  const gitDir = join(workdir, '.git');
  let isExistingRepo = existsSync(gitDir);

  let git: SimpleGit | undefined;

  if (isExistingRepo) {
    git = simpleGit(workdir);
    let repoUsable = false;
    try {
      await git.raw(['rev-parse', 'HEAD']);
      repoUsable = true;
    } catch {
      debug('Workdir has .git but no valid HEAD (broken or incomplete clone), will clone fresh');
    }
    if (!repoUsable) {
      const { rm } = await import('fs/promises');
      await rm(workdir, { recursive: true, force: true });
      isExistingRepo = false;
      console.log('  Workdir incomplete or broken, cloning fresh...');
    }
  }

  if (isExistingRepo) {
    // Set remote to auth URL when we have a token so fetch/pull/push do not prompt
    if (githubToken && cloneUrl.startsWith('https://')) {
      await git!.raw(['remote', 'set-url', 'origin', authUrl]);
      debug('Set origin remote URL with token so fetch/pull/push do not prompt', {
        tokenLength: githubToken.length,
      });
    } else if (!githubToken) {
      debug('No GitHub token provided - fetch/push may prompt for credentials');
    }

    if (options?.preserveChanges) {
      // Preserve existing changes - just make sure we're on the right branch
      console.log(`Existing workdir found at ${workdir}, preserving local changes...`);
      
      // Abort any stuck rebase/merge/cherry-pick from a previous failed run.
      // Without this, a prior crash mid-rebase leaves the workdir in an
      // unusable state and every subsequent run fails at the same point.
      const rebaseMerge = join(workdir, '.git', 'rebase-merge');
      const rebaseApply = join(workdir, '.git', 'rebase-apply');
      const mergeHead = join(workdir, '.git', 'MERGE_HEAD');
      const cherryPickHead = join(workdir, '.git', 'CHERRY_PICK_HEAD');
      if (existsSync(rebaseMerge) || existsSync(rebaseApply) || existsSync(mergeHead) || existsSync(cherryPickHead)) {
        console.log('  ⚠ Detected stuck rebase/merge from previous run, aborting...');
        try { await git!.rebase(['--abort']); } catch { /* no rebase */ }
        try { await git!.merge(['--abort']); } catch { /* no merge */ }
        try { await git!.raw(['cherry-pick', '--abort']); } catch { /* no cherry-pick */ }
        debug('Aborted stuck git operation in preserveChanges path');
      }
      
      const status = await git!.status();
      const hasChanges = status.modified.length > 0 || status.created.length > 0 || status.staged.length > 0;
      if (hasChanges) {
        console.log(`  Keeping ${status.modified.length + status.created.length} modified files`);
      }
      // Just ensure we're on the right branch, don't reset
      try {
        await git!.checkout(branch);
      } catch {
        // Already on branch or changes prevent checkout - that's fine
      }
    } else {
      // Clean start - reset everything
      console.log(`Existing workdir found at ${workdir}, cleaning up and fetching latest...`);

      // Clean up any leftover merge/rebase state from previous runs (includes git clean -fd)
      await cleanupGitState(git!);
      // Ensure we're on a branch before reset (e.g. previous run left detached HEAD mid-rebase).
      await git!.checkout(branch).catch(() => {});

      // Run fetch via spawn with stdio inherit so user sees "Receiving objects" progress (not diffs).
      console.log('  Fetching latest from origin (git output will appear below)...');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['fetch', 'origin', branch], {
          cwd: workdir,
          stdio: 'inherit',
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`git fetch exited ${code ?? 'unknown'}`));
        });
        proc.on('error', (err) => reject(err));
      });
      await git!.checkout(branch);
      await git!.reset(['--hard', `origin/${branch}`]);
      if (options?.additionalBranches?.length) {
        for (const b of options.additionalBranches) {
          if (b && b !== branch) {
            try {
              await git!.raw(['remote', 'set-branches', '--add', 'origin', b]);
              debug('Fetching additional branch', { branch: b });
              // WHY explicit refspec: Plain fetch does not update refs when the refspec is not in
              // remote.origin.fetch (e.g. after --single-branch clone); explicit refspec forces update.
              await git!.fetch(['origin', `+refs/heads/${b}:refs/remotes/origin/${b}`]);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              debug(`Failed to fetch origin/${b}`, { err: msg });
              const isBranchMissing = /couldn't find|does not exist|not found|invalid refspec/i.test(msg);
              if (isBranchMissing) {
                console.warn(`  ⚠ Branch ${b} does not exist on remote; ref origin/${b} will be missing.`);
              } else {
                console.warn(`  ⚠ Failed to fetch origin/${b}: ${msg.slice(0, 80)}${msg.length > 80 ? '…' : ''}`);
              }
            }
          }
        }
      }
      console.log(`Updated to latest ${branch}`);
    }
  }

  if (!isExistingRepo) {
    // Fresh clone. Bootstrap from another workdir for same repo when possible (git is distributed).
    const referencePath = findReferenceWorkdir(workdir, cloneUrl);
    const cloneArgs = ['clone', '--branch', branch, '--single-branch', ...getCloneDepthArg()];
    if (referencePath) {
      cloneArgs.push('--reference', referencePath);
      debug('Using reference workdir for clone', { referencePath, workdir });
      console.log(`  Bootstrapping from existing clone (${referencePath})...`);
    }
    const cloneTimeoutMs = getCloneTimeoutMs();
    const depthNote = process.env.PRR_CLONE_DEPTH?.trim() ? ` shallow depth=${process.env.PRR_CLONE_DEPTH.trim()};` : '';
    console.log(`Cloning repository to ${workdir}...`);
    console.log(
      `  (Git output and any prompts will appear below. Timeout: ${Math.round(cloneTimeoutMs / 1000)}s; PRR_CLONE_TIMEOUT_MS for slow connections.${depthNote} PRR_CLONE_DEPTH for shallow clone.)`,
    );
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', [...cloneArgs, authUrl, workdir], {
        stdio: 'inherit',
      });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearInterval(progressTimer);
        fn();
      };
      let timeoutId: ReturnType<typeof setTimeout>;
      timeoutId = setTimeout(() => {
        proc.kill('SIGKILL');
        settle(() =>
          reject(
            new Error(
              `Clone timed out after ${Math.round(cloneTimeoutMs / 1000)}s. Set PRR_CLONE_TIMEOUT_MS to increase (e.g. 600000 for 10min).`,
            ),
          ),
        );
      }, cloneTimeoutMs);
      const progressIntervalMs = 30_000;
      let progressElapsed = 0;
      const progressTimer = setInterval(() => {
        progressElapsed += progressIntervalMs / 1000;
        console.log(`  Still cloning... (${Math.floor(progressElapsed)}s)`);
      }, progressIntervalMs);
      proc.on('close', (code) => {
        settle(() => {
          if (code === 0) resolve();
          else reject(new Error(`git clone exited ${code ?? 'unknown'}`));
        });
      });
      proc.on('error', (err) => {
        settle(() => reject(err));
      });
    });

    git = simpleGit(workdir);
    if (options?.additionalBranches?.length) {
      for (const b of options.additionalBranches) {
        if (b && b !== branch) {
          try {
            // WHY explicit refspec: --single-branch leaves only the cloned branch in fetch config;
            // explicit refspec guarantees origin/<b> is created/updated so base-merge and others see it.
            await git.raw(['remote', 'set-branches', '--add', 'origin', b]);
            await git.fetch(['origin', `+refs/heads/${b}:refs/remotes/origin/${b}`]);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            debug(`Failed to fetch origin/${b}`, { err: msg });
            const isBranchMissing = /couldn't find|does not exist|not found|invalid refspec/i.test(msg);
            if (isBranchMissing) {
              console.warn(`  ⚠ Branch ${b} does not exist on remote; ref origin/${b} will be missing.`);
            } else {
              console.warn(`  ⚠ Failed to fetch origin/${b}: ${msg.slice(0, 80)}${msg.length > 80 ? '…' : ''}`);
            }
          }
        }
      }
    }
    console.log(`Cloned ${branch} successfully`);
  }

  if (git === undefined) {
    throw new Error('cloneOrUpdate: internal error — git instance was not initialized');
  }
  return { git, workdir };
}

