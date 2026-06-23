/**
 * Single write path for verified / dismissed / unverified comment state.
 *
 * WHY: Multiple APIs (markVerified, dismissIssue, unmarkVerified, legacy StateManager)
 * used to duplicate array surgery and sometimes skipped verifiedThisSession or
 * commentStatuses sync (audit cycles 41, 51, 64). All transitions go through
 * {@link transitionIssue} so mutual exclusion, session set, commentStatuses,
 * and apply-failure cleanup stay consistent.
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { DismissedIssue } from './types.js';
import { debug } from '../../../shared/logger.js';

/** Discriminated transitions applied by {@link transitionIssue}. */
export type IssueStateTransition =
  | {
      kind: 'verified';
      autoVerifiedFrom?: string;
      /** When true, do not add to {@link StateContext.verifiedThisSession} (e.g. git recovery of old `prr-fix:` commits). */
      skipSessionTracking?: boolean;
      /** When true, refresh timestamps even in the same iteration (legacy {@link StateManager.markCommentVerifiedFixed}). */
      forceVerificationRefresh?: boolean;
    }
  | {
      kind: 'dismissed';
      reason: string;
      category: DismissedIssue['category'];
      filePath: string;
      line: number | null;
      commentBody: string;
      remediationHint?: string;
      /**
       * When true, remove any existing dismissed row for this comment before adding.
       * WHY: {@link StateManager.addDismissedIssue} replaces the record; {@link dismissIssue} is idempotent (skip push if already dismissed).
       */
      replaceExistingDismissal?: boolean;
    }
  | { kind: 'unverified' }
  | { kind: 'undismissed' };

function clearApplyFailureState(state: ReturnType<typeof getState>, commentId: string): void {
  if (state.lastApplyErrorByCommentId?.[commentId] !== undefined) {
    delete state.lastApplyErrorByCommentId[commentId];
  }
  if (state.applyFailureCountByCommentId?.[commentId] !== undefined) {
    delete state.applyFailureCountByCommentId[commentId];
  }
}

function removeFromVerifiedArrays(state: ReturnType<typeof getState>, ctx: StateContext, commentId: string): void {
  if (!state.verifiedComments) {
    state.verifiedComments = [];
  }
  const vIndex = state.verifiedComments.findIndex((v) => v.commentId === commentId);
  if (vIndex !== -1) {
    state.verifiedComments.splice(vIndex, 1);
  }
  const legacyIndex = (state.verifiedFixed ?? []).indexOf(commentId);
  if (legacyIndex !== -1) {
    (state.verifiedFixed ??= []).splice(legacyIndex, 1);
  }
  if (state.commentStatuses?.[commentId]) {
    delete state.commentStatuses[commentId];
  }
  ctx.verifiedThisSession?.delete(commentId);
}

/**
 * Apply a single comment lifecycle transition (verified, dismissed, or unverified).
 * Callers should use {@link markVerified}, {@link dismissIssue}, {@link unmarkVerified} unless testing this layer.
 */
