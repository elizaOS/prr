/**
 * Dismissed issues tracking
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { DismissedIssue } from './types.js';

export function dismissIssue(
  ctx: StateContext,
  commentId: string,
  reason: string,
  category: DismissedIssue['category'],
  filePath: string,
  line: number | null,
  commentBody: string
): void {
  const state = getState(ctx);
  
  if (!state.dismissedIssues) {
    state.dismissedIssues = [];
  }
  
  const currentIteration = state.iterations.length;
  const existing = state.dismissedIssues.find(d => d.commentId === commentId);
  if (!existing) {
    state.dismissedIssues.push({
      commentId,
      reason,
      dismissedAt: new Date().toISOString(),
      dismissedAtIteration: currentIteration,
      category,
      filePath,
      line,
      commentBody,
    });
  }
}

export function undismissIssue(ctx: StateContext, commentId: string): void {
  const state = getState(ctx);
  
  if (!state.dismissedIssues) {
    state.dismissedIssues = [];
  }
  
  const index = state.dismissedIssues.findIndex(d => d.commentId === commentId);
  if (index !== -1) {
    state.dismissedIssues.splice(index, 1);
  }
}

export function getDismissedIssues(ctx: StateContext): DismissedIssue[] {
  return ctx.state?.dismissedIssues ?? [];
}

export function isCommentDismissed(ctx: StateContext, commentId: string): boolean {
  const state = ctx.state;
  if (!state?.dismissedIssues) {
    return false;
  }
  
  return state.dismissedIssues.some(d => d.commentId === commentId);
}
