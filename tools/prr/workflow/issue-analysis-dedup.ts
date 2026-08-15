/**
 * Heuristic, LLM, and cross-file deduplication of review comments.
 * Extracted from issue-analysis.ts (structural refactor).
 */
import chalk from 'chalk';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import type { DismissedIssue } from '../state/types.js';
import * as CommentStatusAPI from '../state/state-comment-status.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Verification from '../state/state-verification.js';
import { getDuplicateClusterCommentIds } from './utils.js';
import { sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';
import { stripSeverityFraming } from './helpers/review-body-normalize.js';
import type { LLMClient } from '../llm/client.js';
import { LLM_DEDUP_MAX_CONCURRENT } from '../../../shared/constants.js';
import { debug, formatNumber, warn } from '../../../shared/logger.js';

/**
 * Dedup cache is persisted in state (stateContext.state.dedupCache).
 * WHY: In-memory cache reset each run; audit showed all dedup LLM calls returning NONE on repeat runs.
 * Persisting keyed by sorted comment IDs makes the outcome deterministic for the same set, so we skip
 * the dedup LLM and save tokens/latency when the comment set is unchanged (e.g. re-run or next push iteration).
 * `schema: 'dedup-v2'` is required for a cache hit: cross-file dedup (Phase 3) changed outputs; entries without
 * schema must recompute so we do not reuse pre-cross-file groupings.
 */

/**
 * Result of the deduplication process
 */
export interface DedupResult {
  /** Items to proceed with (canonicals + non-duplicates) */
  dedupedToCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
    resolvedPath?: string;
  }>;
  /** Maps canonical commentId -> duplicate commentIds */
  duplicateMap: Map<string, string[]>;
  /** Duplicate items keyed by commentId (for context merging) */
  duplicateItems: Map<string, {
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
  }>;
}

/** Minimal shape for overlap resolution (per-file + cross-file dedup). */
export type DedupGroupItem = {
  comment: ReviewComment;
  codeSnippet?: string;
  contextHints?: string[];
  resolvedPath?: string;
};

/**
 * When the LLM emits multiple GROUP lines, the same index may appear twice (e.g. issue 70 in two groups).
 * Keep **first** group order; later groups drop indices already assigned (pill-output / prompts.log audits).
 */
export function resolveOverlappingDedupGroupsByIndex<T extends DedupGroupItem>(
  groups: Array<{ canonical: T; dupes: T[] }>,
  items: T[],
): Array<{ canonical: T; dupes: T[] }> {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    idToIdx.set(items[i]!.comment.id, i);
  }
  const used = new Set<number>();
  const out: Array<{ canonical: T; dupes: T[] }> = [];

  for (const g of groups) {
    const rawIdxs = [g.canonical, ...g.dupes]
      .map((m) => idToIdx.get(m.comment.id))
      .filter((i): i is number => i !== undefined);
    const memberIdx = [...new Set(rawIdxs)];
    const available = memberIdx.filter((i) => !used.has(i));
    if (available.length < 2) {
      if (memberIdx.some((i) => used.has(i))) {
        debug('Dedup: dropped overlapping GROUP — index(s) already merged earlier', {
          memberIndices: memberIdx.map((i) => i + 1),
        });
      }
      continue;
    }

    const origCanonIdx = idToIdx.get(g.canonical.comment.id);
    const canonicalIdx =
      origCanonIdx !== undefined && available.includes(origCanonIdx)
        ? origCanonIdx
        : available.reduce((best, i) =>
            items[i]!.comment.body.length > items[best]!.comment.body.length ? i : best,
            available[0]!,
          );
    const dupeIdxs = available.filter((i) => i !== canonicalIdx);
    for (const i of available) {
      used.add(i);
    }
    out.push({ canonical: items[canonicalIdx]!, dupes: dupeIdxs.map((i) => items[i]!) });
  }
  return out;
}

/**
 * Propagate the same comment status to every other member of the LLM dedup cluster.
 * **WHY:** Only one row per cluster is LLM-analyzed; siblings must mirror status in **`commentStatuses`**
 * (debug table / cache hits). Uses **`resolveEffectiveDuplicateMapForComments`** so persisted **`dedupCache`**
 * still expands the cluster when **`duplicateMap`** is empty. Uses **`getDuplicateClusterCommentIds`** so
 * propagation works when **`analyzedCommentId`** is a duplicate (map keys are canonical ids only).
 */
export function propagateStatusToDuplicates(
  stateContext: StateContext,
  analyzedCommentId: string,
  dedupResult: DedupResult,
  fileHashes: Map<string, string>,
  status:
    | { kind: 'resolved'; classification: string; explanation: string }
    | { kind: 'open'; classification: string; explanation: string; importance: number; ease: number },
  allComments?: readonly ReviewComment[],
): void {
  const list = allComments?.length ? [...allComments] : undefined;
  const map =
    resolveEffectiveDuplicateMapForComments(stateContext, dedupResult.duplicateMap, list) ??
    dedupResult.duplicateMap;
  const cluster = getDuplicateClusterCommentIds(analyzedCommentId, map);
  for (const otherId of cluster) {
    if (otherId === analyzedCommentId) continue;
    const dupItem = dedupResult.duplicateItems.get(otherId);
    const path =
      dupItem?.comment.path ?? list?.find((c) => c.id === otherId)?.path ?? '';
    const fHash = path ? fileHashes.get(path) || '__missing__' : '__missing__';
    if (status.kind === 'resolved') {
      CommentStatusAPI.markResolved(
        stateContext,
        otherId,
        status.classification as 'stale' | 'fixed',
        status.explanation,
        path,
        fHash,
      );
    } else {
      CommentStatusAPI.markOpen(
        stateContext,
        otherId,
        status.classification as 'exists',
        status.explanation,
        status.importance,
        status.ease,
        path,
        fHash,
      );
    }
  }
}