export function transitionIssue(ctx: StateContext, commentId: string, tr: IssueStateTransition): void {
  const state = getState(ctx);

  switch (tr.kind) {
    case 'unverified': {
      removeFromVerifiedArrays(state, ctx, commentId);
      debug('transitionIssue: unverified', { commentId, remainingVerified: (state.verifiedFixed ?? []).length });
      return;
    }

    case 'undismissed': {
      if (!state.dismissedIssues?.length) {
        return;
      }
      const uIndex = state.dismissedIssues.findIndex((d) => d.commentId === commentId);
      if (uIndex !== -1) {
        state.dismissedIssues.splice(uIndex, 1);
      }
      if (state.commentStatuses?.[commentId]) {
        delete state.commentStatuses[commentId];
      }
      return;
    }

    case 'dismissed': {
      if (!state.dismissedIssues) {
        state.dismissedIssues = [];
      }
      const currentIteration = state.iterations.length;

      if (state.verifiedFixed?.length) {
        state.verifiedFixed = state.verifiedFixed.filter((id) => id !== commentId);
      }
      if (state.verifiedComments?.length) {
        const index = state.verifiedComments.findIndex((v) => v.commentId === commentId);
        if (index !== -1) {
          state.verifiedComments.splice(index, 1);
        }
      }

      if (tr.replaceExistingDismissal && state.dismissedIssues.length > 0) {
        state.dismissedIssues = state.dismissedIssues.filter((d) => d.commentId !== commentId);
      }

      const existing = state.dismissedIssues.find((d) => d.commentId === commentId);
      if (!existing) {
        const entry: DismissedIssue = {
          commentId,
          reason: tr.reason,
          dismissedAt: new Date().toISOString(),
          dismissedAtIteration: currentIteration,
          category: tr.category,
          filePath: tr.filePath,
          line: tr.line,
          commentBody: tr.commentBody,
        };
        if (tr.remediationHint !== undefined) entry.remediationHint = tr.remediationHint;
        state.dismissedIssues.push(entry);
      }

      if (state.commentStatuses?.[commentId]) {
        state.commentStatuses[commentId] = {
          ...state.commentStatuses[commentId],
          status: 'resolved',
          classification: 'stale',
          dismissCategory: tr.category,
          updatedAt: new Date().toISOString(),
          updatedAtIteration: currentIteration,
        };
      }
      ctx.verifiedThisSession?.delete(commentId);
      return;
    }

    case 'verified': {
      if (!state.verifiedComments) {
        state.verifiedComments = [];
      }

      const currentIteration = state.iterations.length;
      const existing = state.verifiedComments.find((v) => v.commentId === commentId);

      if (existing) {
        const hadDismissed = state.dismissedIssues?.some((d) => d.commentId === commentId) ?? false;
        const sameIteration = existing.verifiedAtIteration === currentIteration;
        const fromCompatible =
          tr.autoVerifiedFrom === undefined || tr.autoVerifiedFrom === existing.autoVerifiedFrom;
        if (!tr.forceVerificationRefresh && sameIteration && fromCompatible && !hadDismissed) {
          return;
        }
        existing.verifiedAt = new Date().toISOString();
        existing.verifiedAtIteration = currentIteration;
        if (tr.autoVerifiedFrom !== undefined) {
          existing.autoVerifiedFrom = tr.autoVerifiedFrom;
        }
        if (state.dismissedIssues?.length) {
          const before = state.dismissedIssues.length;
          state.dismissedIssues = state.dismissedIssues.filter((d) => d.commentId !== commentId);
          if (state.dismissedIssues.length < before) {
            debug('transitionIssue: verified (update) removed from dismissed', { commentId });
          }
        }
        debug('transitionIssue: verified (update)', {
          commentId,
          iteration: currentIteration,
          autoVerifiedFrom: tr.autoVerifiedFrom,
        });
      } else {
        state.verifiedComments.push({
          commentId,
          verifiedAt: new Date().toISOString(),
          verifiedAtIteration: currentIteration,
          autoVerifiedFrom: tr.autoVerifiedFrom,
        });

        if (!(state.verifiedFixed ??= []).includes(commentId)) {
          state.verifiedFixed.push(commentId);
        }
        if (state.dismissedIssues?.length) {
          state.dismissedIssues = state.dismissedIssues.filter((d) => d.commentId !== commentId);
        }
        debug('transitionIssue: verified (new)', {
          commentId,
          iteration: currentIteration,
          autoVerifiedFrom: tr.autoVerifiedFrom,
          totalVerified: state.verifiedFixed.length,
        });
      }

      if (state.commentStatuses?.[commentId]) {
        state.commentStatuses[commentId] = {
          ...state.commentStatuses[commentId],
          status: 'resolved',
          classification: 'fixed',
          updatedAt: new Date().toISOString(),
          updatedAtIteration: currentIteration,
        };
      }

      clearApplyFailureState(state, commentId);

      if (!tr.skipSessionTracking) {
        ctx.verifiedThisSession?.add(commentId);
      }
      return;
    }
  }
}
