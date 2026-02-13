/**
 * Verification tracking
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { VerifiedComment } from './types.js';

export type VerificationRecord = VerifiedComment;

/**
 * Mark a comment as verified/fixed
 * 
 * Records the current iteration number and timestamp. Updates existing
 * verification or creates a new one. Also adds to legacy verifiedFixed array.
 * 
 * @param ctx - State context
 * @param commentId - ID of the comment to mark as verified
 * @param autoVerifiedFrom - Optional canonical comment ID if this is an auto-verified duplicate
 */
export function markVerified(ctx: StateContext, commentId: string, autoVerifiedFrom?: string): void {
  const state = getState(ctx);
  
  if (!state.verifiedComments) {
    state.verifiedComments = [];
  }
  
  const currentIteration = state.iterations.length;
  const existing = state.verifiedComments.find(v => v.commentId === commentId);
  
  if (existing) {
    existing.verifiedAt = new Date().toISOString();
    existing.verifiedAtIteration = currentIteration;
    if (autoVerifiedFrom !== undefined) {
      existing.autoVerifiedFrom = autoVerifiedFrom;
    }
  } else {
    state.verifiedComments.push({
      commentId,
      verifiedAt: new Date().toISOString(),
      verifiedAtIteration: currentIteration,
      autoVerifiedFrom,
    });
    
    if (!state.verifiedFixed.includes(commentId)) {
      state.verifiedFixed.push(commentId);
    }
  }
}

/**
 * Remove verification status from a comment
 * 
 * Used when a previously verified fix is detected as stale or incorrect.
 * Removes from both new verifiedComments array and legacy verifiedFixed array.
 * 
 * @param ctx - State context
 * @param commentId - ID of the comment to unmark
 */
export function unmarkVerified(ctx: StateContext, commentId: string): void {
  const state = getState(ctx);
  
  if (!state.verifiedComments) {
    state.verifiedComments = [];
  }
  
  const index = state.verifiedComments.findIndex(v => v.commentId === commentId);
  if (index !== -1) {
    state.verifiedComments.splice(index, 1);
  }
  
  const legacyIndex = state.verifiedFixed.indexOf(commentId);
  if (legacyIndex !== -1) {
    state.verifiedFixed.splice(legacyIndex, 1);
  }
}

/**
 * Check if a comment is marked as verified
 * 
 * Checks both new verifiedComments array and legacy verifiedFixed array
 * for backward compatibility.
 * 
 * @param ctx - State context
 * @param commentId - ID of the comment to check
 * @returns true if the comment is verified
 */
export function isVerified(ctx: StateContext, commentId: string): boolean {
  const state = ctx.state;
  if (!state) return false;
  
  const inNew = state.verifiedComments?.some(v => v.commentId === commentId) ?? false;
  if (inNew) return true;
  
  return state.verifiedFixed.includes(commentId);
}

/**
 * Get the full verification record for a comment
 * 
 * Returns the verification record with timestamp and iteration number,
 * or undefined if not verified.
 * 
 * @param ctx - State context
 * @param commentId - ID of the comment
 * @returns Verification record or undefined
 */
export function getVerificationRecord(ctx: StateContext, commentId: string): VerificationRecord | undefined {
  const state = ctx.state;
  if (!state?.verifiedComments) return undefined;
  
  return state.verifiedComments.find(v => v.commentId === commentId);
}

/**
 * Find verifications that are older than a threshold
 * 
 * Used to detect verifications that may no longer be valid due to code changes.
 * Returns comment IDs verified more than maxIterationsAgo iterations ago.
 * Also returns auto-verified duplicates when their canonical goes stale.
 * 
 * @param ctx - State context (optional)
 * @param maxIterationsAgo - Maximum age in iterations before considered stale
 * @returns Array of stale comment IDs (including linked duplicates)
 */
export function getStaleVerifications(ctx: StateContext | undefined, maxIterationsAgo: number): string[] {
  if (!ctx) return [];
  const state = ctx.state;
  if (!state || !state.verifiedComments) return [];
  
  const currentIteration = state.iterations.length;
  const staleIds = new Set<string>();
  
  // Find stale canonicals
  for (const v of state.verifiedComments) {
    if ((currentIteration - v.verifiedAtIteration) > maxIterationsAgo) {
      staleIds.add(v.commentId);
    }
  }
  
  // Also mark auto-verified duplicates as stale when their canonical is stale
  for (const v of state.verifiedComments) {
    if (v.autoVerifiedFrom && staleIds.has(v.autoVerifiedFrom)) {
      staleIds.add(v.commentId);
    }
  }
  
  return [...staleIds];
}

/**
 * Get all verified comment IDs
 * 
 * Returns a deduplicated list from both new and legacy storage.
 * 
 * @param ctx - State context
 * @returns Array of all verified comment IDs
 */
export function getVerifiedComments(ctx: StateContext): string[] {
  const state = ctx.state;
  if (!state) return [];
  
  const fromLegacy = state.verifiedFixed || [];
  const fromNew = state.verifiedComments?.map(v => v.commentId) || [];
  
  return [...new Set([...fromLegacy, ...fromNew])];
}

/**
 * Clear all verification records
 * 
 * Used when code changes invalidate all previous verifications (e.g., after
 * pulling new commits). Clears both new and legacy storage.
 * 
 * @param ctx - State context
 */
export function clearAllVerifications(ctx: StateContext): void {
  const state = ctx.state;
  if (!state) return;
  
  state.verifiedFixed = [];
  state.verifiedComments = [];
}
