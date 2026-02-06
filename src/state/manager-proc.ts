/**
 * State persistence for prr resolver - PROCEDURAL VERSION
 * 
 * REFACTORED: Converted from class to procedural functions.
 * Functions take a StateContext object instead of `this`.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ResolverState, Iteration, VerificationResult, ModelStats, ModelPerformance, BailOutRecord, IssueAttempt } from './types.js';
import { createInitialState } from './types.js';
import { loadOverallTimings, getOverallTimings, loadOverallTokenUsage, getOverallTokenUsage } from '../logger.js';

const STATE_FILENAME = '.pr-resolver-state.json';

/**
 * State context - passed to all state functions
 */
export interface StateContext {
  statePath: string;
  state: ResolverState | null;
  currentPhase: string;
}

/**
 * Create a new state context
 */
export function createStateContext(workdir: string): StateContext {
  return {
    statePath: join(workdir, STATE_FILENAME),
    state: null,
    currentPhase: 'init',
  };
}

/**
 * Load state from disk
 */
export async function loadState(
  ctx: StateContext,
  pr: string,
  branch: string,
  headSha: string
): Promise<ResolverState> {
  if (existsSync(ctx.statePath)) {
    try {
      const content = await readFile(ctx.statePath, 'utf-8');
      ctx.state = JSON.parse(content) as ResolverState;
      
      // Verify it's for the same PR
      if (ctx.state.pr !== pr) {
        console.warn(`State file is for different PR (${ctx.state.pr}), creating new state`);
        ctx.state = createInitialState(pr, branch, headSha);
      } else {
        // Update headSha if PR has changed
        if (ctx.state.headSha !== headSha) {
          console.warn(`PR head has changed (${ctx.state.headSha?.slice(0, 7)} → ${headSha.slice(0, 7)}), some cached state may be stale`);
          ctx.state.headSha = headSha;
        }
        
        // Log if resuming from interrupted run
        if (ctx.state.interrupted) {
          console.log(`Resuming from interrupted run (phase: ${ctx.state.interruptPhase || 'unknown'})`);
        }
        
        // Compact duplicate lessons
        const removed = compactLessons(ctx);
        if (removed > 0) {
          console.log(`Compacted ${removed} duplicate lessons (${ctx.state.lessonsLearned.length} unique remaining)`);
        }
        
        // Load cumulative stats
        if (ctx.state.totalTimings) {
          loadOverallTimings(ctx.state.totalTimings);
        }
        if (ctx.state.totalTokenUsage) {
          loadOverallTokenUsage(ctx.state.totalTokenUsage);
        }

        // Initialize new fields for backward compatibility
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

export function setPhase(ctx: StateContext, phase: string): void {
  ctx.currentPhase = phase;
}

export async function markInterrupted(ctx: StateContext): Promise<void> {
  if (!ctx.state) return;
  
  ctx.state.interrupted = true;
  ctx.state.interruptPhase = ctx.currentPhase;
  ctx.state.lastUpdated = new Date().toISOString();
  
  // Save immediately
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

export async function saveState(ctx: StateContext): Promise<void> {
  if (!ctx.state) {
    throw new Error('No state to save. Call loadState() first.');
  }

  ctx.state.lastUpdated = new Date().toISOString();
  
  // Save cumulative stats
  ctx.state.totalTimings = getOverallTimings();
  ctx.state.totalTokenUsage = getOverallTokenUsage();

  // Ensure directory exists
  const dir = dirname(ctx.statePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(ctx.statePath, JSON.stringify(ctx.state, null, 2), 'utf-8');
}

export function getState(ctx: StateContext): ResolverState {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }
  return ctx.state;
}

export function isCommentVerifiedFixed(ctx: StateContext, commentId: string, maxIterationsAgo?: number): boolean {
  if (!ctx.state) return false;
  
  if (ctx.state.verifiedComments) {
    const record = ctx.state.verifiedComments.find(v => v.commentId === commentId);
    if (record) {
      if (maxIterationsAgo !== undefined) {
        const currentIteration = ctx.state.iterations.length;
        const iterationsSince = currentIteration - record.verifiedAtIteration;
        return iterationsSince <= maxIterationsAgo;
      }
      return true;
    }
  }
  
  return ctx.state.verifiedFixed.includes(commentId);
}

export function markCommentVerifiedFixed(ctx: StateContext, commentId: string): void {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }
  
  if (!ctx.state.verifiedFixed.includes(commentId)) {
    ctx.state.verifiedFixed.push(commentId);
  }
  
  if (!ctx.state.verifiedComments) {
    ctx.state.verifiedComments = [];
  }
  
  ctx.state.verifiedComments = ctx.state.verifiedComments.filter(v => v.commentId !== commentId);
  
  ctx.state.verifiedComments.push({
    commentId,
    verifiedAt: new Date().toISOString(),
    verifiedAtIteration: ctx.state.iterations.length,
  });
}

export function unmarkCommentVerifiedFixed(ctx: StateContext, commentId: string): void {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }
  
  const index = ctx.state.verifiedFixed.indexOf(commentId);
  if (index !== -1) {
    ctx.state.verifiedFixed.splice(index, 1);
  }
  
  if (ctx.state.verifiedComments) {
    ctx.state.verifiedComments = ctx.state.verifiedComments.filter(v => v.commentId !== commentId);
  }
}

export function clearVerificationCache(ctx: StateContext): void {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }

  ctx.state.verifiedFixed = [];
  ctx.state.verifiedComments = [];
}

export function addDismissedIssue(
  ctx: StateContext,
  commentId: string,
  reason: string,
  category: 'already-fixed' | 'not-an-issue' | 'file-unchanged' | 'false-positive' | 'duplicate',
  filePath: string,
  line: number | null,
  commentBody: string
): void {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }

  if (!ctx.state.dismissedIssues) {
    ctx.state.dismissedIssues = [];
  }

  ctx.state.dismissedIssues = ctx.state.dismissedIssues.filter(d => d.commentId !== commentId);

  ctx.state.dismissedIssues.push({
    commentId,
    reason,
    dismissedAt: new Date().toISOString(),
    dismissedAtIteration: ctx.state.iterations.length,
    category,
    filePath,
    line,
    commentBody,
  });
}

export function getDismissedIssues(ctx: StateContext, category?: string): Array<{
  commentId: string;
  reason: string;
  dismissedAt: string;
  dismissedAtIteration: number;
  category: string;
  filePath: string;
  line: number | null;
  commentBody: string;
}> {
  if (!ctx.state?.dismissedIssues) {
    return [];
  }

  if (!category) {
    return [...ctx.state.dismissedIssues];
  }

  return ctx.state.dismissedIssues.filter(d => d.category === category);
}

export function isCommentDismissed(ctx: StateContext, commentId: string): boolean {
  if (!ctx.state?.dismissedIssues) {
    return false;
  }

  return ctx.state.dismissedIssues.some(d => d.commentId === commentId);
}

export function getStaleVerifications(ctx: StateContext, maxIterationsAgo: number): string[] {
  if (!ctx.state || !ctx.state.verifiedComments) return [];
  
  const currentIteration = ctx.state.iterations.length;
  return ctx.state.verifiedComments
    .filter(v => (currentIteration - v.verifiedAtIteration) > maxIterationsAgo)
    .map(v => v.commentId);
}

export function getVerifiedComments(ctx: StateContext): string[] {
  if (!ctx.state) return [];
  
  const fromLegacy = ctx.state.verifiedFixed || [];
  const fromNew = ctx.state.verifiedComments?.map(v => v.commentId) || [];
  
  return [...new Set([...fromLegacy, ...fromNew])];
}

export function addLesson(ctx: StateContext, lesson: string): void {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }
  
  const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
  const key = keyMatch ? keyMatch[1] : null;
  
  if (key) {
    const existingIndex = ctx.state.lessonsLearned.findIndex(l => l.startsWith(`Fix for ${key}`));
    if (existingIndex !== -1) {
      ctx.state.lessonsLearned[existingIndex] = lesson;
      return;
    }
  }
  
  if (!ctx.state.lessonsLearned.includes(lesson)) {
    ctx.state.lessonsLearned.push(lesson);
  }
}

