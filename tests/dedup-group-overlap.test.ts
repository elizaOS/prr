import { describe, it, expect } from 'vitest';
import { resolveOverlappingDedupGroupsByIndex } from '../tools/prr/workflow/issue-analysis-dedup.js';
import type { ReviewComment } from '../tools/prr/github/types.js';

function c(id: string, line: number | null, body = 'x'): { comment: ReviewComment; codeSnippet: string } {
  return {
    comment: {
      id,
      path: 'f.ts',
      line,
      body,
      author: 'bot',
      threadId: `t-${id}`,
      databaseId: 1,
      createdAt: new Date().toISOString(),
    } as ReviewComment,
    codeSnippet: '',
  };
}

describe('resolveOverlappingDedupGroupsByIndex', () => {
  it('keeps first group when the same index appears in a later GROUP', () => {
    const items = [c('a', 1, 'longer body wins if needed'), c('b', 1), c('c', 2)];
    const groups = [
      { canonical: items[0]!, dupes: [items[1]!] },
      { canonical: items[2]!, dupes: [items[1]!] },
    ];
    const out = resolveOverlappingDedupGroupsByIndex(groups, items);
    expect(out).toHaveLength(1);
    expect(out[0]!.canonical.comment.id).toBe('a');
    expect(out[0]!.dupes.map((d) => d.comment.id).sort()).toEqual(['b']);
  });

  it('keeps two disjoint groups', () => {
    const items = [c('a', 1), c('b', 1), c('c', 2), c('d', 2)];
    const groups = [
      { canonical: items[0]!, dupes: [items[1]!] },
      { canonical: items[2]!, dupes: [items[3]!] },
    ];
    const out = resolveOverlappingDedupGroupsByIndex(groups, items);
    expect(out).toHaveLength(2);
  });
});
