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
  
  // Sync commentStatuses: flip to resolved if this comment had an "open" status
  if (state.commentStatuses?.[commentId]) {
    state.commentStatuses[commentId] = {
      ...state.commentStatuses[commentId],
      status: 'resolved',
      classification: 'stale',
      updatedAt: new Date().toISOString(),
      updatedAtIteration: currentIteration,
    };
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
  
  // Delete commentStatuses entry so the comment gets re-analyzed
  if (state.commentStatuses?.[commentId]) {
    delete state.commentStatuses[commentId];
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