/** Sibling review threads for **`UnresolvedIssue.mergedDuplicates`** (fix prompt / dedup UX). */
export interface MergedDuplicateRow {
  commentId: string;
  author: string;
  body: string;
  path: string;
  line: number | null;
}

/**
 * Rows for every *other* comment in the same LLM dedup cluster as the anchor (representative) row.
 * **WHY:** Call sites used **`duplicateMap.get(anchorId)`**, which misses when **`duplicateMap`** is empty
 * but **`clusterMapForAnalysis`** (from **`resolveEffectiveDuplicateMapForComments`**) still restores the cluster
 * from **`dedup-v2`** cache, and when a sibling is missing from **`duplicateItems`** but present in **`allComments`**.
 */
export function buildMergedDuplicatesForAnchor(
  anchorCommentId: string,
  clusterMap: Map<string, string[]> | undefined,
  duplicateItems: DedupResult['duplicateItems'],
  allComments?: readonly ReviewComment[],
): MergedDuplicateRow[] | undefined {
  const otherIds = getDuplicateClusterCommentIds(anchorCommentId, clusterMap).filter(
    (id) => id !== anchorCommentId,
  );
  if (otherIds.length === 0) return undefined;
  const list = allComments?.length ? [...allComments] : undefined;
  const rows: MergedDuplicateRow[] = [];
  for (const dupId of otherIds) {
    const dupItem = duplicateItems.get(dupId);
    if (dupItem) {
      rows.push({
        commentId: dupItem.comment.id,
        author: dupItem.comment.author,
        body: dupItem.comment.body,
        path: dupItem.comment.path,
        line: dupItem.comment.line,
      });
      continue;
    }
    const c = list?.find((x) => x.id === dupId);
    if (c) {
      rows.push({
        commentId: c.id,
        author: c.author,
        body: c.body,
        path: c.path,
        line: c.line,
      });
    }
  }
  return rows.length > 0 ? rows : undefined;
}

/**
 * Dismiss every id in the LLM dedup cluster (canonical + dupes).
 * WHY: `propagateStatusToDuplicates` only updates commentStatuses; persisted **`dismissedIssues`**
 * and thread-reply accounting need each thread id dismissed — same gap as verify/recovery cluster marking.
 */
export function dismissDuplicateCluster(
  stateContext: StateContext,
  anchorComment: ReviewComment,
  duplicateMap: Map<string, string[]>,
  duplicateItems: DedupResult['duplicateItems'],
  reason: string,
  category: DismissedIssue['category'],
  remediationHint?: string,
): void {
  for (const cid of getDuplicateClusterCommentIds(anchorComment.id, duplicateMap)) {
    const rc = cid === anchorComment.id ? anchorComment : duplicateItems.get(cid)?.comment;
    if (!rc) continue;
    Dismissed.dismissIssue(
      stateContext,
      cid,
      reason,
      category,
      rc.path,
      rc.line,
      rc.body ?? '',
      cid === anchorComment.id ? remediationHint : undefined,
    );
  }
}

/**
 * Same as {@link dismissDuplicateCluster} but resolves sibling rows from **`allComments`**
 * (fix loop / push iteration have no `duplicateItems` map). Missing ids are skipped.
 */
export function dismissDuplicateClusterFromComments(
  stateContext: StateContext,
  anchorComment: ReviewComment,
  duplicateMap: Map<string, string[]> | undefined,
  allComments: ReviewComment[],
  reason: string,
  category: DismissedIssue['category'],
  remediationHint?: string,
): void {
  const byId = new Map(allComments.map((c) => [c.id, c]));
  for (const cid of getDuplicateClusterCommentIds(anchorComment.id, duplicateMap)) {
    const rc = cid === anchorComment.id ? anchorComment : byId.get(cid);
    if (!rc) continue;
    Dismissed.dismissIssue(
      stateContext,
      cid,
      reason,
      category,
      rc.path,
      rc.line,
      rc.body ?? '',
      cid === anchorComment.id ? remediationHint : undefined,
    );
  }
}

/**
 * Rows for {@link dismissDuplicateClusterFromComments} when the full PR list may be missing.
 * Unions **`issues[].comment`** with **`allComments`** (same id: PR row wins) so cluster siblings still in the fix batch
 * get dismissed together instead of anchor-only **`dismissIssue`**.
 */
