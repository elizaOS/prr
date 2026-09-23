import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../tools/prr/github/types.js';
import type { UnresolvedIssue } from '../tools/prr/analyzer/types.js';
import { sortByPriority } from '../tools/prr/analyzer/severity.js';

function makeIssue(id: string, author: string, importance = 3): UnresolvedIssue {
  const comment: ReviewComment = {
    id,
    threadId: `t-${id}`,
    author,
    path: 'a.ts',
    line: 1,
    createdAt: new Date().toISOString(),
    body: 'x',
  };
  return {
    comment,
    codeSnippet: '// x',
    stillExists: true,
    explanation: '',
    triage: { importance, ease: 3 },
  };
}

describe('sortByPriority stale inline bot deprioritization', () => {
  it('places human authors before inline review bots when staleBotInlineReviewVsHead', () => {
    const human = makeIssue('h1', 'alice', 3);
    const rabbit = makeIssue('r1', 'coderabbitai[bot]', 3);
    const sorted = sortByPriority([rabbit, human], 'important', { staleBotInlineReviewVsHead: true });
    expect(sorted[0]!.comment.author).toBe('alice');
    expect(sorted[1]!.comment.author).toContain('coderabbit');
  });

  it('does not reorder by author when stale flag is off', () => {
    const human = makeIssue('h1', 'alice', 3);
    const rabbit = makeIssue('r1', 'coderabbitai[bot]', 3);
    const sorted = sortByPriority([rabbit, human], 'important');
    expect(sorted[0]!.comment.id).toBe('r1');
    expect(sorted[1]!.comment.id).toBe('h1');
  });
});
