import { describe, expect, it } from 'vitest';
import {
  applyDismissedIssuesLoadNormalization,
  dedupeDismissedIssuesByCommentId,
} from '../tools/prr/state/state-core.js';
import type { DismissedIssue } from '../tools/prr/state/types.js';

function row(
  id: string,
  at: string,
  cat: DismissedIssue['category'],
  path = 'x.ts',
): DismissedIssue {
  return {
    commentId: id,
    reason: 'r',
    dismissedAt: at,
    dismissedAtIteration: 1,
    category: cat,
    filePath: path,
    line: null,
    commentBody: 'b',
  };
}

describe('dedupeDismissedIssuesByCommentId', () => {
  it('returns the same array when length <= 1', () => {
    const a = row('ic1', '2026-01-01T00:00:00Z', 'stale');
    expect(dedupeDismissedIssuesByCommentId([])).toEqual({ merged: [], removedCount: 0 });
    expect(dedupeDismissedIssuesByCommentId([a])).toEqual({ merged: [a], removedCount: 0 });
  });

  it('keeps latest dismissedAt for duplicate comment ids', () => {
    const older = row('ic_dup', '2026-01-01T00:00:00Z', 'missing-file');
    const newer = row('ic_dup', '2026-02-01T00:00:00Z', 'path-unresolved');
    const { merged, removedCount } = dedupeDismissedIssuesByCommentId([older, newer]);
    expect(removedCount).toBe(1);
    expect(merged).toEqual([newer]);
  });

  it('on same timestamp prefers path-fragment over missing-file', () => {
    const a = row('ic_t', '2026-01-02T12:00:00Z', 'missing-file');
    const b = row('ic_t', '2026-01-02T12:00:00Z', 'path-fragment');
    const { merged, removedCount } = dedupeDismissedIssuesByCommentId([a, b]);
    expect(removedCount).toBe(1);
    expect(merged[0]!.category).toBe('path-fragment');
  });

  it('preserves first-seen order of unique ids', () => {
    const x = row('ic_x', '2026-01-01T00:00:00Z', 'stale');
    const y = row('ic_y', '2026-01-01T00:00:00Z', 'stale');
    const { merged } = dedupeDismissedIssuesByCommentId([x, y]);
    expect(merged.map((d) => d.commentId)).toEqual(['ic_x', 'ic_y']);
  });
});

describe('applyDismissedIssuesLoadNormalization', () => {
  it('normalizes fragment paths then dedupes by comment id', () => {
    const dupOlder = {
      ...row('ic_d', '2026-01-01T00:00:00Z', 'missing-file', '.d.ts'),
      reason: 'Tracked file not found for review path: .d.ts',
    };
    const dupNewer = row('ic_d', '2026-02-01T00:00:00Z', 'path-unresolved', '.d.ts');
    const { list, fragmentNormalized, dedupeRemoved } = applyDismissedIssuesLoadNormalization([dupOlder, dupNewer]);
    expect(fragmentNormalized).toBe(2);
    expect(dedupeRemoved).toBe(1);
    expect(list).toHaveLength(1);
    expect(list[0]!.category).toBe('path-fragment');
    expect(list[0]!.dismissedAt).toBe('2026-02-01T00:00:00Z');
  });
});
