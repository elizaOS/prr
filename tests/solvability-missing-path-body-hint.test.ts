import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { ReviewComment } from '../tools/prr/github/types.js';
import type { StateContext } from '../tools/prr/state/state-context.js';
import { createInitialState } from '../tools/prr/state/types.js';
import { assessSolvability } from '../tools/prr/workflow/helpers/solvability.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
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

describe('assessSolvability missing review path + body hints', () => {
  it('retargets when review path missing but body quotes exactly one tracked file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-missing-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    mkdirSync(join(dir, 'packages', 'foo', 'src'), { recursive: true });
    const good = 'packages/foo/src/real-target.ts';
    writeFileSync(join(dir, good), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['add', good], { cwd: dir, stdio: 'ignore' });

    const comment: ReviewComment = {
      id: 'ic-miss-1',
      threadId: 't-1',
      author: 'greptile-apps[bot]',
      path: 'packages/typescript/src/optimization/ab-analysis.ts',
      line: 10,
      createdAt: new Date().toISOString(),
      body: 'Duplicate logic — see `packages/foo/src/real-target.ts` line 42.',
    };

    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe(good);
    expect(result.contextHints?.some((h) => h.includes('single path inferred'))).toBe(true);
  });

  it('does not retarget when body hints resolve to zero or multiple tracked files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-missing-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    mkdirSync(join(dir, 'packages', 'a', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'b', 'src'), { recursive: true });
    const p1 = 'packages/a/src/one.ts';
    const p2 = 'packages/b/src/two.ts';
    writeFileSync(join(dir, p1), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dir, p2), 'export const b = 2;\n', 'utf8');
    execFileSync('git', ['add', p1, p2], { cwd: dir, stdio: 'ignore' });

    const comment: ReviewComment = {
      id: 'ic-miss-2',
      threadId: 't-2',
      author: 'bot',
      path: 'ghost/missing.ts',
      line: 1,
      createdAt: new Date().toISOString(),
      body: `Compare \`packages/a/src/one.ts\` and \`packages/b/src/two.ts\`.`,
    };

    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('missing-file');
  });
});
