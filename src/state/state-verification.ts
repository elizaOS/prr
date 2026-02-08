/**
 * Verification tracking
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { VerifiedComment } from './types.js';

export type VerificationRecord = VerifiedComment;

export function markVerified(ctx: StateContext, commentId: string): void {
  const state = getState(ctx);
  
  if (!state.verifiedComments) {
    state.verifiedComments = [];
  }
  
  const currentIteration = state.iterations.length;
  const existing = state.verifiedComments.find(v => v.commentId === commentId);
  
  if (existing) {
    existing.verifiedAt = new Date().toISOString();
    existing.verifiedAtIteration = currentIteration;
  } else {
    state.verifiedComments.push({
      commentId,
      verifiedAt: new Date().toISOString(),
      verifiedAtIteration: currentIteration,
    });
    
    if (!state.verifiedFixed.includes(commentId)) {
      state.verifiedFixed.push(commentId);
    }
  }
}

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

export function isVerified(ctx: StateContext, commentId: string): boolean {
  const state = ctx.state;
  if (!state) return false;
  
  const inNew = state.verifiedComments?.some(v => v.commentId === commentId) ?? false;
  if (inNew) return true;
  
  return state.verifiedFixed.includes(commentId);
}

export function getVerificationRecord(ctx: StateContext, commentId: string): VerificationRecord | undefined {
  const state = ctx.state;
  if (!state?.verifiedComments) return undefined;
  
  return state.verifiedComments.find(v => v.commentId === commentId);
}

export function getStaleVerifications(ctx: StateContext | undefined, maxIterationsAgo: number): string[] {
  if (!ctx) return [];
  const state = ctx.state;
  if (!state || !state.verifiedComments) return [];
  
  const currentIteration = state.iterations.length;
  return state.verifiedComments
    .filter(v => (currentIteration - v.verifiedAtIteration) > maxIterationsAgo)
    .map(v => v.commentId);
}

export function getVerifiedComments(ctx: StateContext): string[] {
  const state = ctx.state;
  if (!state) return [];
  
  const fromLegacy = state.verifiedFixed || [];
  const fromNew = state.verifiedComments?.map(v => v.commentId) || [];
  
  return [...new Set([...fromLegacy, ...fromNew])];
}

export function clearAllVerifications(ctx: StateContext): void {
  const state = ctx.state;
  if (!state) return;
  
  state.verifiedFixed = [];
  state.verifiedComments = [];
}