export function mergeCommentsForClusterDismiss(
  allComments: readonly ReviewComment[] | undefined,
  issues: readonly { comment: ReviewComment }[],
): ReviewComment[] {
  const byId = new Map<string, ReviewComment>();
  for (const { comment } of issues) {
    byId.set(comment.id, comment);
  }
  if (allComments?.length) {
    for (const c of allComments) {
      byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

/**
 * Cluster ids that are **verified or dismissed** after a cluster dismiss attempt.
 * **WHY:** {@link dismissDuplicateClusterFromComments} skips ids missing from the PR row list; callers
 * must not remove those ids from the fix queue anyway or we get an empty queue while threads stay open
 * (BUG DETECTED repopulate — same class as `filterUnresolvedKeepUnaccountedClusterMembers` in no-changes).
 */
export function getClusterIdsAccountedOnState(
  stateContext: StateContext,
  anchorId: string,
  duplicateMap: Map<string, string[]> | undefined,
): string[] {
  return getDuplicateClusterCommentIds(anchorId, duplicateMap).filter(
    (cid) =>
      Dismissed.isCommentDismissed(stateContext, cid) || Verification.isVerified(stateContext, cid),
  );
}

/**
 * Reuse **`state.dedupCache.duplicateMap`** when the PR comment id key is unchanged (`dedup-v2`).
 * **WHY:** Pre-dedup dismissals (solvability, positive-only, placeholder, could-not-inject) used to touch only
 * one thread id; siblings stayed open until after the LLM dedup phase re-ran.
 */
export function getPersistedDedupMapForCommentSet(
  stateContext: StateContext,
  allCommentIdsKey: string,
): Map<string, string[]> | undefined {
  const persisted = stateContext.state?.dedupCache;
  if (
    !persisted ||
    persisted.commentIds !== allCommentIdsKey ||
    persisted.schema !== 'dedup-v2' ||
    !persisted.duplicateMap ||
    typeof persisted.duplicateMap !== 'object'
  ) {
    return undefined;
  }
  return new Map<string, string[]>(Object.entries(persisted.duplicateMap));
}

/**
 * Map to use for cluster dismissals mid–fix-loop when **`duplicateMap`** was not passed or is empty
 * but **`state.dedupCache`** still matches the current PR comment id set (`dedup-v2`).
 * **WHY:** `recheckSolvability` / `verifyFixes` used to single-dismiss when `duplicateMap` was missing;
 * duplicate threads stayed open until the next analysis pass.
 */
export function resolveEffectiveDuplicateMapForComments(
  stateContext: StateContext,
  duplicateMap: Map<string, string[]> | undefined,
  allComments: ReviewComment[] | undefined,
): Map<string, string[]> | undefined {
  if (duplicateMap && duplicateMap.size > 0) {
    return duplicateMap;
  }
  if (!allComments?.length) {
    return duplicateMap;
  }
  const key = [...allComments.map((c) => c.id)].sort().join(',');
  return getPersistedDedupMapForCommentSet(stateContext, key) ?? duplicateMap;
}

/**
 * Cluster map for **`trySingleIssueFix` / `tryDirectLLMFix`** when **`allComments`** may be absent.
 * **WHY:** `duplicateMapForSession` can be empty while **`state.dedupCache`** still holds `dedup-v2` data;
 * without this, recovery only marked/dismissed the anchor thread.
 * When **`allComments`** is present and its sorted id key **≠** `dedupCache.commentIds`, skips persisted
 * fallback (comment set changed without a matching cache key).
 */
export function resolveDuplicateMapForRecovery(
  stateContext: StateContext,
  duplicateMap: Map<string, string[]> | undefined,
  allComments?: ReviewComment[],
): Map<string, string[]> | undefined {
  const fromComments = resolveEffectiveDuplicateMapForComments(stateContext, duplicateMap, allComments);
  if (fromComments && fromComments.size > 0) {
    return fromComments;
  }
  const persisted = stateContext.state?.dedupCache;
  const idsKey = allComments?.length ? [...allComments.map((c) => c.id)].sort().join(',') : undefined;
  if (
    persisted?.schema === 'dedup-v2' &&
    persisted.commentIds &&
    persisted.duplicateMap &&
    typeof persisted.duplicateMap === 'object' &&
    (!idsKey || idsKey === persisted.commentIds)
  ) {
    const m = getPersistedDedupMapForCommentSet(stateContext, persisted.commentIds);
    if (m && m.size > 0) {
      return m;
    }
  }
  return fromComments ?? duplicateMap;
}

/**
 * Log duplicate candidate groups for analysis.
 * Phase 0: Observation only - no filtering or behavior change.
 * 
 * Groups issues by file path and line proximity to identify potential duplicates.
 * 
 * @param toCheck Array of issues with snippets to analyze
 */
export function logDuplicateCandidates(
  toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
  }>,
  /** Stable commentId → display number mapping, built from toCheck order.
   *  HISTORY: Originally this function built its own `globalIdx` counter
   *  sequentially across groups. But heuristicDedup used `toCheck` array
   *  position for its verdict display — different ordering, different numbers.
   *  Now both functions share this single map so #7 means the same comment
   *  everywhere in the output. */
  idToDisplayNum: Map<string, number>,
): void {
  // Skip if too few issues to have meaningful duplicates
  if (toCheck.length <= 3) {
    return;
  }

  // Group by file path
  const byFile = new Map<string, typeof toCheck>();
  for (const item of toCheck) {
    const path = item.comment.path;
    if (!byFile.has(path)) {
      byFile.set(path, []);
    }
    byFile.get(path)!.push(item);
  }

  // Find candidate duplicate groups within each file
  const candidateGroups: Array<{
    file: string;
    lineRange: string;
    items: typeof toCheck;
    sameAuthor: boolean;
    authors: Set<string>;
  }> = [];

  for (const [file, items] of byFile.entries()) {
    if (items.length < 2) continue;

    // Cluster by line proximity (within 10 lines or both null)
    const clusters: typeof toCheck[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (processed.has(i)) continue;

      const cluster = [items[i]];
      processed.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(j)) continue;

        const line1 = items[i].comment.line;
        const line2 = items[j].comment.line;

        // Check if lines are close or both null
        const areClose = 
          (line1 !== null && line2 !== null && Math.abs(line1 - line2) <= 10) ||
          (line1 === null && line2 === null);

        if (areClose) {
          cluster.push(items[j]);
          processed.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      }
    }

    // Record clusters as candidate groups
    for (const cluster of clusters) {
      const authors = new Set(cluster.map(item => item.comment.author));
      const lines = cluster.map(item => item.comment.line).filter(l => l !== null) as number[];
      const hasNullLine = cluster.some(item => item.comment.line === null);
      
      let lineRange: string;
      if (lines.length === 0) {
        lineRange = '(both line:null -- may be unrelated)';
      } else if (lines.length === 1) {
        lineRange = hasNullLine ? `${lines[0]} + null` : `${lines[0]}`;
      } else {
        const min = Math.min(...lines);
        const max = Math.max(...lines);
        lineRange = hasNullLine ? `${min}-${max} + null` : `${min}-${max}`;
      }

      candidateGroups.push({
        file,
        lineRange,
        items: cluster,
        sameAuthor: authors.size === 1,
        authors,
      });
    }
  }

  // Log results
  if (candidateGroups.length === 0) {
    return; // No logging if no candidates found
  }

  const totalComments = candidateGroups.reduce((sum, g) => sum + g.items.length, 0);
  console.log(chalk.gray(`\nDuplicate candidates: ${formatNumber(candidateGroups.length)} group(s), ${formatNumber(totalComments)} comments total`));
  
  // Use the shared idToDisplayNum map so "#7" means the same comment here
  // and in the dedup verdict log. Numbers come from toCheck array position
  // (1-indexed), so they're stable regardless of how groups are ordered.
  for (const group of candidateGroups) {
    const authorInfo = group.sameAuthor 
      ? `same author: ${[...group.authors][0]}`
      : 'different authors';
    
    console.log(chalk.gray(`  ${group.file}:${group.lineRange} (${formatNumber(group.items.length)} comments, ${authorInfo})`));
    
    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const num = idToDisplayNum.get(item.comment.id) ?? '?';
      const author = item.comment.author || 'unknown';
      const preview = item.comment.body.substring(0, 80).replace(/\n/g, ' ');
      const suffix = item.comment.body.length > 80 ? '...' : '';
      console.log(chalk.gray(`    #${num} (${author}): "${preview}${suffix}"`));
    }
  }
  console.log(''); // Blank line after the report
}

