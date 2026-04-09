/**
 * ALREADY_FIXED no-change path: duplicate cluster must stay consistent with dismissed state
 * (no “empty queue + unaccounted cluster siblings”).
 */
import { describe, it, expect } from 'vitest';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import type { UnresolvedIssue } from '../tools/prr/analyzer/types.js';
import type { ReviewComment } from '../tools/prr/github/types.js';
import type { LLMClient } from '../tools/prr/llm/client.js';
import { handleNoChangesWithVerification } from '../tools/prr/workflow/no-changes-verification.js';
import { createLessonsContext } from '../tools/prr/state/lessons-context.js';
import * as Dismissed from '../tools/prr/state/state-dismissed.js';

function review(id: string): ReviewComment {
  return {
    id,
    threadId: 't1',
    author: 'bot',
    body: 'review body',
    path: 'packages/x.ts',
    line: 10,
    createdAt: '2020-01-01T00:00:00Z',
  };
}

function makeCtx(): StateContext {
  const state: ResolverState = {
    pr: 'o/r#1',
    branch: 'main',
    headSha: 'abc',
    startedAt: 's',
    lastUpdated: 'u',
    lessonsLearned: [],
    iterations: [{ timestamp: 't', commentsAddressed: [], changesMade: [], verificationResults: {} }],
    verifiedComments: [],
    verifiedFixed: [],
    dismissedIssues: [],
    commentStatuses: {},
  } as ResolverState;
  return {
    statePath: '/tmp/no-changes-cluster-test',
    state,
    currentPhase: 'test',
    verifiedThisSession: new Set<string>(),
  };
}

describe('handleNoChangesWithVerification ALREADY_FIXED cluster', () => {
  it('dismisses dedup siblings not present in comments using anchor row', async () => {
    const ctx = makeCtx();
    const anchor = review('comment-A');
    const issue: UnresolvedIssue = {
      comment: anchor,
      codeSnippet: 'code',
      stillExists: true,
      explanation: 'test',
    };
    const duplicateMap = new Map<string, string[]>([['comment-A', ['comment-B']]]);
    const lessons = createLessonsContext('o', 'r', 'main', '/tmp/lessons');
    const llm = {} as LLMClient;

    const result = await handleNoChangesWithVerification(
      [issue],
      'llm-api',
      'anthropic/test',
      'RESULT: ALREADY_FIXED — already ok',
      llm,
      ctx,
      lessons,
      ctx.verifiedThisSession!,
      () => null,
      undefined,
      [anchor],
      duplicateMap,
    );

    expect(result.updatedUnresolvedIssues).toHaveLength(0);
    expect(Dismissed.isCommentDismissed(ctx, 'comment-A')).toBe(true);
    expect(Dismissed.isCommentDismissed(ctx, 'comment-B')).toBe(true);
  });
});
