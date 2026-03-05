/**
 * Comment status management — explicit open/resolved lifecycle per PR comment.
 *
 * HISTORY: Previously, "unresolved" comments had no persistent status — every
 * push iteration re-sent them to the LLM for classification. Comments are
 * near-immutable (body/path/line don't change after posting), so the only
 * variable is whether the CODE still exhibits the issue. By persisting the
 * LLM's "still exists" verdict alongside a file content hash, subsequent
 * iterations can skip the analysis call entirely for comments whose target
 * file hasn't been modified.
 *
 * Status transitions:
 *   new comment → analyze → open (issue exists)
 *   new comment → analyze → resolved (already fixed / stale)
 *   open → fix + verify → resolved
 *   open → dismiss → resolved
 *   open → file modified → needs re-analysis (status cleared)
 */

import type { StateContext } from './state-context.js';
import type { CommentStatus } from './types.js';
import { getState } from './state-context.js';

function getStatuses(ctx: StateContext): Record<string, CommentStatus> {
  const state = getState(ctx);
  if (!state.commentStatuses) {
    state.commentStatuses = {};
  }
  return state.commentStatuses;
}

/**
 * Mark a comment as "open" — LLM confirmed the issue still exists in the code.
 */
export function markOpen(
  ctx: StateContext,
  commentId: string,
  classification: CommentStatus['classification'],
  explanation: string,
  importance: number,
  ease: number,
  filePath: string,
  fileContentHash: string,
): void {
  const statuses = getStatuses(ctx);
  const iteration = getState(ctx).iterations?.length ?? 0;
  statuses[commentId] = {
    status: 'open',
    classification,
    explanation,
    importance,
    ease,
    filePath,
    fileContentHash,
    updatedAt: new Date().toISOString(),
    updatedAtIteration: iteration,
  };
}

/**
 * Mark a comment as "resolved" — issue was fixed, dismissed, or determined stale.
 */
export function markResolved(
  ctx: StateContext,
  commentId: string,
  classification: CommentStatus['classification'],
  explanation: string,
  filePath: string,
  fileContentHash: string,
): void {
  const statuses = getStatuses(ctx);
  const iteration = getState(ctx).iterations?.length ?? 0;
  statuses[commentId] = {
    status: 'resolved',
    classification,
    explanation,
    importance: 0,
    ease: 0,
    filePath,
    fileContentHash,
    updatedAt: new Date().toISOString(),
    updatedAtIteration: iteration,
  };
}

/**
 * Get the current status for a comment, if any.
 */
export function getStatus(ctx: StateContext, commentId: string): CommentStatus | undefined {
  const state = ctx.state;
  if (!state?.commentStatuses) return undefined;
  return state.commentStatuses[commentId];
}

/**
 * Check if a comment is explicitly "open" (analyzed, issue confirmed to exist).
 */
export function isOpen(ctx: StateContext, commentId: string): boolean {
  const status = getStatus(ctx, commentId);
  return status?.status === 'open';
}

/**
 * Check if a comment is "resolved" (fixed, dismissed, or stale).
 */
export function isResolved(ctx: StateContext, commentId: string): boolean {
  const status = getStatus(ctx, commentId);
  return status?.status === 'resolved';
}

/**
 * Check if a comment's cached analysis is still valid (file hasn't changed).
 * Returns the cached status if valid, undefined if invalidated or missing.
 */
export function getValidStatus(
  ctx: StateContext,
  commentId: string,
  currentFileHash: string,
): CommentStatus | undefined {
  const status = getStatus(ctx, commentId);
  if (!status) return undefined;
  
  // HISTORY: Phase 0 hooks preserve the original hash when flipping status to 'resolved'.
  // If we validate hash for resolved entries, a comment verified after the file was
  // modified would be invalidated and re-analyzed. But resolved entries are already
  // caught by isVerified()/isDismissed() gates BEFORE we reach this check. Only 'open'
  // entries need strict hash validation — they're the ones we're trying to skip LLM for.
  if (status.status === 'open' && status.fileContentHash !== currentFileHash) return undefined;
  
  return status;
}

/**
 * Invalidate all open statuses for comments targeting a specific file.
 * Called after the fixer modifies a file — those comments need re-analysis.
 */
export function invalidateForFile(ctx: StateContext, filePath: string): number {
  const state = ctx.state;
  if (!state?.commentStatuses) return 0;

  let invalidated = 0;
  for (const [commentId, status] of Object.entries(state.commentStatuses)) {
    if (status.filePath === filePath && status.status === 'open') {
      delete state.commentStatuses[commentId];
      invalidated++;
    }
  }
  return invalidated;
}

/**
 * Invalidate open statuses for all files in the given set.
 * Typically called after a fix iteration with the set of changed files.
 */
export function invalidateForFiles(ctx: StateContext, filePaths: string[]): number {
  let total = 0;
  for (const fp of filePaths) {
    total += invalidateForFile(ctx, fp);
  }
  return total;
}

/**
 * Get all comment IDs with a given status.
 */
export function getCommentsByStatus(ctx: StateContext, status: 'open' | 'resolved'): string[] {
  const state = ctx.state;
  if (!state?.commentStatuses) return [];
  return Object.entries(state.commentStatuses)
    .filter(([, s]) => s.status === status)
    .map(([id]) => id);
}