/** Extract a primary symbol from comment body (method/function/test target) for same-requirement dedup. */
function primarySymbolFromBody(body: string): string | null {
  const cleaned = stripSeverityFraming(body);
  const backtick = cleaned.match(/`([a-zA-Z_][a-zA-Z0-9_]*)`/);
  if (backtick) return backtick[1];
  const method = cleaned.match(/(?:method|function|tests? for)\s+[`']?([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (method) return method[1];
  const has = cleaned.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s+has\s+(?:zero|no)\s+/i);
  if (has) return has[1];
  return null;
}

/** True if both bodies share a same-requirement keyword (avoids merging e.g. "add tests" with "security bug" on same symbol). */
function bodySimilarityForDedup(body1: string, body2: string, symbol: string | null): boolean {
  const b1 = stripSeverityFraming(body1).toLowerCase();
  const b2 = stripSeverityFraming(body2).toLowerCase();
  const keywords = ['test', 'tests', 'coverage', 'missing test', 'add test', 'zero test', 'no test', 'patch', 'fix', 'implement'];
  for (const kw of keywords) {
    if (b1.includes(kw) && b2.includes(kw)) return true;
  }
  if (symbol && b1.includes(symbol.toLowerCase()) && b2.includes(symbol.toLowerCase())) return true;
  return false;
}

/** Extract caller/referenced file from comment body (e.g. "runner.py:146", "in runner.py", "callers in X"). Prompts.log audit: same method + same caller = same issue across authors. */
function callerFileFromBody(body: string): string | null {
  const m = body.match(/(?:calls?|caller|in|from)\s+[`']?([a-zA-Z0-9_/.()-]+\.(?:py|ts|tsx|js|jsx))[`']?(?::\d+)?/i)
    ?? body.match(/([a-zA-Z0-9_/.()-]+\.(?:py|ts|tsx|js|jsx))(?::\d+)/);
  return m ? m[1].trim() : null;
}

/**
 * Heuristic deduplication: filter obvious duplicates before batch analysis.
 * Phase 1: Zero LLM cost, uses deterministic logic.
 *
 * Criteria for duplicates (stricter than Phase 0 candidates):
 * - Same file (exact path match)
 * - Lines within 10 of each other (both non-null), OR both null
 * - Same author OR (same primary symbol + body similarity) OR (same symbol + same caller file)
 *
 * WHY same-caller: Prompts.log audit showed dedup returning NONE for four comments on the same file; cursor and claude both described the same async/caller mismatch (generate_report + runner.py) but different authors prevented merge. Same symbol + same caller file is a strong signal for "same issue" across bots.
 *
 * @param toCheck Array of issues with snippets
 * @returns DedupResult with filtered list, duplicate map, and duplicate items
 */
