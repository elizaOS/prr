/**
 * Core state management - load/save/lifecycle
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { ResolverState } from './types.js';
import { createInitialState } from './types.js';
import { loadOverallTimings, getOverallTimings, loadOverallTokenUsage, getOverallTokenUsage, formatNumber } from '../../../shared/logger.js';
import { getEffectiveElizacloudSkipModelIds } from '../../../shared/constants.js';
import type { StateContext } from './state-context.js';

export async function loadState(ctx: StateContext, pr: string, branch: string, headSha: string): Promise<ResolverState> {
  if (existsSync(ctx.statePath)) {
    try {
      const content = await readFile(ctx.statePath, 'utf-8');
      ctx.state = JSON.parse(content) as ResolverState;
      
      if (ctx.state.pr !== pr) {
        console.warn(`State file is for different PR (${ctx.state.pr}), creating new state`);
        ctx.state = createInitialState(pr, branch, headSha);
      } else {
        if (ctx.state.headSha !== headSha) {
          const prevSha = ctx.state.headSha?.slice(0, 7);
          ctx.state.headSha = headSha;
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
            console.warn(
              `PR head changed: cleared partial conflict resolutions so they are re-applied against current merge`,
            );
          }
        }

        if (ctx.state.interrupted) {
          console.log(`Resuming from interrupted run (phase: ${ctx.state.interruptPhase || 'unknown'})`);
        }
        
        const { compactLessons } = await import('./state-lessons.js');
        const removed = await compactLessons(ctx);
        if (removed > 0) {
          console.log(`Compacted ${removed} duplicate lessons (${ctx.state.lessonsLearned.length} unique remaining)`);
        }
        
        // Deduplicate verifiedFixed on load.
        // WHY: Prior sessions and git-commit-scan can accumulate duplicate IDs,
        // inflating the verified count beyond the total number of comments.
        if (ctx.state.verifiedFixed && ctx.state.verifiedFixed.length > 0) {
          const before = ctx.state.verifiedFixed.length;
          ctx.state.verifiedFixed = [...new Set(ctx.state.verifiedFixed)];
          const dupsRemoved = before - ctx.state.verifiedFixed.length;
          if (dupsRemoved > 0) {
            console.log(`Deduplicated verifiedFixed: removed ${dupsRemoved} duplicate(s) (${ctx.state.verifiedFixed.length} unique)`);
          }
        }

        // Also deduplicate verifiedComments by commentId, keeping the latest entry
        if (ctx.state.verifiedComments && ctx.state.verifiedComments.length > 0) {
          const seen = new Map<string, typeof ctx.state.verifiedComments[number]>();
          for (const vc of ctx.state.verifiedComments) {
            const existing = seen.get(vc.commentId);
            if (!existing || (vc.verifiedAt && (!existing.verifiedAt || vc.verifiedAt > existing.verifiedAt))) {
              seen.set(vc.commentId, vc);
            }
          }
          const beforeNew = ctx.state.verifiedComments.length;
          ctx.state.verifiedComments = [...seen.values()];
          const dupsRemovedNew = beforeNew - ctx.state.verifiedComments.length;
          if (dupsRemovedNew > 0) {
            console.log(`Deduplicated verifiedComments: removed ${dupsRemovedNew} duplicate(s)`);
          }
        }
        
        // Reset no-progress cycle counter at session start.
        // WHY: This counter is for detecting stalemate within a session's rotation.
        // Carrying over 43 from a previous run makes the bail-out message misleading
        // ("44 cycles") and gives no useful signal. Historical bail-out data is
        // preserved in bailOutRecord anyway.
        if (ctx.state.noProgressCycles) {
          ctx.state.noProgressCycles = 0;
        }
        
        if (ctx.state.totalTimings) {
          loadOverallTimings(ctx.state.totalTimings);
        }
        if (ctx.state.totalTokenUsage) {
          loadOverallTokenUsage(ctx.state.totalTokenUsage);
        }

        if (!ctx.state.dismissedIssues) {
          ctx.state.dismissedIssues = [];
        }

        // Normalize legacy .d.ts dismissals: old runs stored "missing-file" for path ".d.ts";
        // we now treat it as path-unresolved (fragment). Update so debug table and counts are consistent.
        const fragmentReason = `Review path ".d.ts" is a fragment (e.g. .d.ts), not a full file path — cannot resolve to a single file`;
        let normalizedFragment = 0;
        for (const d of ctx.state.dismissedIssues) {
          if (d.filePath === '.d.ts' && d.reason?.startsWith('Tracked file not found for review path: .d.ts')) {
            d.category = 'path-unresolved';
            d.reason = fragmentReason;
            normalizedFragment++;
          }
        }
        if (normalizedFragment > 0) {
          console.log(`Normalized ${formatNumber(normalizedFragment)} legacy .d.ts dismissal(s) to path-unresolved`);
        }

        // Keep verifiedFixed and dismissedIssues mutually exclusive (output.log audit: overlapVerifiedAndDismissed; pill #3).
        // (1) Remove from dismissed when it's in verified. (2) Remove from verified when it's in dismissed.
        const verifiedSet = new Set(ctx.state.verifiedFixed ?? []);
        const dismissedIds = new Set(ctx.state.dismissedIssues.map((d) => d.commentId));
        if (verifiedSet.size > 0 && ctx.state.dismissedIssues.length > 0) {
          const beforeD = ctx.state.dismissedIssues.length;
          ctx.state.dismissedIssues = ctx.state.dismissedIssues.filter((d) => !verifiedSet.has(d.commentId));
          const removedD = beforeD - ctx.state.dismissedIssues.length;
          if (removedD > 0) {
            console.log(`Cleaned ${formatNumber(removedD)} overlap (removed from dismissed; already in verified)`);
          }
        }
        if (dismissedIds.size > 0 && ctx.state.verifiedFixed?.length) {
          const beforeV = ctx.state.verifiedFixed.length;
          ctx.state.verifiedFixed = ctx.state.verifiedFixed.filter((id) => !dismissedIds.has(id));
          const removedV = beforeV - ctx.state.verifiedFixed.length;
          if (removedV > 0) {
            console.warn(`State load: removed ${formatNumber(removedV)} ID(s) from verifiedFixed (already in dismissed — overlap cleaned)`);
          }
        }

        // Never carry recoveredFromGitCommentIds across runs — it's only for the first analysis after recovery.
        if (ctx.state.recoveredFromGitCommentIds !== undefined) {
          ctx.state.recoveredFromGitCommentIds = undefined;
        }

        // Zero out model performance for skipped models so stale 0%-success data doesn't persist.
        if (ctx.state.modelPerformance) {
          const skipIds = getEffectiveElizacloudSkipModelIds();
          if (skipIds.length > 0) {
          const skipSet = new Set(skipIds);
          let removed = 0;
          for (const key of Object.keys(ctx.state.modelPerformance)) {
            const modelId = key.includes('/') ? key.split('/').slice(1).join('/') : key;
            if (skipSet.has(modelId)) {
              delete ctx.state.modelPerformance[key];
              removed++;
            }
          }
          if (removed > 0) {
            console.log(`Cleared ${formatNumber(removed)} model performance entries for skipped models`);
          }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load state file, creating new state:', error);
      ctx.state = createInitialState(pr, branch, headSha);
    }
  } else {
    ctx.state = createInitialState(pr, branch, headSha);
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

export async function saveState(ctx: StateContext): Promise<void> {
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