export function getLessons(ctx: StateContext): string[] {
  return ctx.state?.lessonsLearned || [];
}

export function getLessonCount(ctx: StateContext): number {
  return ctx.state?.lessonsLearned.length || 0;
}

export function compactLessons(ctx: StateContext): number {
  if (!ctx.state) return 0;
  
  const lessonsByKey = new Map<string, string>();
  const before = ctx.state.lessonsLearned.length;
  let uniqueCounter = 0;
  
  for (const lesson of ctx.state.lessonsLearned) {
    const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
    const key = keyMatch ? keyMatch[1] : `unique_${uniqueCounter++}`;
    
    lessonsByKey.set(key, lesson);
  }

  ctx.state.lessonsLearned = Array.from(lessonsByKey.values());
  return before - ctx.state.lessonsLearned.length;
}

export function startIteration(ctx: StateContext): Iteration {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }

  const iteration: Iteration = {
    timestamp: new Date().toISOString(),
    commentsAddressed: [],
    changesMade: [],
    verificationResults: {},
  };

  ctx.state.iterations.push(iteration);
  return iteration;
}

export function getCurrentIteration(ctx: StateContext): Iteration | null {
  if (!ctx.state || ctx.state.iterations.length === 0) {
    return null;
  }
  return ctx.state.iterations[ctx.state.iterations.length - 1];
}

