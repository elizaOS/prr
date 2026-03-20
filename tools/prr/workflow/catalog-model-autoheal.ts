/**
 * Deterministic restore of catalog-correct model strings after a bot (or human) applied the
 * **wrong** suggested id from an outdated "model typo" review.
 *
 * **When:** `main-loop-setup` immediately after comments are fetched and `currentCommentIds` are set,
 * **before** per-path file hashes used for analysis cache — WHY: healed content must be what the
 * analyzer and cache keys see.
 *
 * **Commit gate:** Same as fixer path — `verifiedThisSession` must be non-empty. We `markVerified`
 * each healed comment so `commitAndPushChanges` can run on the "no unresolved issues" branch.
 */

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

const ENV_DISABLE_AUTOHEAL = 'PRR_DISABLE_MODEL_CATALOG_AUTOHEAL';

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

/**
 * Apply heals for all matching review comments. Returns repo-relative paths touched.
 */
export function applyCatalogModelAutoHeals(workdir: string, comments: ReviewComment[], stateContext: StateContext): string[] {
  debug('[Auto-heal] Starting catalog model auto-heal', { workdir, commentCount: comments.length });
  
  if (process.env[ENV_DISABLE_AUTOHEAL]?.trim() === '1') {
    debug('[Auto-heal] Disabled via PRR_DISABLE_MODEL_CATALOG_AUTOHEAL=1');
    return [];
  }
  
  const modified: string[] = [];
  if (!stateContext.verifiedThisSession) {
    stateContext.verifiedThisSession = new Set<string>();
  }
  const vs = stateContext.verifiedThisSession;

  let checkedCount = 0;
  let matchedCount = 0;
  let skippedNoPath = 0;
  let skippedNoResolvedPath = 0;
  let skippedNoFile = 0;
  let skippedNoLine = 0;
  let skippedNoReplacements = 0;

  for (const comment of comments) {
    checkedCount++;
    // Debug specific comment IDs that should match but don't
    const isTargetComment = comment.id.includes('4079055770') || comment.id.includes('4050517082');
    if (isTargetComment) {
      debug('[Auto-heal] Checking target comment', {
        commentId: comment.id,
        path: comment.path,
        line: comment.line,
        bodyPreview: comment.body?.substring(0, 200),
        bodyLength: comment.body?.length ?? 0,
      });
    }
    const dismissal = getOutdatedModelCatalogDismissal(comment.body ?? '');
    if (!dismissal) {
      if (isTargetComment) {
        debug('[Auto-heal] Target comment did not match - checking why', {
          commentId: comment.id,
          hasFraming: /incorrect\s+model\s+name|model\s+name\s+typo/i.test(comment.body ?? ''),
          bodyPreview: comment.body?.substring(0, 300),
        });
      }
      debug('[Auto-heal] Comment does not match outdated model advice pattern', { 
        commentId: comment.id.slice(0, 7), 
        path: comment.path,
        hasBody: !!comment.body,
        bodyLength: comment.body?.length ?? 0,
      });
      continue;
    }
    
    matchedCount++;
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
    
    const { lines: newWindow, count } = replaceModelIdInQuotedStringsInLines(
      windowLines,
      dismissal.pair.wronglySuggestedId,
      dismissal.pair.catalogGoodId,
    );
    
    if (count === 0) {
      skippedNoReplacements++;
      debug('[Auto-heal] Skipping: no replacements found in window', {
        commentId: comment.id.slice(0, 7),
        resolvedPath: rel,
        targetLine: line,
        windowStart: start + 1,
        windowEnd: end,
        searchFor: dismissal.pair.wronglySuggestedId,
        windowPreview: windowLines.slice(0, 3).join(' | ').substring(0, 100),
      });
      continue;
    }
    
    debug('[Auto-heal] Found replacements, applying heal', {
      commentId: comment.id.slice(0, 7),
      resolvedPath: rel,
      replacementCount: count,
      searchFor: dismissal.pair.wronglySuggestedId,
      replaceWith: dismissal.pair.catalogGoodId,
    });
    
    const merged = [...allLines.slice(0, start), ...newWindow, ...allLines.slice(end)];
    writeFileSync(abs, merged.join('\n'), 'utf8');
    modified.push(rel);
    vs.add(comment.id);
    
    try {
      Verification.markVerified(stateContext, comment.id, 'catalog-autoheal');
      debug('[Auto-heal] Marked comment as verified', { commentId: comment.id.slice(0, 7) });
    } catch (e) {
      // WHY swallow: Disk is already healed; missing state should not abort the run. Commit message
      // may list fewer issues than healed files until state loads on a later run.
      debug('[Auto-heal] markVerified failed (state not loaded?)', { 
        commentId: comment.id.slice(0, 7), 
        err: String(e) 
      });
    }
    
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
    healed: modified.length,
    healedPaths: modified,
  });

  return modified;
}