export function heuristicDedup(
  toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
    resolvedPath?: string;
  }>,
  /** Shared commentId → display number mapping (same one used in candidate log). */
  idToDisplayNum: Map<string, number>,
): DedupResult {
  const duplicateMap = new Map<string, string[]>();
  const duplicateItems = new Map<string, typeof toCheck[0]>();
  const canonicalIds = new Set<string>();
  const duplicateIds = new Set<string>();

  // Group by file path
  const byFile = new Map<string, typeof toCheck>();
  for (const item of toCheck) {
    const path = item.comment.path;
    if (!byFile.has(path)) {
      byFile.set(path, []);
    }
    byFile.get(path)!.push(item);
  }

  // Find duplicate groups within each file
  for (const [, items] of byFile.entries()) {
    if (items.length < 2) continue;

    // Cluster by line proximity AND same author (stricter than Phase 0)
    const clusters: typeof toCheck[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (processed.has(i)) continue;

      const cluster = [items[i]];
      processed.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(j)) continue;

        const line1 = items[i].comment.line;
        const line2 = items[j].comment.line;
        const author1 = items[i].comment.author;
        const author2 = items[j].comment.author;
        const symbol1 = primarySymbolFromBody(items[i].comment.body);
        const symbol2 = primarySymbolFromBody(items[j].comment.body);
        const sameSymbol = symbol1 && symbol2 && symbol1 === symbol2;
        const bodySimilar = sameSymbol && bodySimilarityForDedup(items[i].comment.body, items[j].comment.body, symbol1);
        const caller1 = callerFileFromBody(items[i].comment.body);
        const caller2 = callerFileFromBody(items[j].comment.body);
        const sameCaller = caller1 && caller2 && caller1 === caller2;

        // Same author, or (same primary symbol + body similarity), or (same symbol + same caller file — prompts.log audit: async/caller mismatch from different authors)
        if (author1 !== author2 && !(sameSymbol && (bodySimilar || sameCaller))) continue;

        // Check if lines are close or both null
        const areClose =
          (line1 !== null && line2 !== null && Math.abs(line1 - line2) <= 10) ||
          (line1 === null && line2 === null);

        if (areClose) {
          cluster.push(items[j]);
          processed.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      }
    }

    // For each cluster, pick canonical and record duplicates
    for (const cluster of clusters) {
      // Pick canonical: longest body, most precise line, earliest createdAt
      const canonical = cluster.reduce((best, current) => {
        // 1. Longest comment body wins
        if (current.comment.body.length > best.comment.body.length) {
          return current;
        }
        if (current.comment.body.length < best.comment.body.length) {
          return best;
        }

        // 2. Most precise line reference wins (non-null beats null)
        if (current.comment.line !== null && best.comment.line === null) {
          return current;
        }
        if (current.comment.line === null && best.comment.line !== null) {
          return best;
        }

        // 3. Earliest createdAt wins (tiebreaker)
        if (current.comment.createdAt < best.comment.createdAt) {
          return current;
        }

        return best;
      });

      // Record canonical and duplicates
      canonicalIds.add(canonical.comment.id);
      const dupes = cluster
        .filter(item => item.comment.id !== canonical.comment.id)
        .map(item => item.comment.id);
      
      duplicateMap.set(canonical.comment.id, dupes);
      
      // Store duplicate items for context merging
      for (const item of cluster) {
        if (item.comment.id !== canonical.comment.id) {
          duplicateIds.add(item.comment.id);
          duplicateItems.set(item.comment.id, item);
        }
      }
    }
  }

  // Build dedupedToCheck: keep canonicals and non-duplicates
  const dedupedToCheck = toCheck.filter(item => !duplicateIds.has(item.comment.id));

  // Log results if any deduplication happened
  if (duplicateMap.size > 0) {
    const totalDupes = [...duplicateMap.values()].reduce((sum, dupes) => sum + dupes.length, 0);
    console.log(chalk.gray(
      `  Dedup: ${formatNumber(duplicateMap.size)} group(s) merged ` +
      `(${formatNumber(totalDupes + duplicateMap.size)} comments -> ${formatNumber(duplicateMap.size)} canonical)`
    ));
    
    // HISTORY: Previously built a local idToIndex from toCheck array order, but
    // logDuplicateCandidates used a different globalIdx. Numbers didn't match,
    // making cross-references impossible (e.g. verdict showed #47 but candidate
    // log only went to #43). Now both use the shared idToDisplayNum map.
    for (const [canonicalId, dupes] of duplicateMap.entries()) {
      const canonical = toCheck.find(item => item.comment.id === canonicalId);
      if (canonical) {
        const canonIdx = idToDisplayNum.get(canonicalId) ?? '?';
        const dupeIdxs = dupes.map(d => `#${idToDisplayNum.get(d) ?? '?'}`).join(', ');
        const lineInfo = canonical.comment.line !== null ? `:${canonical.comment.line}` : '';
        console.log(chalk.gray(
          `    #${canonIdx} [canonical] ${canonical.comment.path}${lineInfo} ← dupes: ${dupeIdxs}`
        ));
      }
    }
  }

  return {
    dedupedToCheck,
    duplicateMap,
    duplicateItems,
  };
}

/**
 * Dedup grouping rules as system prompt — user message is only file + summaries.
 * WHY: prompts.log audit showed ~2k chars of identical GROUPING RULES repeated per file;
 * ElizaCloud/OpenAI paths support system+user; reduces tokens and log noise.
 */
const LLM_DEDUP_SYSTEM_PROMPT = `You group duplicate GitHub review comments that describe the EXACT SAME underlying problem on one file.

GROUPING RULES (be conservative — wrong merges cause missed fixes):
- CRITICAL — line alignment: Each comment in the user message may show "(line N)". Every index in one GROUP must share the SAME N. Comments on different line numbers must NOT be in the same GROUP. If a comment has no "(line N)" but includes a short "Code:" excerpt, infer location from that excerpt; when in doubt, do NOT group across likely-different locations.
- Only group if SAME code location AND SAME specific problem and SAME fix.
- Comments on DIFFERENT lines, functions, or requiring DIFFERENT fixes must NOT be grouped.
- "Thematically similar" is NOT enough.
- Same symbol but DIFFERENT fix = do NOT group. Example: "Method X doesn't exist" (fix: add the method) and "Method X called with wrong cast" (fix: change the call site) are two different fixes — do not group.
- When in doubt, do NOT group.

For each group of true duplicates, pick the most detailed comment as canonical.

The user message states how many comments K there are. Valid indices are 1 through K only. Never reference an index outside that range. The canonical index MUST be one of the indices listed in its GROUP line.

Before each GROUP line: verify every index in that GROUP shares the same "(line N)" when present.

Reply ONLY with lines like (one per group, no other text):
GROUP: 1,2 → canonical 2
GROUP: 1,3 → canonical 3

If no comments are duplicates, reply: NONE`;

