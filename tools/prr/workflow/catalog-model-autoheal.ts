/**
 * Deterministic restore of catalog-correct model strings after a bot (or human) applied the
 * **wrong** suggested id from an outdated "model typo" review.
 *
 * **When:** `main-loop-setup` immediately after comments are fetched and `currentCommentIds` are set,
 * **before** per-path file hashes used for analysis cache — WHY: healed content must be what the
 * analyzer and cache keys see. **Dedup cluster:** when **`state.dedupCache`** matches the current
 * comment-id set (`dedup-v2`), **`markVerified`** applies to the full LLM dedup cluster (canonical
 * keeps **`catalog-autoheal`** / **`catalog-autoheal-noop`**; dupes reference canonical id).
 *
 * **Commit gate:** Same as fixer path — `verifiedThisSession` must be non-empty. We `markVerified`
 * each healed comment so `commitAndPushChanges` can run on the "no unresolved issues" branch.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import { debug } from '../../../shared/logger.js';
import { formatNumber } from '../ui/reporter.js';
import { resolveTrackedPath } from './helpers/solvability.js';
import { getOutdatedModelCatalogDismissal } from './helpers/outdated-model-advice.js';
import { getDuplicateClusterCommentIds } from './utils.js';

const ENV_DISABLE_AUTOHEAL = 'PRR_DISABLE_MODEL_CATALOG_AUTOHEAL';

/**
 * Mark canonical + dedup siblings verified after catalog heal.
 * Canonical row keeps **`catalog-autoheal`** / **`catalog-autoheal-noop`**; dupes use **`autoVerifiedFrom = canonicalId`**.
 * WHY: Auto-heal runs before analysis — use persisted **`dedupCache.duplicateMap`** when comment IDs match.
 */
function markCatalogHealVerifiedCluster(
  stateContext: StateContext,
  currentCommentId: string,
  duplicateMap: Map<string, string[]> | undefined,
  vs: Set<string>,
  anchorMarker: 'catalog-autoheal' | 'catalog-autoheal-noop',
): boolean {
  const clusterIds = getDuplicateClusterCommentIds(currentCommentId, duplicateMap);
  const canonicalId = clusterIds[0]!;
  let any = false;
  for (const cid of clusterIds) {
    if (Verification.isVerified(stateContext, cid)) continue;
    const marker = cid === canonicalId ? anchorMarker : canonicalId;
    try {
      Verification.markVerified(stateContext, cid, marker);
      vs.add(cid);
      any = true;
    } catch (e) {
      debug('[Auto-heal] markVerified failed', { commentId: cid.slice(0, 7), err: String(e) });
    }
  }
  return any;
}

/**
 * Lines above/below the GitHub review anchor to search for quoted model literals.
 * WHY 20: Large enough to cover multi-line object literals near the comment; small enough to avoid
 * rewriting the same wrong id in unrelated sections of huge files.
 */
export const CATALOG_MODEL_AUTOHEAL_LINE_RADIUS = 20;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace wronglySuggestedId with catalogGoodId only inside double-quoted, single-quoted, and
 * backtick-delimited string literals on given lines.
 * WHY quoted-only: Avoids touching identifiers, import paths, or prose that happen to contain the
 * same substring outside string literals.
 */
/** Count quoted string literals exactly matching `id` (same rules as replace). */
function countQuotedModelIdLiterals(lines: string[], id: string): number {
  return replaceModelIdInQuotedStringsInLines(lines, id, id).count;
}

export function replaceModelIdInQuotedStringsInLines(
  lines: string[],
  wronglySuggestedId: string,
  catalogGoodId: string,
): { lines: string[]; count: number } {
  const bad = wronglySuggestedId;
  const good = catalogGoodId;
  let count = 0;
  const quoted = [
    new RegExp(`"${escapeRe(bad)}"`, 'g'),
    new RegExp(`'${escapeRe(bad)}'`, 'g'),
    new RegExp(`\`${escapeRe(bad)}\``, 'g'),
  ];
  const out = lines.map((line) => {
    let next = line;
    for (const re of quoted) {
      const matches = next.match(re);
      if (matches) count += matches.length;
      next = next.replace(re, (full) => full.replace(bad, good));
    }
    return next;
  });
  return { lines: out, count };
}

