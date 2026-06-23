/**
 * LLM dedup cluster helpers for verified state (mark, unmark on stale re-check).
 * WHY: `duplicateMap` keys are canonical ids; queued rows may be a dupe — touching only one id
 * leaves siblings wrong for queue accounting / “skip fixer” / dismissed state.
 */
import type { StateContext } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import { debug } from '../../../shared/logger.js';
import { getDuplicateClusterCommentIds } from './utils.js';

/**
 * After {@link recoverVerificationState} marks only comment ids found in `prr-fix:` commits, expand to the
 * full LLM dedup cluster when **`state.dedupCache`** matches the current PR comment set (`dedup-v2` + same id key).
 * WHY: A fix commit often references one thread id; duplicate threads would stay unverified and re-enter analysis.
 *
 * @returns **`staleSkipIds`** — use like former `recoveredFromGitCommentIds` for stale/unmark guards (full cluster).
 * **`addedVerified`** — true if any new `markVerified` ran (caller may persist state).
 */
export function expandGitRecoveredVerificationFromDedupCache(
  stateContext: StateContext,
  recoveredFromGit: readonly string[],
  allCommentIdsKey: string,
): { staleSkipIds: string[]; addedVerified: boolean } {
  const staleSkipIds = new Set<string>(recoveredFromGit);
  let addedVerified = false;

  const persisted = stateContext.state?.dedupCache;
  if (
    !persisted ||
    persisted.commentIds !== allCommentIdsKey ||
    persisted.schema !== 'dedup-v2' ||
    !persisted.duplicateMap ||
    typeof persisted.duplicateMap !== 'object'
  ) {
    return { staleSkipIds: [...staleSkipIds], addedVerified: false };
  }

  const duplicateMap = new Map<string, string[]>(Object.entries(persisted.duplicateMap));
  const gitSet = new Set(recoveredFromGit);
  const processedCluster = new Set<string>();

  for (const r of recoveredFromGit) {
    const cluster = getDuplicateClusterCommentIds(r, duplicateMap);
    for (const cid of cluster) {
      staleSkipIds.add(cid);
    }
    const sig = [...cluster].sort().join('\0');
    if (processedCluster.has(sig)) continue;
    processedCluster.add(sig);

    const canonical = cluster[0]!;
    const gitAnchor = gitSet.has(canonical)
      ? canonical
      : cluster.find((id) => gitSet.has(id)) ?? canonical;

    for (const cid of cluster) {
      if (Verification.isVerified(stateContext, cid)) continue;
      if (cid === gitAnchor) {
        Verification.markVerified(stateContext, cid, Verification.PRR_GIT_RECOVERY_VERIFIED_MARKER, {
          skipSessionTracking: true,
        });
      } else {
        Verification.markVerified(stateContext, cid, gitAnchor, { skipSessionTracking: true });
      }
      addedVerified = true;
    }
  }

  return { staleSkipIds: [...staleSkipIds], addedVerified };
}

/**
 * @returns Count of cluster members verified in addition to the anchor (for "N duplicate(s) auto-resolved").
 */
export function markVerifiedClusterForFixedIssue(
  stateContext: StateContext,
  anchorId: string,
  duplicateMap: Map<string, string[]> | undefined,
  verifiedThisSession?: Set<string> | undefined,
): number {
  const clusterIds = getDuplicateClusterCommentIds(anchorId, duplicateMap);
  let autoExtra = 0;
  for (const cid of clusterIds) {
    if (Verification.isVerified(stateContext, cid)) continue;
    Verification.markVerified(stateContext, cid, cid === anchorId ? undefined : anchorId);
    verifiedThisSession?.add(cid);
    if (cid !== anchorId) autoExtra++;
  }
  return autoExtra;
}

/**
 * When analysis re-check says the issue still exists, unmark every verified id in the dedup cluster.
 * WHY: Batch/sequential paths only unmarked the analyzed row — dupes stayed verified → "already verified — skip fixer".
 * Skips ids in **`recoveredSet`** (git recovery this run) per id.
 */
export function unmarkVerifiedClusterForStaleRecheck(
  stateContext: StateContext,
  anchorId: string,
  duplicateMap: Map<string, string[]> | undefined,
  recoveredSet?: Set<string>,
): void {
  for (const cid of getDuplicateClusterCommentIds(anchorId, duplicateMap)) {
    if (!Verification.isVerified(stateContext, cid)) continue;
    if (recoveredSet?.has(cid)) {
      debug('Skipping unmark (recovered from git this run)', { commentId: cid });
      continue;
    }
    Verification.unmarkVerified(stateContext, cid);
    debug('Unmarked verified (stale re-check said still exists)', { commentId: cid });
  }
}

/**
 * After final audit reports UNFIXED (or missing result), unmark every id in each failed comment’s dedup cluster.
 * **WHY:** {@link markVerifiedClusterForFixedIssue} marks the full cluster when audit passes; per-id
 * **`unmarkVerified`** left siblings verified → "already verified — skip fixer" while another thread
 * re-entered the queue (same logical issue).
 */
export function unmarkVerifiedClustersForFinalAuditFailures(
  stateContext: StateContext,
  failedCommentIds: readonly string[],
  duplicateMap: Map<string, string[]> | undefined,
): void {
  const seen = new Set<string>();
  for (const id of failedCommentIds) {
    for (const cid of getDuplicateClusterCommentIds(id, duplicateMap)) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      Verification.unmarkVerified(stateContext, cid);
      debug('Unmarked verified (final audit failure — cluster)', { commentId: cid });
    }
  }
}
