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
 *
 * **In-process cache (workdir + branch + HEAD):** Repeated calls with the same refs reuse the
 * parsed comment-id list so recovery does not re-run `git log` / grep when nothing changed.
 * **WHY:** Pill noted redundant scans; the scan is bounded but still avoidable when setup and
 * recovery share one HEAD. Tests call **`clearScanCommittedFixesCache()`**.
 */
import type { SimpleGit } from 'simple-git';
import { debug, formatNumber, warn } from '../logger.js';

/** One warning per process per workdir+reason when merge base for prr-fix scan is missing (pill-output #559). */
const warnedScanBaseFallback = new Set<string>();
/** One warning per process per workdir when git log --grep scan throws (non-fatal degrade). */
const warnedScanRawFailure = new Set<string>();

function scanDegradeWarnKey(workdir: string | undefined, tag: string): string {
  return `${workdir ?? '?'}\0${tag}`;
}

/** In-process cache: same workdir + branch + HEAD → same grep scan (pill: avoid redundant git log). */
const committedFixScanCache = new Map<string, string[]>();
const MAX_SCAN_CACHE_ENTRIES = 64;

/**
 * Include resolved merge base (or `n100` when using recent-commit cap) so two clones reusing the
 * same workdir path cannot share a cache entry when fallback picks different bases (pill-output).
 */
function scanCacheKey(
  workdir: string,
  branch: string,
  headSha: string,
  prBaseBranch: string | undefined,
  resolvedBaseLabel: string,
): string {
  const base = prBaseBranch?.trim() ?? '';
  return `${workdir}\0${branch}\0${headSha}\0${base}\0${resolvedBaseLabel}`;
}

