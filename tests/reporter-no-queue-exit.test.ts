import { describe, expect, it } from 'vitest';
import type { StateContext } from '../tools/prr/state/state-context.js';
import { isNoFixQueueSummaryExit } from '../tools/prr/ui/reporter.js';

function ctx(commentIds: Set<string> | undefined): StateContext {
  return { state: { verifiedFixed: [] }, currentCommentIds: commentIds } as unknown as StateContext;
}

describe('isNoFixQueueSummaryExit', () => {
  it('returns true for setup exits regardless of comment load', () => {
    expect(isNoFixQueueSummaryExit('init_failed', null)).toBe(true);
    expect(isNoFixQueueSummaryExit('sync_failed', ctx(new Set()))).toBe(true);
    expect(isNoFixQueueSummaryExit('stale_bot_review', ctx(undefined))).toBe(true);
    expect(isNoFixQueueSummaryExit('github_unmergeable', null)).toBe(true);
  });

  it('treats error as setup-only when currentCommentIds was never set', () => {
    expect(isNoFixQueueSummaryExit('error', null)).toBe(true);
    expect(isNoFixQueueSummaryExit('error', ctx(undefined))).toBe(true);
  });

  it('treats error as not setup-only after comment ids exist (orchestrator catch-all)', () => {
    expect(isNoFixQueueSummaryExit('error', ctx(new Set()))).toBe(false);
  });

  it('returns false for normal queue outcomes', () => {
    expect(isNoFixQueueSummaryExit('all_fixed', null)).toBe(false);
    expect(isNoFixQueueSummaryExit('no_comments', ctx(undefined))).toBe(false);
    expect(isNoFixQueueSummaryExit('merge_conflicts', null)).toBe(false);
    expect(isNoFixQueueSummaryExit(null, null)).toBe(false);
  });
});
