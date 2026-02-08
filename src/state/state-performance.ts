/**
 * Model performance tracking
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { ModelPerformance, ModelStats, IssueAttempt } from './types.js';

function getModelKey(tool: string, model?: string): string {
  return model ? `${tool}/${model}` : tool;
}

function ensureModelStats(ctx: StateContext, key: string): ModelStats {
  const state = getState(ctx);
  if (!state.modelPerformance) {
    state.modelPerformance = {};
  }
  if (!state.modelPerformance[key]) {
    state.modelPerformance[key] = {
      fixes: 0,
      failures: 0,
      noChanges: 0,
      errors: 0,
      lastUsed: new Date().toISOString(),
    };
  }
  return state.modelPerformance[key];
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
  const state = getState(ctx);
  if (!state.issueAttempts) {
    state.issueAttempts = {};
  }
  if (!state.issueAttempts[commentId]) {
    state.issueAttempts[commentId] = [];
  }
  
  state.issueAttempts[commentId].push({
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
  const state = ctx.state;
  if (!state?.issueAttempts) return undefined;
  
  const lines: string[] = [];
  
  for (const commentId of commentIds) {
    const attempts = state.issueAttempts[commentId];
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