/**
 * Phase 2: LLM-based semantic deduplication.
 *
 * Takes candidate groups from Phase 0 that heuristic dedup (Phase 1) didn't merge
 * — typically because authors differ or lines are too far apart — and asks the LLM
 * whether they describe the same underlying issue.
 *
 * This catches the pattern where 4 reviewers flag the same corrupted file from
 * different angles (line 50, 62, 440, null) — the heuristic can't see they're all
 * "one file is structurally broken."
 *
 * Cost: One lightweight LLM call with short summaries. Typically <2k tokens.
 */
export async function llmDedup(
  dedupResult: DedupResult,
  toCheck: Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[]; resolvedPath?: string }>,
  llm: LLMClient
): Promise<DedupResult> {
  // Find items that survived heuristic dedup — only compare within same file
  const byFile = new Map<string, Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[]; resolvedPath?: string }>>();
  for (const item of dedupResult.dedupedToCheck) {
    const existing = byFile.get(item.comment.path) || [];
    existing.push(item);
    byFile.set(item.comment.path, existing);
  }

  // Files with 3+ issues always get LLM dedup. For exactly 2 items, run only when authors differ and
  // primarySymbolFromBody matches — catches Claude issue + Cursor Bugbot inline on same bug (elizaOS/cloud#417).
  const filesToCheck = [...byFile.entries()].filter(([, items]) => {
    if (items.length >= 3) return true;
    if (items.length !== 2) return false;
    const [a, b] = items;
    if (a.comment.author === b.comment.author) return false;
    const symA = primarySymbolFromBody(a.comment.body);
    const symB = primarySymbolFromBody(b.comment.body);
    return !!(symA && symB && symA === symB);
  });
  if (filesToCheck.length === 0) return dedupResult;

  debug(`LLM dedup: checking ${filesToCheck.length} file(s)`);

  const newDuplicateMap = new Map(dedupResult.duplicateMap);
  const newDuplicateItems = new Map(dedupResult.duplicateItems);
  const newDuplicateIds = new Set<string>();

  // Run dedup LLM calls in parallel (up to LLM_DEDUP_MAX_CONCURRENT) for speed.
  // WHY: One call per file; parallelizing cuts total time. ElizaCloud client still
  // serializes in-flight requests; direct providers get real parallelism.
  type DedupEntry = [string, Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[] }>];
  type DedupTaskResult = { filePath: string; groups: Array<{ canonical: DedupEntry[1][0]; dupes: DedupEntry[1] }>; error?: string };

  async function runOneDedupFile(entry: DedupEntry): Promise<DedupTaskResult> {
    const [filePath, items] = entry;
    const summaries = items.map((item, idx) => {
      const line = item.comment.line !== null ? ` (line ${item.comment.line})` : '';
      const preview = sanitizeCommentForPrompt(item.comment.body).substring(0, 400).replace(/\n/g, ' ');
      // Include a short code snippet so the model can see whether comments reference the same code.
      const hasSnippet = item.codeSnippet
        && item.codeSnippet.length > 0
        && !item.codeSnippet.startsWith('(file not found')
        && !item.codeSnippet.startsWith('(unreadable');
      const snippet = hasSnippet
        ? `\n   Code: ${item.codeSnippet.split('\n').slice(0, 4).join(' | ').substring(0, 200)}`
        : '';
      return `[${idx + 1}] ${item.comment.author}${line}: ${preview}${snippet}`;
    }).join('\n\n');
    const userPrompt = `File: ${filePath}
Comments: ${items.length} (use indices 1–${items.length} only)

${summaries}`;
    try {
      // Always use cheap model for dedup — fast and sufficient; avoids slow default (e.g. qwen-3-14b on ElizaCloud).
      const response = await llm.completeWithCheapModel(userPrompt, LLM_DEDUP_SYSTEM_PROMPT, {
        phase: 'dedup-v2-grouping',
      });
      const content = response.content.trim();
      const groups: DedupTaskResult['groups'] = [];
      const groupPattern = /GROUP:\s*([\d,\s]+)\s*→\s*canonical\s*(\d+)/gi;
      let match;
      // WHY (Cycle 16): LLM sometimes returns GROUP lines with out-of-range indices (e.g. GROUP: 2,5,7 when only 3 comments).
      // Applying a filtered subset merges the wrong comments. Reject the entire line when any index is outside [1, N] or canonical not in group.
      const n = items.length;
      while ((match = groupPattern.exec(content)) !== null) {
        const parsedIndices = match[1].split(',').map(s => parseInt(s.trim(), 10));
        const canonicalOneBased = parseInt(match[2], 10);
        if (canonicalOneBased < 1 || canonicalOneBased > n) continue;
        const uniqueOneBased = [...new Set(parsedIndices.filter((i) => Number.isFinite(i)))].sort((a, b) => a - b);
        if (uniqueOneBased.length < 2) continue;
        const allInRange = uniqueOneBased.every((i) => i >= 1 && i <= n);
        if (!allInRange) continue;
        if (!uniqueOneBased.includes(canonicalOneBased)) continue;
        // Audit (prompts.log): model returned "GROUP: 1,2,5 → canonical 2" but [1],[5] were line 2531 and [2] was line 2493 — different lines must not be merged.
        const indices = uniqueOneBased.map((i) => i - 1);
        const groupLines = indices.map((i) => items[i].comment.line);
        const sameLine = groupLines.every((l) => l === groupLines[0]);
        if (!sameLine) {
          // Re-split by line so we don't lose valid same-line merges (e.g. 1,5 same line; 2 different → keep group 1,5).
          const byLine = new Map<number | null, number[]>();
          for (let i = 0; i < indices.length; i++) {
            const line = items[indices[i]].comment.line;
            if (!byLine.has(line)) byLine.set(line, []);
            byLine.get(line)!.push(indices[i]);
          }
          let reSplitCount = 0;
          for (const [, lineIndices] of byLine) {
            if (lineIndices.length < 2) continue;
            reSplitCount++;
            // Pick canonical: longest comment body (same tiebreak as heuristic dedup).
            const canonicalIdx = lineIndices.reduce((best, i) =>
              (items[i].comment.body.length > items[best].comment.body.length ? i : best));
            const dupes = lineIndices.filter((i) => i !== canonicalIdx).map((i) => items[i]);
            groups.push({ canonical: items[canonicalIdx], dupes });
          }
          debug(`Dedup: GROUP ${uniqueOneBased.join(',')} had mixed line numbers (${groupLines.map((l) => l ?? 'file').join(', ')}); re-split → ${reSplitCount} same-line group(s)`);
          continue;
        }
        const canonicalIdx = canonicalOneBased - 1;
        const canonical = items[canonicalIdx];
        const dupes = indices.filter((i) => i !== canonicalIdx).map((i) => items[i]);
        groups.push({ canonical, dupes });
      }
      const mergedGroups = resolveOverlappingDedupGroupsByIndex(groups, items);
      // Only treat as NONE when no GROUP lines were parsed. Audit (prompts.log): model may output
      // `GROUP: …` plus a trailing `NONE` line — regex still captures groups; do not discard.
      if (mergedGroups.length === 0 && content.toUpperCase().includes('NONE')) {
        return { filePath, groups: [], error: undefined };
      }
      return { filePath, groups: mergedGroups };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`LLM dedup failed for ${filePath}: ${msg}`);
      return { filePath, groups: [], error: msg };
    }
  }

  async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let index = 0;
    async function worker(): Promise<void> {
      while (index < tasks.length) {
        const i = index++;
        results[i] = await tasks[i]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
  }

  const dedupTasks = filesToCheck.map(entry => () => runOneDedupFile(entry));
  const dedupResults = await runWithConcurrency(dedupTasks, LLM_DEDUP_MAX_CONCURRENT);

  const dedupFailures = dedupResults.filter((r): r is DedupTaskResult & { error: string } => !!r.error);
  if (dedupFailures.length > 0) {
    warn(`LLM dedup failed for ${dedupFailures.length}/${filesToCheck.length} file(s) — proceeding with heuristic-only dedup`);
    for (const { filePath, error } of dedupFailures) {
      warn(`  ${filePath}: ${error}`);
    }
  }

  // Merge all results into the dedup map
  for (const { filePath, groups } of dedupResults) {
    for (const { canonical, dupes } of groups) {
      const existingDupes = newDuplicateMap.get(canonical.comment.id) || [];
      for (const dupe of dupes) {
        if (!existingDupes.includes(dupe.comment.id) && !newDuplicateIds.has(dupe.comment.id)) {
          existingDupes.push(dupe.comment.id);
          newDuplicateIds.add(dupe.comment.id);
          newDuplicateItems.set(dupe.comment.id, dupe);
        }
      }
      newDuplicateMap.set(canonical.comment.id, existingDupes);

      debug(`LLM dedup: merged ${dupes.length} duplicate(s) for ${filePath}:${canonical.comment.line ?? '?'}`);
    }
  }

  if (newDuplicateIds.size === 0) return dedupResult;

  // Rebuild dedupedToCheck excluding newly identified duplicates
  const updatedDeduped = dedupResult.dedupedToCheck.filter(
    item => !newDuplicateIds.has(item.comment.id)
  );

  const totalNewDupes = newDuplicateIds.size;
  console.log(chalk.gray(
    `  LLM dedup: merged ${totalNewDupes} additional duplicate(s) across ${filesToCheck.length} file(s)`
  ));

  return {
    dedupedToCheck: updatedDeduped,
    duplicateMap: newDuplicateMap,
    duplicateItems: newDuplicateItems,
  };
}

