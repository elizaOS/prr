import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Ora } from 'ora';
import type { GitHubAPI } from '../tools/prr/github/api.js';
import type { ReviewComment } from '../tools/prr/github/types.js';
import type { StateContext } from '../tools/prr/state/state-context.js';
import { createInitialState } from '../tools/prr/state/types.js';
import { getDismissedIssues } from '../tools/prr/state/state-dismissed.js';
import { assessSolvability } from '../tools/prr/workflow/helpers/solvability.js';
import { checkForNewComments } from '../tools/prr/workflow/analysis.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateContext(workdir: string): StateContext {
  return {
    statePath: join(workdir, '.pr-resolver-state.json'),
    state: createInitialState('owner/repo#1', 'feature', 'abc123'),
    currentPhase: 'test',
  };
}

function makeProgressComment(id: string): ReviewComment {
  return {
    id,
    threadId: `thread-${id}`,
    author: 'Claude',
    path: 'CLAUDE.md',
    line: null,
    createdAt: new Date().toISOString(),
    body: `### PR Review in Progress

- [x] Read repository guidelines (CLAUDE.md)
- [x] Review existing feedback from other reviewers
- [ ] Analyze changed files and PR diff
- [ ] Check for tests
- [ ] Review code for security, types, and patterns
- [ ] Provide consolidated review feedback

---

[View job run](https://github.com/example/repo/actions/runs/123456789)`,
  };
}

describe('non-actionable bot comment filtering', () => {
  it('dismisses bot progress checklist comments during solvability assessment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-non-actionable-'));
    tempDirs.push(dir);

    const comment = makeProgressComment('c1');
    const stateContext = makeStateContext(dir);

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
    expect(result.reason).toContain('Bot progress/checklist comment');
  });

  it('does not add non-actionable new comments to the unresolved queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-non-actionable-'));
    tempDirs.push(dir);

    const comment = makeProgressComment('c2');
    const stateContext = makeStateContext(dir);
    const getCodeSnippet = vi.fn(async () => 'unused');
    const spinner = {
      start: vi.fn(),
      warn: vi.fn(),
      succeed: vi.fn(),
    } as unknown as Ora;
    const github = {
      getReviewComments: vi.fn(async () => [comment]),
    } as unknown as GitHubAPI;

    const result = await checkForNewComments(
      github,
      'owner',
      'repo',
      1,
      [],
      [],
      spinner,
      getCodeSnippet,
      stateContext,
      dir
    );

    expect(result.hasNewComments).toBe(false);
    expect(result.updatedUnresolvedIssues).toEqual([]);
    expect(getCodeSnippet).not.toHaveBeenCalled();
    expect(getDismissedIssues(stateContext)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commentId: 'c2',
          category: 'not-an-issue',
        }),
      ])
    );
  });
});