/** Resolve `origin/<prBase>` or first existing of origin/main|master|develop for `base..branch` log range. */
async function resolveScanBaseBranch(git: SimpleGit, prBaseBranch?: string): Promise<string | null> {
  const prBase = prBaseBranch?.trim();
  if (prBase) {
    const prRef = `origin/${prBase}`;
    try {
      await git.raw(['rev-parse', '--verify', prRef]);
      return prRef;
    } catch {
      /* fall through — base branch may not be fetched yet */
    }
  }
  for (const candidate of ['origin/main', 'origin/master', 'origin/develop'] as const) {
    try {
      await git.raw(['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function rememberScanCache(key: string, ids: string[]): void {
  if (committedFixScanCache.size >= MAX_SCAN_CACHE_ENTRIES) {
    const firstKey = committedFixScanCache.keys().next().value as string | undefined;
    if (firstKey !== undefined) committedFixScanCache.delete(firstKey);
  }
  committedFixScanCache.set(key, ids);
}

/** Clear process-wide scan cache (tests or long-lived hosts). */
export function clearScanCommittedFixesCache(): void {
  committedFixScanCache.clear();
  warnedScanBaseFallback.clear();
  warnedScanRawFailure.clear();
}

export interface ScanCommittedFixesOptions {
  /** When set with headSha, reuse a prior in-process result for this workdir/branch/HEAD. */
  workdir?: string;
  headSha?: string;
  /**
   * GitHub PR base branch name (e.g. `develop`, `v2.0.0`). When set, PRR tries `origin/<name>` first
   * for the `base..branch` log range before falling back to origin/main|master|develop.
   * WHY: Repos whose default is not main/master/develop used to leave `baseBranch` null in debug and
   * rely on `-n 100`; using the real PR base matches pill/external audits expecting a proper merge range.
   */
  prBaseBranch?: string;
}

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
 * WHY preserve original casing:
 * The state's verifiedFixed array stores IDs in their original case from the API.
 * We preserve casing from commit messages so markers match on recovery.
 *
 * WHY return empty array on error:
 * Failure to scan is not fatal - we'll just start with no recovered state and
 * verify everything fresh. Throwing would prevent startup on minor git issues.
 * 
 * @param git - SimpleGit instance for the repository
 * @param branch - Current PR branch name
 * @param opts - Optional cache: pass workdir + headSha to dedupe scans in one process
 * @returns Array of comment IDs that were previously committed (empty on error)
 */
export async function scanCommittedFixes(
  git: SimpleGit,
  branch: string,
  opts?: ScanCommittedFixesOptions
): Promise<string[]> {
  let resolvedBase: string | null = null;
  try {
    resolvedBase = await resolveScanBaseBranch(git, opts?.prBaseBranch);
  } catch (error) {
    debug('resolveScanBaseBranch failed', { error });
    resolvedBase = null;
  }
  const cacheKeySuffix = resolvedBase ?? 'n100';

  if (resolvedBase === null) {
    const prBase = opts?.prBaseBranch?.trim();
    const tag = prBase ? `missing-base:pr:${prBase}` : 'missing-base:no-origin-default';
    const wk = scanDegradeWarnKey(opts?.workdir, tag);
    if (!warnedScanBaseFallback.has(wk)) {
      warnedScanBaseFallback.add(wk);
      if (prBase) {
        warn(
          `[PRR] Git recovery scan: could not resolve \`origin/${prBase}\` or a default branch ref (main/master/develop). Using last ${formatNumber(100)} commits instead of \`base..HEAD\` — fetch the PR base with additionalBranches if needed; older \`prr-fix:\` markers may be missed.`,
        );
      } else {
        warn(
          `[PRR] Git recovery scan: no \`origin/main\`, \`origin/master\`, or \`origin/develop\` ref — using last ${formatNumber(100)} commits for \`prr-fix:\` recovery (typical of shallow/single-branch clones).`,
        );
      }
    }
  }

  if (opts?.workdir && opts?.headSha) {
    const key = scanCacheKey(opts.workdir, branch, opts.headSha, opts.prBaseBranch, cacheKeySuffix);
    const hit = committedFixScanCache.get(key);
    if (hit) {
      debug('scanCommittedFixes (cache hit)', {
        branch,
        headSha: opts.headSha.slice(0, 7),
        resolvedBase: cacheKeySuffix,
      });
      return [...hit];
    }
  }

  try {
    const baseBranch = resolvedBase;

    // If no common base branch found, fall back to searching all history
    // WHY limit to 100: Prevents scanning thousands of commits in large repos
    // WHY still safe: Typical PRs have < 20 commits, 100 is very generous
    const logArgs = baseBranch
      ? ['log', '--grep=prr-fix:', '--format=%B', `${baseBranch}..${branch}`]
      : ['log', '--grep=prr-fix:', '--format=%B', '-n', '100'];

    debug('scanCommittedFixes', { baseBranch, branch, logArgs });
    const logOutput = await git.raw(logArgs);

    const commentIds: string[] = [];

    // Parse prr-fix:ID markers (multiple per line for squash-style messages; pill-output).
    if (logOutput) {
      const lines = logOutput.split('\n');
      for (const line of lines) {
        const markerRe = /prr-fix:(\S+)/g;
        let m: RegExpExecArray | null;
        while ((m = markerRe.exec(line)) !== null) {
          commentIds.push(m[1]!.trim());
        }
      }
    }

    // Deduplicate: the same ID can appear in multiple commits
    const unique = [...new Set(commentIds)];
    if (opts?.workdir && opts?.headSha) {
      rememberScanCache(
        scanCacheKey(opts.workdir, branch, opts.headSha, opts.prBaseBranch, cacheKeySuffix),
        unique,
      );
    }
    return unique;
  } catch (error) {
    // WHY catch and return empty instead of throw:
    // Scan failure shouldn't prevent startup - we'll just verify everything fresh
    const wk = scanDegradeWarnKey(opts?.workdir, 'log-failed');
    if (!warnedScanRawFailure.has(wk)) {
      warnedScanRawFailure.add(wk);
      const detail = error instanceof Error ? error.message : String(error);
      warn(
        `[PRR] Git recovery scan failed (${detail}) — continuing without recovered prr-fix markers. Next verification may re-run for issues fixed in prior commits.`,
      );
    }
    debug('Failed to scan committed fixes', { error });
    return [];
  }
}
