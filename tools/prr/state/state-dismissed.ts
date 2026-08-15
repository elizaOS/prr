/**
 * Dismissed issues tracking — records comments determined not to need fixing.
 *
 * WHY dismissal instead of just skipping: Dismissal is a deliberate decision
 * with a documented reason (stale file, false positive, remaining, etc.).
 * This enables:
 * 1. Transparency: humans can see WHY an issue was skipped, not just that it was
 * 2. Feedback loop: patterns in dismissed issues reveal what the system struggles with
 * 3. Reversibility: undismissIssue() re-opens a comment for fresh analysis
 * 4. Dialog: the After Action Report uses dismissal reasons to explain partial progress
 *
 * WHY separate from verified: Verified means "we fixed it and confirmed the fix."
 * Dismissed means "we decided not to fix it" — the issue may still exist in code.
 * The distinction matters for reporting: dismissed issues need human attention,
 * verified ones don't.
 *
 * {@link dismissIssue} delegates to {@link transitionIssue} so verified arrays
 * and commentStatuses stay consistent.
 */
import type { StateContext } from './state-context.js';
import type { DismissedIssue } from './types.js';
import { transitionIssue } from './state-transitions.js';

/**
 * Dismiss a comment — record that it doesn't need fixing, with a reason.
 *
 * WHY we store the full commentBody: The After Action Report and handoff
 * prompt need to show humans what was dismissed. Without the body, they'd
 * have to look up each comment on GitHub to understand what was skipped.
 *
 * WHY idempotent (skip if existing): dismissIssue() is called from multiple
 * paths (solvability check, stale file detection, LLM "already fixed" verdict).
 * The same comment can hit multiple dismissal paths in one iteration. Dedup
 * by commentId prevents duplicate entries that inflate dismissed counts.
 */
export function dismissIssue(
  ctx: StateContext,
  commentId: string,
  reason: string,
  category: DismissedIssue['category'],
  filePath: string,
  line: number | null,
  commentBody: string,
  remediationHint?: string
): void {
  transitionIssue(ctx, commentId, {
    kind: 'dismissed',
    reason,
    category,
    filePath,
    line,
    commentBody,
    remediationHint,
  });
}

/**
 * Un-dismiss a comment — re-open it for fresh analysis.
 *
 * WHY this exists: When a previously stale file reappears (reverted, re-added),
 * the comment should be re-analyzed. Also used when --reverify is passed to
 * force a clean slate.
 */
export function undismissIssue(ctx: StateContext, commentId: string): void {
  transitionIssue(ctx, commentId, { kind: 'undismissed' });
}

export function getDismissedIssues(ctx: StateContext): DismissedIssue[] {
  return ctx.state?.dismissedIssues ?? [];
}

export function isCommentDismissed(ctx: StateContext, commentId: string): boolean {
  const state = ctx.state;
  if (!state?.dismissedIssues) {
    return false;
  }

  return state.dismissedIssues.some((d) => d.commentId === commentId);
}

/** Get the dismissed issue entry for a comment, if any. Used to preserve category/reason on re-dismiss. */
export function getDismissedIssue(ctx: StateContext, commentId: string): DismissedIssue | undefined {
  const state = ctx.state;
  if (!state?.dismissedIssues) return undefined;
  return state.dismissedIssues.find((d) => d.commentId === commentId);
}
