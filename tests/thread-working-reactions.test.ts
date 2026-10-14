import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UnresolvedIssue } from '../tools/prr/analyzer/types.js';
import type { CLIOptions } from '../tools/prr/cli.js';
import type { PRInfo } from '../tools/prr/github/types.js';
import { createStateContext } from '../tools/prr/state/state-context.js';
import {
  createThreadWorkingReactionPoster,
  parseThreadWorkingReactionMinMsFromEnv,
} from '../tools/prr/workflow/thread-working-reactions.js';
import * as logger from '../shared/logger.js';
import * as workflowUtils from '../tools/prr/workflow/utils.js';

function baseIssue(databaseId: number): UnresolvedIssue {
  return {
    comment: {
      id: `c-${databaseId}`,
      threadId: 'PRRT_t',
      author: 'reviewer',
      body: 'fix me',
      path: 'src/a.ts',
      line: 1,
      createdAt: '2020-01-01',
      databaseId,
    },
    codeSnippet: '',
    stillExists: true,
    explanation: '',
  };
}

const prInfo: PRInfo = {
  owner: 'o',
  repo: 'r',
  number: 1,
  title: 't',
  body: '',
  branch: 'f',
  baseBranch: 'main',
  headSha: 'abc',
  cloneUrl: 'https://github.com/o/r.git',
  mergeable: true,
  mergeableState: 'clean',
};

function baseCli(over: Partial<CLIOptions> = {}): CLIOptions {
  return {
    tool: undefined,
    toolModel: undefined,
    codexAddDir: [],
    autoPush: true,
    keepWorkdir: true,
    maxFixIterations: 0,
    maxPushIterations: 0,
    maxStaleCycles: 1,
    pollInterval: 60,
    dryRun: false,
    noCommit: false,
    noPush: false,
    verbose: false,
    noBatch: false,
    reverify: false,
    maxContextChars: 1000,
    noBell: false,
    mergeBase: true,
    incrementalCommits: true,
    commitPerFile: true,
    noHandoffPrompt: false,
    noAfterAction: false,
    modelRotation: false,
    noClaudeMd: false,
    noAgentsMd: false,
    cleanClaudeMd: false,
    cleanAgentsMd: false,
    cleanState: false,
    cleanAll: false,
    noLock: false,
    priorityOrder: 'important',
    clearLock: false,
    checkTools: false,
    updateTools: false,
    tidyLessons: false,
    predictBots: false,
    noWaitBot: false,
    pill: false,
    replyToThreads: false,
    resolveThreads: false,
    threadWorkingReactions: true,
    ...over,
  };
}

describe('parseThreadWorkingReactionMinMsFromEnv', () => {
  afterEach(() => {
    delete process.env.PRR_THREAD_WORKING_REACTION_MIN_MS;
  });

  it('defaults to 1000 when unset', () => {
    expect(parseThreadWorkingReactionMinMsFromEnv()).toBe(1000);
  });

  it('parses valid positive integer', () => {
    process.env.PRR_THREAD_WORKING_REACTION_MIN_MS = '750';
    expect(parseThreadWorkingReactionMinMsFromEnv()).toBe(750);
  });

  it('returns 1000 for invalid', () => {
    process.env.PRR_THREAD_WORKING_REACTION_MIN_MS = 'nope';
    expect(parseThreadWorkingReactionMinMsFromEnv()).toBe(1000);
  });
});

