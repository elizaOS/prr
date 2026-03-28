/**
 * Collapse duplicate synthetic issue rows from the same author + file before solvability/snippet work.
 * WHY: Same bot re-posting reviews (e.g. Claude ×25) explodes `ic-*` rows; heuristic dedup runs too late (after I/O).
 */

import { debug } from '../../../shared/logger.js';
import type { ReviewComment } from './types.js';
import { wordSetJaccard } from '../workflow/helpers/review-body-normalize.js';

const LINE_PROXIMITY = 5;
const JACCARD_DUPLICATE_THRESHOLD = 0.5;

function findParent(parent: number[], i: number): number {
  if (parent[i] !== i) parent[i] = findParent(parent, parent[i]);
  return parent[i];
}

function unionParent(parent: number[], a: number, b: number): void {
  const ra = findParent(parent, a);
  const rb = findParent(parent, b);
  if (ra !== rb) parent[ra] = rb;
}

/** Group items whose line anchors are both null or within LINE_PROXIMITY. */
function clusterByLineProximity(items: ReviewComment[]): ReviewComment[][] {
  const n = items.length;
  if (n <= 1) return n === 1 ? [[items[0]!]] : [];
  const parent = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const l1 = items[i]!.line;
      const l2 = items[j]!.line;
      const close =
        (l1 === null && l2 === null) ||
        (l1 !== null && l2 !== null && Math.abs(l1 - l2) <= LINE_PROXIMITY);
      if (close) unionParent(parent, i, j);
    }
  }
  const byRoot = new Map<number, ReviewComment[]>();
  for (let i = 0; i < n; i++) {
    const r = findParent(parent, i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(items[i]!);
  }
  return [...byRoot.values()];
}

/** Within a line cluster, merge rows with high word-set overlap; keep longest body per merge group. */
function dedupeLineCluster(cluster: ReviewComment[]): ReviewComment[] {
  if (cluster.length <= 1) return cluster;
  const n = cluster.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (wordSetJaccard(cluster[i]!.body, cluster[j]!.body) >= JACCARD_DUPLICATE_THRESHOLD) {
        unionParent(parent, i, j);
      }
    }
  }
  const byRoot = new Map<number, ReviewComment[]>();
  for (let i = 0; i < n; i++) {
    const r = findParent(parent, i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(cluster[i]!);
  }
  const kept: ReviewComment[] = [];
  for (const group of byRoot.values()) {
    const canonical = group.reduce((best, cur) =>
      cur.body.length > best.body.length ? cur : best,
    );
    kept.push(canonical);
  }
  return kept;
}

/**
 * Drop duplicate synthetic rows from the same author on the same path (line-proximate + similar body).
 * Only safe for `ic-*` issue-derived comments; inline thread IDs are not passed through here.
 */
export function deduplicateSameBotAcrossComments(results: ReviewComment[]): ReviewComment[] {
  if (results.length < 2) return results;

  const byKey = new Map<string, ReviewComment[]>();
  for (const r of results) {
    const key = `${r.author}\0${r.path}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  const kept: ReviewComment[] = [];
  let dropped = 0;

  for (const [, bucket] of byKey) {
    if (bucket.length < 2) {
      kept.push(...bucket);
      continue;
    }
    const lineClusters = clusterByLineProximity(bucket);
    for (const lc of lineClusters) {
      const survivors = dedupeLineCluster(lc);
      dropped += lc.length - survivors.length;
      kept.push(...survivors);
    }
  }

  if (dropped > 0) {
    debug(`Cross-comment dedup: dropped ${dropped} duplicate(s) from same author/path buckets`);
  }

  return kept;
}