export interface CatalogModelAutoHealOutcome {
  /** Repo-relative paths written (quoted literal replacements). */
  modifiedPaths: string[];
  /** At least one comment was markVerified (disk heal or noop-already-correct) — caller should saveState. */
  verificationTouched: boolean;
}

/**
 * Apply heals for all matching review comments. Returns paths touched and whether verification state was updated.
 */
export function applyCatalogModelAutoHeals(
  workdir: string,
  comments: ReviewComment[],
  stateContext: StateContext,
): CatalogModelAutoHealOutcome {
  debug('[Auto-heal] Starting catalog model auto-heal', { workdir, commentCount: comments.length });
  
  if (process.env[ENV_DISABLE_AUTOHEAL]?.trim() === '1') {
    debug('[Auto-heal] Disabled via PRR_DISABLE_MODEL_CATALOG_AUTOHEAL=1');
    return { modifiedPaths: [], verificationTouched: false };
  }

  try {
    const porcelain = execFileSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain'], {
      cwd: workdir,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
    });
    if (porcelain.trim().length > 0) {
      console.warn(
        chalk.yellow(
          '  Catalog auto-heal skipped: workdir has uncommitted changes — refusing to edit files on a dirty tree',
        ),
      );
      debug('[Auto-heal] Skipped — dirty worktree', {
        workdir,
        porcelainLines: porcelain.trim().split('\n').length,
      });
      return { modifiedPaths: [], verificationTouched: false };
    }
  } catch (e) {
    console.warn(
      chalk.yellow(
        `  Catalog auto-heal skipped: could not read git status in workdir — ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    return { modifiedPaths: [], verificationTouched: false };
  }

  const modified: string[] = [];
  if (!stateContext.verifiedThisSession) {
    stateContext.verifiedThisSession = new Set<string>();
  }
  const vs = stateContext.verifiedThisSession;

  const sortedCommentKey = comments.map((c) => c.id).sort().join(',');
  const persistedDedup = stateContext.state?.dedupCache;
  let duplicateMapForHeal: Map<string, string[]> | undefined;
  if (
    persistedDedup?.commentIds === sortedCommentKey &&
    persistedDedup.schema === 'dedup-v2' &&
    persistedDedup.duplicateMap &&
    typeof persistedDedup.duplicateMap === 'object'
  ) {
    duplicateMapForHeal = new Map(Object.entries(persistedDedup.duplicateMap));
    debug('[Auto-heal] Persisted dedup map available for cluster verification', {
      groupCount: duplicateMapForHeal.size,
    });
  }

  let checkedCount = 0;
  let matchedCount = 0;
  let skippedNoPath = 0;
  let skippedNoResolvedPath = 0;
  let skippedNoFile = 0;
  let skippedNoLine = 0;
  let skippedNoReplacements = 0;
  /** Matched outdated advice but file never contained quoted wrong id — already catalog-correct. */
  let verifiedNoOp = 0;
  let verificationTouched = false;

  for (const comment of comments) {
    checkedCount++;
    const dismissal = getOutdatedModelCatalogDismissal(comment.body ?? '');
    if (!dismissal) {
      // WHY no per-comment debug: almost every comment misses catalog auto-heal; verbose runs
      // flooded output.log (audit Cycle 78). Use Summary below + PRR_DEBUG for deep dives.
      continue;
    }
    
    matchedCount++;
    const clusterEarly = getDuplicateClusterCommentIds(comment.id, duplicateMapForHeal);
    const canonicalEarly = clusterEarly[0]!;
    if (
      comment.id !== canonicalEarly &&
      clusterEarly.some((id) => Verification.isVerified(stateContext, id))
    ) {
      debug('[Auto-heal] Skipping duplicate row — cluster already verified', {
        commentId: comment.id.slice(0, 7),
        canonicalId: canonicalEarly.slice(0, 7),
      });
      continue;
    }

    debug('[Auto-heal] Found outdated model advice comment', {
      commentId: comment.id.slice(0, 7),
      path: comment.path,
      line: comment.line,
      catalogGoodId: dismissal.pair.catalogGoodId,
      wronglySuggestedId: dismissal.pair.wronglySuggestedId,
      reason: dismissal.reason,
    });
    
    if (!comment.path) {
      skippedNoPath++;
      debug('[Auto-heal] Skipping: comment has no path', { commentId: comment.id.slice(0, 7) });
      continue;
    }
    
    const rel = resolveTrackedPath(workdir, comment.path, comment.body ?? '');
    if (!rel) {
      skippedNoResolvedPath++;
      debug('[Auto-heal] Skipping: could not resolve tracked path', { 
        commentId: comment.id.slice(0, 7),
        originalPath: comment.path,
        workdir,
      });
      continue;
    }
    
    const abs = join(workdir, rel);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
      debug('[Auto-heal] Read file for healing', { 
        commentId: comment.id.slice(0, 7),
        resolvedPath: rel,
        absolutePath: abs,
        fileSize: content.length,
        lineCount: content.split('\n').length,
      });
    } catch (err) {
      skippedNoFile++;
      debug('[Auto-heal] Skipping: file not found or unreadable', { 
        commentId: comment.id.slice(0, 7),
        resolvedPath: rel,
        absolutePath: abs,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    
    const allLines = content.split('\n');
    const line = comment.line;
    const n = allLines.length;
    if (line == null || line < 1) {
      skippedNoLine++;
      debug('[Auto-heal] Skipping: comment has no line number or invalid line', { 
        commentId: comment.id.slice(0, 7),
        resolvedPath: rel,
        line: comment.line,
      });
      continue;
    }
    
    const idx0 = line - 1;
    const start = Math.max(0, idx0 - CATALOG_MODEL_AUTOHEAL_LINE_RADIUS);
    const end = Math.min(n, idx0 + CATALOG_MODEL_AUTOHEAL_LINE_RADIUS + 1);
    const windowLines = allLines.slice(start, end);
    
    debug('[Auto-heal] Computing replacement window', {
      commentId: comment.id.slice(0, 7),
      resolvedPath: rel,
      targetLine: line,
      windowStart: start + 1, // 1-based for user
      windowEnd: end, // 1-based for user
      windowLineCount: windowLines.length,
      searchFor: dismissal.pair.wronglySuggestedId,
      replaceWith: dismissal.pair.catalogGoodId,
    });
    
    const wrongly = dismissal.pair.wronglySuggestedId;
    const good = dismissal.pair.catalogGoodId;

    let { lines: newWindow, count } = replaceModelIdInQuotedStringsInLines(
      windowLines,
      wrongly,
      good,
    );
    let useFullFile = false;

    // Full-file fallback when anchor window has no quoted wrong id (output.log audit eliza#6575).
    // WHY: Review anchor line (e.g. 35) may sit on env checks while `model: "gpt-4o-mini"` lives
    // elsewhere; ±20 lines then misses the only place a bad "fix" was applied.
    if (count === 0) {
      debug('[Auto-heal] Anchor window missed quoted wrong id — trying full-file fallback', {
        commentId: comment.id.slice(0, 7),
        resolvedPath: rel,
        targetLine: line,
        windowLines1Based: `${formatNumber(start + 1)}–${formatNumber(end)}`,
        radius: CATALOG_MODEL_AUTOHEAL_LINE_RADIUS,
        searchQuotedId: wrongly,
      });
      const full = replaceModelIdInQuotedStringsInLines(allLines, wrongly, good);
      if (full.count > 0) {
        newWindow = full.lines;
        count = full.count;
        useFullFile = true;
        debug('[Auto-heal] Full-file fallback matched', {
          commentId: comment.id.slice(0, 7),
          resolvedPath: rel,
          replacementCount: count,
          searchFor: wrongly,
        });
        console.log(
          chalk.gray(
            `  Catalog auto-heal: ±${formatNumber(CATALOG_MODEL_AUTOHEAL_LINE_RADIUS)} line window missed \`${wrongly}\` — used full-file search (${formatNumber(count)} replacement(s)) in ${rel}`,
          ),
        );
      }
    }

    if (count === 0) {
      // Code never had the bot's wrongly-suggested id in quotes; if catalog-good id appears in quotes,
      // the PR is already correct — mark verified so we skip fixer (output.log audit eliza#6575).
      const wrongQuoted = countQuotedModelIdLiterals(allLines, wrongly);
      const goodQuoted = countQuotedModelIdLiterals(allLines, good);
      if (wrongQuoted === 0 && goodQuoted > 0) {
        verifiedNoOp++;
        if (
          markCatalogHealVerifiedCluster(
            stateContext,
            comment.id,
            duplicateMapForHeal,
            vs,
            'catalog-autoheal-noop',
          )
        ) {
          verificationTouched = true;
        }
        debug('[Auto-heal] No file change needed — file already uses catalog model id in literals', {
          commentId: comment.id.slice(0, 7),
          resolvedPath: rel,
          catalogGoodId: good,
          wronglySuggestedId: wrongly,
          goodQuotedLiterals: goodQuoted,
        });
        console.log(
          chalk.cyan(
            `  Catalog auto-heal: no edit needed — ${rel} already has \`${good}\` in string literal(s); marked review ${comment.id.slice(0, 7)}… verified (outdated model advice)`,
          ),
        );
        continue;
      }

      skippedNoReplacements++;
      debug('[Auto-heal] Skipping: no replacements found in window or full file', {
        commentId: comment.id.slice(0, 7),
        resolvedPath: rel,
        targetLine: line,
        windowStart: start + 1,
        windowEnd: end,
        searchFor: wrongly,
        wrongQuotedLiterals: wrongQuoted,
        goodQuotedLiterals: goodQuoted,
        windowPreview: windowLines.slice(0, 3).join(' | ').substring(0, 100),
      });
      continue;
    }

    debug('[Auto-heal] Found replacements, applying heal', {
      commentId: comment.id.slice(0, 7),
      resolvedPath: rel,
      replacementCount: count,
      searchFor: wrongly,
      replaceWith: good,
      scope: useFullFile ? 'full-file' : 'anchor-window',
    });

    const merged = useFullFile
      ? newWindow
      : [...allLines.slice(0, start), ...newWindow, ...allLines.slice(end)];
    writeFileSync(abs, merged.join('\n'), 'utf8');
    modified.push(rel);
    if (
      markCatalogHealVerifiedCluster(stateContext, comment.id, duplicateMapForHeal, vs, 'catalog-autoheal')
    ) {
      verificationTouched = true;
    }
    debug('[Auto-heal] Marked cluster as verified (disk heal)', { commentId: comment.id.slice(0, 7) });
    
    console.log(
      chalk.cyan(
        `  Catalog auto-heal: restored ${dismissal.pair.catalogGoodId} (${formatNumber(count)} string literal(s)) in ${rel} — review comment ${comment.id.slice(0, 7)}…`,
      ),
    );
  }

  debug('[Auto-heal] Summary', {
    totalComments: comments.length,
    checked: checkedCount,
    matchedPattern: matchedCount,
    skippedNoPath,
    skippedNoResolvedPath,
    skippedNoFile,
    skippedNoLine,
    skippedNoReplacements,
    verifiedNoOpAlreadyCorrect: verifiedNoOp,
    healed: modified.length,
    healedPaths: modified,
  });

  return { modifiedPaths: modified, verificationTouched };
}
