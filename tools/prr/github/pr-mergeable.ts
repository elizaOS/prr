/**
 * GitHub REST `pulls.get` merge fields — shared checks for setup, push iterations, and base merge.
 */

import type { PRInfo } from './types.js';

/** `mergeable: false` or `mergeableState: dirty` (case-insensitive). */
export function githubPrSaysNotMergeable(pr: PRInfo): boolean {
  return pr.mergeable === false || pr.mergeableState?.toLowerCase() === 'dirty';
}

/** GitHub has not finished computing mergeability (`mergeable: null`). */
export function githubPrMergeableUnknown(pr: PRInfo): boolean {
  return pr.mergeable === null;
}

/**
 * Apply fields from a fresh `getPRInfo` onto the in-memory PR object used for the run.
 * WHY: `mergeable` / `mergeable_state` and `head.sha` change while PRR runs (pushes, GitHub recalculation).
 */
export function applyFreshPrInfoFromRest(target: PRInfo, fresh: PRInfo): void {
  target.mergeable = fresh.mergeable;
  target.mergeableState = fresh.mergeableState;
  target.headSha = fresh.headSha;
  target.title = fresh.title;
  target.body = fresh.body;
}
