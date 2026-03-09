import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
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

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
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

  it('keeps missing test files solvable as create-file issues', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const stateContext = makeStateContext(dir);
    const comment: ReviewComment = {
      id: 'c-create-test',
      threadId: 'thread-create-test',
      author: 'Claude',
      path: 'src/__tests__/widget.test.ts',
      line: null,
      createdAt: new Date().toISOString(),
      body: 'Add tests for the new widget behavior by creating `src/__tests__/widget.test.ts`.',
    };

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe('src/__tests__/widget.test.ts');
    expect(result.contextHints?.[0]).toContain('create-file issue');
  });

  it('keeps existing test-file targets even when the wording is coverage-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const stateContext = makeStateContext(dir);
    const comment: ReviewComment = {
      id: 'c-coverage-only-test-path',
      threadId: 'thread-coverage-only-test-path',
      author: 'Claude',
      path: 'src/message-service.test.ts',
      line: 830,
      createdAt: new Date().toISOString(),
      body: 'Edge-case coverage is still missing here.',
    };

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe('src/message-service.test.ts');
    expect(result.contextHints?.[0]).toContain('create-file issue');
  });

  it('redirects source-file missing-test comments to an inferred create-file target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'reply.ts'), 'export function reply() { return true; }\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });

    const stateContext = makeStateContext(dir);
    const comment: ReviewComment = {
      id: 'c-source-needs-tests',
      threadId: 'thread-source-needs-tests',
      author: 'Claude',
      path: 'src/reply.ts',
      line: 12,
      createdAt: new Date().toISOString(),
      body: 'The new reply flow has no tests. Add tests for this behavior.',
    };

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe('src/reply.test.ts');
    expect(result.contextHints?.[0]).toContain('create-file issue');
  });

  it('preserves explicit backticked test filenames when inferring create-file targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'runtime.ts'), 'export function runtime() { return true; }\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });

    const stateContext = makeStateContext(dir);
    const comment: ReviewComment = {
      id: 'c-source-explicit-test-name',
      threadId: 'thread-source-explicit-test-name',
      author: 'Claude',
      path: 'src/runtime.ts',
      line: 10,
      createdAt: new Date().toISOString(),
      body: 'Add tests in `message-service.test.ts` for this new runtime path.',
    };

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe('src/message-service.test.ts');
    expect(result.contextHints?.[0]).toContain('create-file issue');
  });

  it('keeps line-drift issues open when the only extracted identifier is a weak built-in type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'types.ts'), 'export type JsonValue = string | number | boolean | null;\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });

    const stateContext = makeStateContext(dir);
    const comment: ReviewComment = {
      id: 'c-weak-identifier',
      threadId: 'thread-weak-identifier',
      author: 'Claude',
      path: 'src/types.ts',
      line: 97,
      createdAt: new Date().toISOString(),
      body: 'The `BigInt` handling path still needs coverage here.',
    };

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(true);
    expect(result.dismissCategory).toBeUndefined();
    expect(result.contextHints?.[0]).toContain('only weak built-in/type identifiers');
  });

  it('categorizes ambiguous basename paths as path-unresolved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const a = join(dir, 'packages/a/src');
    const b = join(dir, 'packages/b/src');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'logger.ts'), 'export const a = 1;\n', 'utf-8');
    writeFileSync(join(b, 'logger.ts'), 'export const b = 1;\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });

    const stateContext = makeStateContext(dir);
    const comment: ReviewComment = {
      id: 'c-ambiguous',
      threadId: 'thread-ambiguous',
      author: 'Claude',
      path: 'logger.ts',
      line: null,
      createdAt: new Date().toISOString(),
      body: 'Add documentation for logger.ts.',
    };

    const result = assessSolvability(dir, comment, stateContext);

    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('path-unresolved');
    expect(result.reason).toContain('Ambiguous review path');
  });
});