export function addCommentToIteration(ctx: StateContext, commentId: string): void {
  const iteration = getCurrentIteration(ctx);
  if (iteration && !iteration.commentsAddressed.includes(commentId)) {
    iteration.commentsAddressed.push(commentId);
  }
}

export function addChangeToIteration(ctx: StateContext, file: string, description: string): void {
  const iteration = getCurrentIteration(ctx);
  if (iteration) {
    iteration.changesMade.push({ file, description });
  }
}

export function addVerificationResult(ctx: StateContext, commentId: string, result: VerificationResult): void {
  const iteration = getCurrentIteration(ctx);
  if (iteration) {
    iteration.verificationResults[commentId] = result;
  }
}

export function setCurrentRunnerIndex(ctx: StateContext, index: number): void {
  if (!ctx.state) return;
  ctx.state.currentRunnerIndex = index;
}

export function getCurrentRunnerIndex(ctx: StateContext): number {
  return ctx.state?.currentRunnerIndex ?? 0;
}

export function setModelIndex(ctx: StateContext, runnerName: string, index: number): void {
  if (!ctx.state) return;
  if (!ctx.state.modelIndices) {
    ctx.state.modelIndices = {};
  }
  ctx.state.modelIndices[runnerName] = index;
}

export function getModelIndex(ctx: StateContext, runnerName: string): number {
  return ctx.state?.modelIndices?.[runnerName] ?? 0;
}

export function getModelIndices(ctx: StateContext): Record<string, number> {
  return ctx.state?.modelIndices ?? {};
}

export function setModelIndices(ctx: StateContext, indices: Record<string, number>): void {
  if (!ctx.state) return;
  ctx.state.modelIndices = indices;
}

function getModelKey(tool: string, model?: string): string {
  return model ? `${tool}/${model}` : tool;
}

function ensureModelStats(ctx: StateContext, key: string): ModelStats {
  if (!ctx.state) throw new Error('State not loaded');
  if (!ctx.state.modelPerformance) {
    ctx.state.modelPerformance = {};
  }
  if (!ctx.state.modelPerformance[key]) {
    ctx.state.modelPerformance[key] = {
      fixes: 0,
      failures: 0,
      noChanges: 0,
      errors: 0,
      lastUsed: new Date().toISOString(),
    };
  }
  return ctx.state.modelPerformance[key];
}

export function recordModelFix(ctx: StateContext, tool: string, model?: string, count: number = 1): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.fixes += count;
  stats.lastUsed = new Date().toISOString();
}

export function recordModelFailure(ctx: StateContext, tool: string, model?: string, count: number = 1): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.failures += count;
  stats.lastUsed = new Date().toISOString();
}

export function recordModelNoChanges(ctx: StateContext, tool: string, model?: string): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.noChanges += 1;
  stats.lastUsed = new Date().toISOString();
}

export function recordModelError(ctx: StateContext, tool: string, model?: string): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.errors += 1;
  stats.lastUsed = new Date().toISOString();
}

export function getModelPerformance(ctx: StateContext): ModelPerformance {
  return ctx.state?.modelPerformance ?? {};
}

export function getModelStats(ctx: StateContext, tool: string, model?: string): ModelStats | undefined {
  const key = getModelKey(tool, model);
  return ctx.state?.modelPerformance?.[key];
}

export function getModelsBySuccessRate(ctx: StateContext): Array<{ key: string; stats: ModelStats; successRate: number }> {
  const perf = ctx.state?.modelPerformance ?? {};
  return Object.entries(perf)
    .map(([key, stats]) => {
      const total = stats.fixes + stats.failures;
      const successRate = total > 0 ? stats.fixes / total : 0;
      return { key, stats, successRate };
    })
    .sort((a, b) => {
      if (b.successRate !== a.successRate) {
        return b.successRate - a.successRate;
      }
      return (b.stats.fixes + b.stats.failures) - (a.stats.fixes + a.stats.failures);
    });
}

