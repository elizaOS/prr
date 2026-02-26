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

/**
 * Record successful fix(es) for a tool/model combination
 * 
 * Increments the fix counter and updates last used timestamp. Used to track
 * which models are most effective for this project.
 * 
 * @param ctx - State context
 * @param tool - Tool name (e.g., 'cursor', 'codex', 'llm-api')
 * @param model - Model name (optional, e.g., 'gpt-5.3', 'claude-sonnet-4-5')
 * @param count - Number of fixes to record (default: 1)
 */
export function recordModelFix(ctx: StateContext, tool: string, model?: string, count: number = 1): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.fixes += count;
  stats.lastUsed = new Date().toISOString();
}

/**
 * Record failed fix attempt(s) for a tool/model combination
 * 
 * Increments the failure counter and updates last used timestamp. Used for
 * rotation decisions and performance reporting.
 * 
 * @param ctx - State context
 * @param tool - Tool name
 * @param model - Model name (optional)
 * @param count - Number of failures to record (default: 1)
 */
export function recordModelFailure(ctx: StateContext, tool: string, model?: string, count: number = 1): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.failures += count;
  stats.lastUsed = new Date().toISOString();
}

/**
 * Record a "no changes" result from a tool/model
 * 
 * Increments the no-changes counter. No-changes results occur when the tool
 * runs but produces zero modifications (may be intentional if already fixed).
 * 
 * @param ctx - State context
 * @param tool - Tool name
 * @param model - Model name (optional)
 */
export function recordModelNoChanges(ctx: StateContext, tool: string, model?: string): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.noChanges += 1;
  stats.lastUsed = new Date().toISOString();
}

/**
 * Record a tool error (crash, timeout, etc.)
 * 
 * Increments the error counter. Errors are distinct from failures - they
 * indicate the tool couldn't run properly rather than producing an incorrect fix.
 * 
 * @param ctx - State context
 * @param tool - Tool name
 * @param model - Model name (optional)
 */
export function recordModelError(ctx: StateContext, tool: string, model?: string): void {
  const key = getModelKey(tool, model);
  const stats = ensureModelStats(ctx, key);
  stats.errors += 1;
  stats.lastUsed = new Date().toISOString();
}

/**
 * Get all model performance data
 * 
 * Returns a map of "tool/model" keys to their performance stats.
 * 
 * @param ctx - State context
 * @returns Performance data for all tool/model combinations
 */
export function getModelPerformance(ctx: StateContext): ModelPerformance {
  return ctx.state?.modelPerformance ?? {};
}

/**
 * Get performance stats for a specific tool/model combination
 * 
 * @param ctx - State context
 * @param tool - Tool name
 * @param model - Model name (optional)
 * @returns Stats for the tool/model, or undefined if never used
 */
export function getModelStats(ctx: StateContext, tool: string, model?: string): ModelStats | undefined {
  const key = getModelKey(tool, model);
  return ctx.state?.modelPerformance?.[key];
}

/**
 * Reorder recommended models so best performers (by success rate) are tried first.
 * Models with no history are placed first; then by success rate descending (worst last).
 * WHY: Deprioritizes models that consistently fail (e.g. 100% S/R mismatch) without hardcoding names.
 */
export function sortRecommendedModelsByPerformance(
  models: string[],
  runnerName: string,
  ctx: StateContext
): string[] {
  if (models.length <= 1) return models;
  const withRate = models.map((model) => {
    const stats = getModelStats(ctx, runnerName, model);
    const total = stats ? stats.fixes + stats.failures : 0;
    const successRate = total > 0 ? (stats!.fixes / total) : -1; // -1 = no data
    return { model, successRate };
  });
  return withRate
    .sort((a, b) => {
      if (a.successRate < 0 && b.successRate < 0) return 0;
      if (a.successRate < 0) return -1;
      if (b.successRate < 0) return 1;
      return b.successRate - a.successRate; // best first
    })
    .map((x) => x.model);
}

/**
 * Get all models sorted by success rate
 * 
 * Returns models sorted by success rate (fixes / (fixes + failures)), with
 * secondary sort by total attempts. Used for performance reporting.
 * 
 * @param ctx - State context
 * @returns Array of models with their stats and success rates, sorted best to worst
 */
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

/**
 * Generate a text summary of model performance history
 * 
 * Creates a multi-line string summarizing performance for all models,
 * sorted by success rate. Used for LLM context when recommending models.
 * 
 * @param ctx - State context
 * @returns Formatted summary string, or undefined if no performance data
 */
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

/**
 * Record a fix attempt for a specific issue
 * 
 * Stores detailed attempt history per issue, including which tool/model was
 * used, the result, and any lesson learned. Used by LLM to recommend different
 * models for issues that have been attempted multiple times.
 * 
 * @param ctx - State context
 * @param commentId - ID of the comment being fixed
 * @param tool - Tool name used for this attempt
 * @param model - Model name used (optional)
 * @param result - Outcome of the attempt
 * @param lessonLearned - Optional lesson generated from failure analysis
 * @param rejectionCount - Number of times this attempt was rejected by verification
 */
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

/** Max chars for attempt history in LLM prompts; prevents 100k+ blocks that cause gateway 500. */
const ATTEMPT_HISTORY_MAX_CHARS = 3000;

/**
 * Generate attempt history summary for specific issues
 * 
 * Creates a formatted text summary of all attempts made on the given issues.
 * Used as context for LLM model recommendation to avoid repeating failed
 * strategies. Capped at ATTEMPT_HISTORY_MAX_CHARS so batch prompts stay under gateway limits.
 * 
 * @param ctx - State context
 * @param commentIds - Array of comment IDs to get history for
 * @returns Formatted summary string, or undefined if no attempt history
 */
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
  
  if (lines.length === 0) return undefined;
  const full = lines.join('\n');
  return full.length <= ATTEMPT_HISTORY_MAX_CHARS
    ? full
    : full.slice(0, ATTEMPT_HISTORY_MAX_CHARS) + '\n...(truncated)';
}

export function getIssueAttempts(ctx: StateContext, commentId: string): IssueAttempt[] {
  return ctx.state?.issueAttempts?.[commentId] ?? [];
}
