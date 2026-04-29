/**
 * Core state management - load/save/lifecycle
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { DismissedIssue, ResolverState } from './types.js';
import { createInitialState } from './types.js';
import { loadOverallTimings, getOverallTimings, loadOverallTokenUsage, getOverallTokenUsage, formatNumber } from '../../../shared/logger.js';
import { getEffectiveElizacloudSkipModelIds } from '../../../shared/constants.js';
import { isReviewPathFragment } from '../../../shared/path-utils.js';
import {
  type StateContext,
  hydrateRotationSessionFromPersistedState,
  persistRotationSessionToState,
} from './state-context.js';

/** Prefer canonical path categories when timestamps tie (pill-output #539). */
function dismissalCategoryRank(c: DismissedIssue['category']): number {
  if (c === 'path-fragment') return 0;
  if (c === 'path-unresolved') return 1;
  if (c === 'missing-file') return 2;
  return 3;
}

/**
 * Collapse duplicate rows for the same comment id (hand-edited or legacy state).
 * Keeps the row with the latest dismissedAt; on tie, prefers path-fragment > path-unresolved > missing-file.
 * Preserves first-seen order of unique ids.
 */
export function dedupeDismissedIssuesByCommentId(issues: DismissedIssue[]): {
  merged: DismissedIssue[];
  removedCount: number;
} {
  if (issues.length <= 1) {
    return { merged: issues, removedCount: 0 };
  }
  const firstIndex = new Map<string, number>();
  const best = new Map<string, DismissedIssue>();
  for (let i = 0; i < issues.length; i++) {
    const d = issues[i]!;
    if (!firstIndex.has(d.commentId)) firstIndex.set(d.commentId, i);
    const prev = best.get(d.commentId);
    if (!prev) {
      best.set(d.commentId, d);
      continue;
    }
    const at = (d.dismissedAt ?? '') > (prev.dismissedAt ?? '');
    const bt = (prev.dismissedAt ?? '') > (d.dismissedAt ?? '');
    let pick: DismissedIssue;
    if (at && !bt) pick = d;
    else if (bt && !at) pick = prev;
    else {
      const ra = dismissalCategoryRank(d.category);
      const rb = dismissalCategoryRank(prev.category);
      pick = ra < rb ? d : ra > rb ? prev : d;
    }
    best.set(d.commentId, pick);
  }
  const orderedIds = [...firstIndex.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const merged = orderedIds.map((id) => best.get(id)!);
  return { merged, removedCount: issues.length - merged.length };
}

/**
 * Fragment category migration + duplicate row collapse for persisted dismissals.
 * Mutates row objects in place for fragment fields; returns a new array from dedupe.
 * **WHY:** Shared by {@link loadState} and legacy {@link StateManager.load} (pill-output).
 */
export function applyDismissedIssuesLoadNormalization(issues: DismissedIssue[]): {
  list: DismissedIssue[];
  fragmentNormalized: number;
  dedupeRemoved: number;
} {
  let fragmentNormalized = 0;
  for (const d of issues) {
    if (!isReviewPathFragment(d.filePath)) continue;
    if (d.category === 'missing-file' || d.category === 'path-unresolved') {
      d.category = 'path-fragment';
      if (d.reason?.includes('Tracked file not found')) {
        d.reason = `Review path "${d.filePath}" is a fragment or incomplete path — cannot resolve to a single tracked file`;
      }
      fragmentNormalized++;
    }
  }
  const { merged, removedCount } = dedupeDismissedIssuesByCommentId(issues);
  return { list: merged, fragmentNormalized, dedupeRemoved: removedCount };
}

/**
 * Verified-array dedupe, no-progress reset, and timing hydration — shared by {@link loadState}
 * and {@link StateManager.load} (pill-output StateManager parity).
 */
export function applyResolverStateLoadCoreNormalization(state: ResolverState): { mutated: boolean } {
  let mutated = false;
  if (state.verifiedFixed && state.verifiedFixed.length > 0) {
    const before = state.verifiedFixed.length;
    state.verifiedFixed = [...new Set(state.verifiedFixed)];
    const dupsRemoved = before - state.verifiedFixed.length;
    if (dupsRemoved > 0) {
      mutated = true;
      console.log(
        `Deduplicated verifiedFixed: removed ${formatNumber(dupsRemoved)} duplicate(s) (${formatNumber(state.verifiedFixed.length)} unique)`,
      );
    }
  }

  if (state.verifiedComments && state.verifiedComments.length > 0) {
    const seen = new Map<string, (typeof state.verifiedComments)[number]>();
    for (const vc of state.verifiedComments) {
      const existing = seen.get(vc.commentId);
      if (!existing || (vc.verifiedAt && (!existing.verifiedAt || vc.verifiedAt > existing.verifiedAt))) {
        seen.set(vc.commentId, vc);
      }
    }
    const beforeNew = state.verifiedComments.length;
    state.verifiedComments = [...seen.values()];
    const dupsRemovedNew = beforeNew - state.verifiedComments.length;
    if (dupsRemovedNew > 0) {
      mutated = true;
      console.log(`Deduplicated verifiedComments: removed ${formatNumber(dupsRemovedNew)} duplicate(s)`);
    }
  }

  if (state.noProgressCycles) {
    mutated = true;
    state.noProgressCycles = 0;
  }

  if (state.totalTimings) {
    loadOverallTimings(state.totalTimings);
  }
  if (state.totalTokenUsage) {
    loadOverallTokenUsage(state.totalTokenUsage);
  }
  return { mutated };
}

/**
 * Ephemeral git-recovery markers and stale skip-list stats — after dismissed/verified overlap cleanup.
 */
export function applyResolverStatePostOverlapCleanup(state: ResolverState): { mutated: boolean } {
  let mutated = false;
  if (state.recoveredFromGitCommentIds !== undefined) {
    mutated = true;
    state.recoveredFromGitCommentIds = undefined;
  }

  if (state.modelPerformance) {
    const skipIds = getEffectiveElizacloudSkipModelIds();
    if (skipIds.length > 0) {
      const skipSet = new Set(skipIds);
      let removed = 0;
      for (const key of Object.keys(state.modelPerformance)) {
        const modelId = key.includes('/') ? key.split('/').slice(1).join('/') : key;
        if (skipSet.has(modelId)) {
          delete state.modelPerformance[key];
          removed++;
        }
      }
      if (removed > 0) {
        mutated = true;
        console.log(`Cleared ${formatNumber(removed)} model performance entries for skipped models`);
      }
    }
  }
  return { mutated };
}

/** Comment ids present in both verified stores and dismissed (mutual-exclusivity violation on disk). */
export function getVerifiedDismissedOverlapIds(state: ResolverState): string[] {
  const dismissedIdSet = new Set((state.dismissedIssues ?? []).map((d) => d.commentId));
  const verifiedIdSet = new Set([
    ...(state.verifiedFixed ?? []),
    ...(state.verifiedComments?.map((v) => v.commentId) ?? []),
  ]);
  return [...verifiedIdSet].filter((id) => dismissedIdSet.has(id));
}

/** When set, {@link loadState} / {@link StateManager.load} throw instead of auto-repairing overlap (pill-output). */
export function isStrictStateOverlapEnabled(): boolean {
  const v = process.env.PRR_STRICT_STATE_OVERLAP?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * After load-time repair (overlap, dedupe, HEAD sync, etc.), flush state to disk so a crash does not
 * leave corrupt JSON to be repaired every run. **Default on** — set **`PRR_PERSIST_STATE_AFTER_LOAD_REPAIR=0`**
 * to skip (e.g. read-only inspection).
 */
export function isPersistStateAfterLoadRepairEnabled(): boolean {
  const v = process.env.PRR_PERSIST_STATE_AFTER_LOAD_REPAIR?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/**
 * If `PRR_STRICT_STATE_OVERLAP` is enabled and verified∩dismissed is non-empty, throw before cleanup mutates.
 * WHY: Optional fail-closed for hand-edited or corrupted `.pr-resolver-state.json` (default remains auto-repair).
 */
export function assertNoVerifiedDismissedOverlapOrThrow(state: ResolverState): void {
  if (!isStrictStateOverlapEnabled()) return;
  const overlap = getVerifiedDismissedOverlapIds(state);
  if (overlap.length === 0) return;
  const show = overlap.slice(0, 15).join(', ');
  const more = overlap.length > 15 ? ` …(+${formatNumber(overlap.length - 15)} more)` : '';
  throw new Error(
    `PRR_STRICT_STATE_OVERLAP: state contains ${formatNumber(overlap.length)} comment id(s) in both verified and dismissed (${show}${more}). Edit .pr-resolver-state.json in the clone workdir, run prr --clean-state, or remove the overlap, then unset PRR_STRICT_STATE_OVERLAP.`,
  );
}

export async function loadState(ctx: StateContext, pr: string, branch: string, headSha: string): Promise<ResolverState> {
  let needsPersistRepair = false;
  if (existsSync(ctx.statePath)) {
    try {
      const content = await readFile(ctx.statePath, 'utf-8');
      ctx.state = JSON.parse(content) as ResolverState;
      
      if (ctx.state.pr !== pr) {
        console.warn(`State file is for different PR (${ctx.state.pr}), creating new state`);
        ctx.state = createInitialState(pr, branch, headSha);
      } else {
        if (ctx.state.headSha !== headSha) {
          needsPersistRepair = true;
          const prevSha = ctx.state.headSha?.slice(0, 7);
          ctx.state.headSha = headSha;
          delete ctx.state.sessionSkippedModelKeys;
          delete ctx.state.sessionModelStats;
          delete ctx.state.sessionSkippedSinceFixIteration;
          const hadVerified =
            (ctx.state.verifiedFixed?.length ?? 0) + (ctx.state.verifiedComments?.length ?? 0) > 0;
          const hadPartial =
            Object.keys(ctx.state.partialConflictResolutions ?? {}).length > 0;
          if (hadVerified) {
            ctx.state.verifiedFixed = [];
            ctx.state.verifiedComments = [];
            console.warn(
              `PR head changed (${prevSha} → ${headSha.slice(0, 7)}): cleared verified state so fixes are re-checked against current code`,
            );
          }
          if (hadPartial) {
            ctx.state.partialConflictResolutions = {};
            ctx.state.partialConflictSavedOriginBaseSha = undefined;
            console.warn(
              `PR head changed: cleared partial conflict resolutions so they are re-applied against current merge`,
            );
          }
          // Pill / audit: dismissals tied to code/HEAD — clear already-fixed by default; optional clear-all (trade-off: other dismissals often still valid).
          const hadDismissed = (ctx.state.dismissedIssues?.length ?? 0) > 0;
          if (hadDismissed) {
            const clearAllRaw = process.env.PRR_CLEAR_ALL_DISMISSED_ON_HEAD?.trim().toLowerCase();
            const clearAll =
              clearAllRaw === '1' || clearAllRaw === 'true' || clearAllRaw === 'yes' || clearAllRaw === 'on';
            if (clearAll) {
              const n = ctx.state.dismissedIssues!.length;
              ctx.state.dismissedIssues = [];
              console.warn(
                `PR head changed (${prevSha} → ${headSha.slice(0, 7)}): cleared ${formatNumber(n)} dismissal(s) — PRR_CLEAR_ALL_DISMISSED_ON_HEAD`,
              );
            } else {
              const before = ctx.state.dismissedIssues!.length;
              ctx.state.dismissedIssues = ctx.state.dismissedIssues!.filter((d) => d.category !== 'already-fixed');
              const cleared = before - ctx.state.dismissedIssues.length;
              if (cleared > 0) {
                console.warn(
                  `PR head changed: cleared ${formatNumber(cleared)} already-fixed dismissal(s) so they are re-checked against current code`,
                );
              }
            }
          }
        }

        if (ctx.state.interrupted) {
          console.log(`Resuming from interrupted run (phase: ${ctx.state.interruptPhase || 'unknown'})`);
        }
        
        const { compactLessons } = await import('./state-lessons.js');
        const removed = await compactLessons(ctx);
        if (removed > 0) {
          needsPersistRepair = true;
          console.log(
            `Compacted ${formatNumber(removed)} duplicate lessons (${formatNumber(ctx.state.lessonsLearned.length)} unique remaining)`,
          );
        }
        
        const coreNorm = applyResolverStateLoadCoreNormalization(ctx.state);
        if (coreNorm.mutated) needsPersistRepair = true;

        if (!ctx.state.dismissedIssues) {
          ctx.state.dismissedIssues = [];
        }

        const {
          list: normalizedDismissed,
          fragmentNormalized,
          dedupeRemoved: dismissedDupes,
        } = applyDismissedIssuesLoadNormalization(ctx.state.dismissedIssues);
        ctx.state.dismissedIssues = normalizedDismissed;
        if (fragmentNormalized > 0) {
          needsPersistRepair = true;
          console.log(`Normalized ${formatNumber(fragmentNormalized)} legacy fragment dismissal(s) to path-fragment`);
        }
        if (dismissedDupes > 0) {
          needsPersistRepair = true;
          console.log(
            `Deduplicated dismissedIssues: removed ${formatNumber(dismissedDupes)} duplicate row(s) for the same comment id (kept latest dismissedAt / canonical path category)`,
          );
        }

        assertNoVerifiedDismissedOverlapOrThrow(ctx.state);

        // Keep verifiedFixed and dismissedIssues mutually exclusive (output.log audit: overlapVerifiedAndDismissed; pill #3).
        // (1) Remove from dismissed when it's in verified. (2) Remove from verified when it's in dismissed.
        const verifiedSet = new Set([
          ...(ctx.state.verifiedFixed ?? []),
          ...(ctx.state.verifiedComments?.map((v) => v.commentId) ?? []),
        ]);
        const dismissedIds = new Set(ctx.state.dismissedIssues.map((d) => d.commentId));
        if (verifiedSet.size > 0 && ctx.state.dismissedIssues.length > 0) {
          const overlapDismissed = ctx.state.dismissedIssues.filter((d) => verifiedSet.has(d.commentId));
          const beforeD = ctx.state.dismissedIssues.length;
          ctx.state.dismissedIssues = ctx.state.dismissedIssues.filter((d) => !verifiedSet.has(d.commentId));
          const removedD = beforeD - ctx.state.dismissedIssues.length;
          if (removedD > 0) {
            needsPersistRepair = true;
            const ids = overlapDismissed.map((d) => d.commentId);
            const show = ids.slice(0, 15).join(', ');
            const more = ids.length > 15 ? ` …(+${formatNumber(ids.length - 15)} more)` : '';
            console.log(
              `Cleaned ${formatNumber(removedD)} overlap (removed from dismissed; already in verified) — comment id(s): ${show}${more}`,
            );
          }
        }
        if (dismissedIds.size > 0 && ctx.state.verifiedFixed?.length) {
          const removedIds = ctx.state.verifiedFixed.filter((id) => dismissedIds.has(id));
          const beforeV = ctx.state.verifiedFixed.length;
          ctx.state.verifiedFixed = ctx.state.verifiedFixed.filter((id) => !dismissedIds.has(id));
          const removedV = beforeV - ctx.state.verifiedFixed.length;
          if (removedV > 0) {
            needsPersistRepair = true;
            const show = removedIds.slice(0, 15).join(', ');
            const more = removedIds.length > 15 ? ` …(+${formatNumber(removedIds.length - 15)} more)` : '';
            console.warn(
              `State load: removed ${formatNumber(removedV)} ID(s) from verifiedFixed (already in dismissed — overlap cleaned): ${show}${more}`,
            );
          }
        }
        if (dismissedIds.size > 0 && ctx.state.verifiedComments?.length) {
          const removedVcRows = ctx.state.verifiedComments.filter((v) => dismissedIds.has(v.commentId));
          const beforeVc = ctx.state.verifiedComments.length;
          ctx.state.verifiedComments = ctx.state.verifiedComments.filter((v) => !dismissedIds.has(v.commentId));
          const removedVc = beforeVc - ctx.state.verifiedComments.length;
          if (removedVc > 0) {
            needsPersistRepair = true;
            const ids = removedVcRows.map((v) => v.commentId);
            const show = ids.slice(0, 15).join(', ');
            const more = ids.length > 15 ? ` …(+${formatNumber(ids.length - 15)} more)` : '';
            console.warn(
              `State load: removed ${formatNumber(removedVc)} verifiedComments record(s) (already in dismissed — overlap cleaned): ${show}${more}`,
            );
          }
        }

        const postOverlap = applyResolverStatePostOverlapCleanup(ctx.state);
        if (postOverlap.mutated) needsPersistRepair = true;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('PRR_STRICT_STATE_OVERLAP:')) {
        throw error;
      }
      console.warn('Failed to load state file, creating new state:', error);
      ctx.state = createInitialState(pr, branch, headSha);
      needsPersistRepair = false;
    }
  } else {
    ctx.state = createInitialState(pr, branch, headSha);
  }

  if (ctx.state) {
    hydrateRotationSessionFromPersistedState(ctx);
    if (needsPersistRepair && isPersistStateAfterLoadRepairEnabled()) {
      await saveState(ctx);
      console.log('Persisted resolver state after load-time repair (PRR_PERSIST_STATE_AFTER_LOAD_REPAIR)');
    }
  }

  return ctx.state;
}

/**
 * Drop verification for comment IDs that are not in the current PR's review set.
 * WHY: Recovery and prior sessions can leave stale IDs in verifiedFixed; pill-output audits asked to prune against currentCommentIds.
 */
export function pruneVerifiedToCurrentCommentIds(
  state: ResolverState,
  currentIds: Set<string>,
): { removedVerified: number; removedVerifiedComments: number } {
  let removedVerified = 0;
  let removedVerifiedComments = 0;
  if (state.verifiedFixed?.length) {
    const before = state.verifiedFixed.length;
    state.verifiedFixed = state.verifiedFixed.filter((id) => currentIds.has(id));
    removedVerified = before - state.verifiedFixed.length;
  }
  if (state.verifiedComments?.length) {
    const before = state.verifiedComments.length;
    state.verifiedComments = state.verifiedComments.filter((vc) => currentIds.has(vc.commentId));
    removedVerifiedComments = before - state.verifiedComments.length;
  }
  return { removedVerified, removedVerifiedComments };
}

export interface SaveStateOptions {
  /**
   * Skip merging in-memory rotation session into JSON (**`StateManager`** load-repair flush has no
   * stable **`rotationSession`** on context — would otherwise delete **`sessionSkippedModelKeys`**).
   */
  skipRotationPersist?: boolean;
}

export async function saveState(ctx: StateContext, options?: SaveStateOptions): Promise<void> {
  if (!ctx.state) {
    throw new Error('No state to save. Call load() first.');
  }

  ctx.state.lastUpdated = new Date().toISOString();
  ctx.state.totalTimings = getOverallTimings();
  ctx.state.totalTokenUsage = getOverallTokenUsage();

  // Dedupe verifiedFixed before persist so raw count stays meaningful (pill #3).
  if (ctx.state.verifiedFixed && ctx.state.verifiedFixed.length > 0) {
    ctx.state.verifiedFixed = [...new Set(ctx.state.verifiedFixed)];
  }

  const dir = dirname(ctx.statePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  if (!options?.skipRotationPersist) {
    persistRotationSessionToState(ctx);
  }
  await writeFile(ctx.statePath, JSON.stringify(ctx.state, null, 2), 'utf-8');
}

export async function markInterrupted(ctx: StateContext): Promise<void> {
  if (!ctx.state) return;
  
  ctx.state.interrupted = true;
  ctx.state.interruptPhase = ctx.currentPhase;
  ctx.state.lastUpdated = new Date().toISOString();
  
  const dir = dirname(ctx.statePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(ctx.statePath, JSON.stringify(ctx.state, null, 2), 'utf-8');
}

export function wasInterrupted(ctx: StateContext): boolean {
  return ctx.state?.interrupted ?? false;
}

export function getInterruptPhase(ctx: StateContext): string | undefined {
  return ctx.state?.interruptPhase;
}

export function clearInterrupted(ctx: StateContext): void {
  if (ctx.state) {
    ctx.state.interrupted = false;
    ctx.state.interruptPhase = undefined;
  }
}