describe('createThreadWorkingReactionPoster', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.PRR_THREAD_WORKING_REACTION_MIN_MS;
  });

  it('dedupes same databaseId in one notify call', async () => {
    const reaction = vi.fn().mockResolvedValue('created');
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test');
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli(), ctx, {
      hasGithubToken: true,
    });
    await poster.notifyIssuesFocused([baseIssue(42), baseIssue(42)]);
    expect(reaction).toHaveBeenCalledTimes(1);
    expect(reaction).toHaveBeenCalledWith('o', 'r', 42, 'eyes');
  });

  it('respects min spacing between distinct ids (sleeps until spacing)', async () => {
    process.env.PRR_THREAD_WORKING_REACTION_MIN_MS = '1000';
    const reaction = vi.fn().mockResolvedValue('created');
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-2');
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleepSpy = vi.spyOn(workflowUtils, 'sleep').mockResolvedValue(undefined);
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli(), ctx, {
      hasGithubToken: true,
    });
    await poster.notifyIssuesFocused([baseIssue(1)]);
    expect(reaction).toHaveBeenCalledTimes(1);
    now += 500;
    await poster.notifyIssuesFocused([baseIssue(2)]);
    expect(sleepSpy).toHaveBeenCalledWith(500);
    expect(reaction).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
    sleepSpy.mockRestore();
  });

  it('short-circuits when threadWorkingReactions is off', async () => {
    const reaction = vi.fn();
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-3');
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli({ threadWorkingReactions: false }), ctx, {
      hasGithubToken: true,
    });
    await poster.notifyIssuesFocused([baseIssue(9)]);
    expect(reaction).not.toHaveBeenCalled();
  });

  it('disables after repeated rate_limited and skips further posts', async () => {
    process.env.PRR_THREAD_WORKING_REACTION_MIN_MS = '0';
    const reaction = vi.fn().mockResolvedValue('rate_limited');
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-4');
    const sleepSpy = vi.spyOn(workflowUtils, 'sleep').mockResolvedValue(undefined);
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli(), ctx, {
      hasGithubToken: true,
    });
    await poster.notifyIssuesFocused([baseIssue(100), baseIssue(200)]);
    expect(reaction.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warnSpy).toHaveBeenCalled();
    reaction.mockClear();
    await poster.notifyIssuesFocused([baseIssue(300)]);
    expect(reaction).not.toHaveBeenCalled();
    sleepSpy.mockRestore();
  });

  it('skips when no github token flag', async () => {
    const reaction = vi.fn();
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-5');
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli(), ctx, {
      hasGithubToken: false,
    });
    await poster.notifyIssuesFocused([baseIssue(7)]);
    expect(reaction).not.toHaveBeenCalled();
  });

  it('skips when dry-run', async () => {
    const reaction = vi.fn();
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-6');
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli({ dryRun: true }), ctx, {
      hasGithubToken: true,
    });
    await poster.notifyIssuesFocused([baseIssue(8)]);
    expect(reaction).not.toHaveBeenCalled();
  });

  it('disables on first hard error and does not POST for remaining ids in the same batch', async () => {
    process.env.PRR_THREAD_WORKING_REACTION_MIN_MS = '0';
    const reaction = vi.fn().mockResolvedValueOnce('error');
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-7');
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli(), ctx, { hasGithubToken: true });
    await poster.notifyIssuesFocused([baseIssue(11), baseIssue(22)]);
    expect(reaction).toHaveBeenCalledTimes(1);
    expect(reaction).toHaveBeenCalledWith('o', 'r', 11, 'eyes');
    expect(warnSpy).toHaveBeenCalled();
    reaction.mockClear();
    await poster.notifyIssuesFocused([baseIssue(33)]);
    expect(reaction).not.toHaveBeenCalled();
  });

  it('dedupes not_found so the same id is not POSTed again in the same run', async () => {
    process.env.PRR_THREAD_WORKING_REACTION_MIN_MS = '0';
    const reaction = vi.fn().mockResolvedValue('not_found');
    const github = { createPullRequestReviewCommentReaction: reaction } as any;
    const ctx = createStateContext('/tmp/prr-thread-reaction-test-8');
    const poster = createThreadWorkingReactionPoster(github, prInfo, baseCli(), ctx, { hasGithubToken: true });
    await poster.notifyIssuesFocused([baseIssue(55)]);
    await poster.notifyIssuesFocused([baseIssue(55)]);
    expect(reaction).toHaveBeenCalledTimes(1);
  });
});