const LLM_CROSS_FILE_DEDUP_SYSTEM_PROMPT = `You group GitHub review issues that appear on DIFFERENT files but describe the EXACT SAME root cause and would be fixed by the SAME code pattern (e.g. same API misused in multiple call sites).

RULES (be very conservative — wrong merges cause missed fixes):
- Each GROUP must contain indices whose files (shown as "file: ...") are ALL DIFFERENT from each other.
- Group ONLY if one fix naturally fixes every item (same mistake, same remedy).
- Do NOT group by broad theme ("type safety", "rate limiting", "tests").
- Do NOT group items on the same file — those were already deduplicated per file.
- When in doubt, do NOT group.

The user message states how many issues K there are. Valid indices are 1 through K only.

Reply ONLY with lines like (one per group, no other text):
GROUP: 1,3,7 → canonical 3

If nothing qualifies, reply: NONE`;

type DedupCheckItem = {
  comment: ReviewComment;
  codeSnippet: string;
  contextHints?: string[];
  resolvedPath?: string;
};

/**
 * Phase 3: Cross-file root-cause dedup (one LLM call). Merges issues on different paths when the model
 * agrees they share one fix pattern. WHY: Same CoT/temperature mistake across multiple services (PR #417).
 */
export async function crossFileDedup(dedupResult: DedupResult, llm: LLMClient): Promise<DedupResult> {
  const items = dedupResult.dedupedToCheck as DedupCheckItem[];
  if (items.length < 5) return dedupResult;

  const summaries = items.map((item, idx) => {
    const path = item.resolvedPath ?? item.comment.path;
    const preview = stripSeverityFraming(sanitizeCommentForPrompt(item.comment.body))
      .substring(0, 200)
      .replace(/\n/g, ' ');
    const line = item.comment.line !== null ? String(item.comment.line) : 'null';
    return `[${idx + 1}] file: ${path} (line ${line})\n   ${preview}`;
  }).join('\n\n');

  const k = items.length;
  // WHY raw `k` in the prompt (not formatNumber): indices must be plain digits 1..k for the model; comma thousands
  // would break GROUP line parsing for large N (same convention as per-file llmDedup).
  const userPrompt = `Total issues: ${k}. Use indices 1 through ${k} only.\n\n${summaries}`;

  try {
    const response = await llm.completeWithCheapModel(userPrompt, LLM_CROSS_FILE_DEDUP_SYSTEM_PROMPT, {
      phase: 'dedup-v2-cross-file',
    });
    const content = response.content.trim();
    const groupPattern = /GROUP:\s*([\d,\s]+)\s*→\s*canonical\s*(\d+)/gi;
    let match;
    const newDuplicateMap = new Map(dedupResult.duplicateMap);
    const newDuplicateItems = new Map(dedupResult.duplicateItems);
    const newDuplicateIds = new Set<string>();

    type CrossRow = { canonicalIdx: number; memberIndices: number[] };
    const crossPending: CrossRow[] = [];
    while ((match = groupPattern.exec(content)) !== null) {
      const parsedIndices = match[1].split(',').map(s => parseInt(s.trim(), 10));
      const canonicalOneBased = parseInt(match[2], 10);
      if (canonicalOneBased < 1 || canonicalOneBased > k) continue;
      const uniqueOneBased = [...new Set(parsedIndices.filter(i => Number.isFinite(i)))].sort((a, b) => a - b);
      if (uniqueOneBased.length < 2) continue;
      if (!uniqueOneBased.every(i => i >= 1 && i <= k)) continue;
      if (!uniqueOneBased.includes(canonicalOneBased)) continue;

      const indices = uniqueOneBased.map(i => i - 1);
      const paths = indices.map(i => items[i]!.resolvedPath ?? items[i]!.comment.path);
      const uniquePaths = new Set(paths);
      if (uniquePaths.size !== indices.length) continue;

      crossPending.push({ canonicalIdx: canonicalOneBased - 1, memberIndices: indices });
    }

    const usedCross = new Set<number>();
    for (const row of crossPending) {
      const available = row.memberIndices.filter((i) => !usedCross.has(i));
      if (available.length < 2) {
        if (row.memberIndices.some((i) => usedCross.has(i))) {
          debug('Cross-file dedup: dropped overlapping GROUP — index(s) already merged earlier', {
            memberIndices: row.memberIndices.map((i) => i + 1),
          });
        }
        continue;
      }
      const pathsAvail = available.map((i) => items[i]!.resolvedPath ?? items[i]!.comment.path);
      if (new Set(pathsAvail).size !== available.length) continue;

      const canonicalIdx = available.includes(row.canonicalIdx)
        ? row.canonicalIdx
        : available.reduce((best, i) =>
            items[i]!.comment.body.length > items[best]!.comment.body.length ? i : best,
            available[0]!,
          );
      const dupes = available.filter((i) => i !== canonicalIdx).map((i) => items[i]!);
      const canonical = items[canonicalIdx]!;

      for (const i of available) {
        usedCross.add(i);
      }

      const otherPaths = [...new Set(dupes.map((d) => d.resolvedPath ?? d.comment.path))];
      const hint = `Cross-file dedup: same root cause also reported on ${otherPaths.map((p) => `\`${p}\``).join(', ')} — fix consistently across files.`;
      canonical.contextHints = [...(canonical.contextHints ?? []), hint];

      const existingDupes = newDuplicateMap.get(canonical.comment.id) || [];
      for (const dupe of dupes) {
        if (!existingDupes.includes(dupe.comment.id) && !newDuplicateIds.has(dupe.comment.id)) {
          existingDupes.push(dupe.comment.id);
          newDuplicateIds.add(dupe.comment.id);
          newDuplicateItems.set(dupe.comment.id, dupe);
        }
      }
      newDuplicateMap.set(canonical.comment.id, existingDupes);
      debug(`Cross-file dedup: merged ${formatNumber(dupes.length)} into ${canonical.comment.path}`);
    }

    if (newDuplicateIds.size === 0) return dedupResult;

    const updatedDeduped = dedupResult.dedupedToCheck.filter(item => !newDuplicateIds.has(item.comment.id));
    console.log(chalk.gray(
      `  Cross-file dedup: merged ${formatNumber(newDuplicateIds.size)} issue(s) into shared root-cause group(s)`,
    ));

    return {
      dedupedToCheck: updatedDeduped,
      duplicateMap: newDuplicateMap,
      duplicateItems: newDuplicateItems,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Cross-file dedup failed, proceeding without it: ${msg}`);
    return dedupResult;
  }
}
