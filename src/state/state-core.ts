/**
 * Core state management - load/save/lifecycle
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { ResolverState } from './types.js';
import { createInitialState } from './types.js';
import { loadOverallTimings, getOverallTimings, loadOverallTokenUsage, getOverallTokenUsage } from '../logger.js';
import type { StateContext } from './state-context.js';
import { compactLessons } from './state-lessons.js';

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
          console.warn(`PR head has changed (${ctx.state.headSha?.slice(0, 7)} → ${headSha.slice(0, 7)}), some cached state may be stale`);
          ctx.state.headSha = headSha;
        }
        
        if (ctx.state.interrupted) {
          console.log(`Resuming from interrupted run (phase: ${ctx.state.interruptPhase || 'unknown'})`);
        }
        
        const removed = compactLessons(ctx);
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

export async function saveState(ctx: StateContext): Promise<void> {
  if (!ctx.state) {
    throw new Error('No state to save. Call load() first.');
  }

  ctx.state.lastUpdated = new Date().toISOString();
  ctx.state.totalTimings = getOverallTimings();
  ctx.state.totalTokenUsage = getOverallTokenUsage();

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