export function getModelHistorySummary(ctx: StateContext): string | undefined {
  const models = getModelsBySuccessRate(ctx);
  if (models.length === 0) {
    return undefined;
  }
  
  const lines: string[] = [];
  for (const { key, stats, successRate } of models) {
    const total = stats.fixes + stats.failures;
    if (total === 0) continue;
    
    const rate = (successRate * 100).toFixed(0);
    let line = `${key}: ${stats.fixes} fixes, ${stats.failures} failures (${rate}% success)`;
    
    if (stats.noChanges > 0) {
      line += `, ${stats.noChanges} no-changes`;
    }
    if (stats.errors > 0) {
      line += `, ${stats.errors} errors`;
    }
    
    lines.push(line);
  }
  
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function recordIssueAttempt(
  ctx: StateContext,
  commentId: string,
  tool: string,
  model: string | undefined,
  result: 'fixed' | 'failed' | 'no-changes' | 'error',
  lessonLearned?: string,
  rejectionCount?: number
): void {
  if (!ctx.state) throw new Error('State not loaded');
  if (!ctx.state.issueAttempts) {
    ctx.state.issueAttempts = {};
  }
  if (!ctx.state.issueAttempts[commentId]) {
    ctx.state.issueAttempts[commentId] = [];
  }
  
  ctx.state.issueAttempts[commentId].push({
    commentId,
    tool,
    model,
    timestamp: new Date().toISOString(),
    result,
    lessonLearned,
    rejectionCount,
  });
}

export function getAttemptHistoryForIssues(ctx: StateContext, commentIds: string[]): string | undefined {
  if (!ctx.state?.issueAttempts) return undefined;
  
  const lines: string[] = [];
  
  for (const commentId of commentIds) {
    const attempts = ctx.state.issueAttempts[commentId];
    if (!attempts || attempts.length === 0) continue;
    
    const summaries = attempts.map(a => {
      const modelKey = a.model ? `${a.tool}/${a.model}` : a.tool;
      let summary = `${modelKey}: ${a.result}`;
      if (a.rejectionCount && a.rejectionCount > 0) {
        summary += ` (${a.rejectionCount} rejections)`;
      }
      if (a.lessonLearned) {
        summary += ` [lesson: ${a.lessonLearned.substring(0, 50)}...]`;
      }
      return summary;
    });
    
    lines.push(`Issue ${commentId}: ${summaries.join(', ')}`);
  }
  
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function getIssueAttempts(ctx: StateContext, commentId: string): IssueAttempt[] {
  return ctx.state?.issueAttempts?.[commentId] ?? [];
}

export function getNoProgressCycles(ctx: StateContext): number {
  return ctx.state?.noProgressCycles ?? 0;
}

export function incrementNoProgressCycles(ctx: StateContext): number {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }
  if (!ctx.state.noProgressCycles) {
    ctx.state.noProgressCycles = 0;
  }
  ctx.state.noProgressCycles++;
  return ctx.state.noProgressCycles;
}

export function resetNoProgressCycles(ctx: StateContext): void {
  if (!ctx.state) return;
  ctx.state.noProgressCycles = 0;
}

export function recordBailOut(
  ctx: StateContext,
  reason: BailOutRecord['reason'],
  cyclesCompleted: number,
  remainingIssues: BailOutRecord['remainingIssues'],
  issuesFixed: number,
  toolsExhausted: string[]
): void {
  if (!ctx.state) {
    throw new Error('State not loaded. Call loadState() first.');
  }
  
  ctx.state.bailOutRecord = {
    timestamp: new Date().toISOString(),
    reason,
    cyclesCompleted,
    remainingIssues,
    partialProgress: {
      issuesFixed,
      issuesRemaining: remainingIssues.length,
      lessonsLearned: ctx.state.lessonsLearned.length,
    },
    toolsExhausted,
  };
}

export function getBailOutRecord(ctx: StateContext): BailOutRecord | undefined {
  return ctx.state?.bailOutRecord;
}

export function clearBailOutRecord(ctx: StateContext): void {
  if (ctx.state) {
    ctx.state.bailOutRecord = undefined;
  }
}
