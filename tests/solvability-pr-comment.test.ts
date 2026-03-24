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

describe('(PR comment) path inference in solvability', () => {
  it('resolves (PR comment) to solvable when body contains path hint that matches a single file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-pr-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    const filePath = 'apps/web/TickerClient.tsx';
    writeFileSync(join(dir, filePath), 'export {};\n', 'utf8');
    execFileSync('git', ['add', filePath], { cwd: dir, stdio: 'ignore' });

    const comment: ReviewComment = {
      id: 'ic-123',
      threadId: 't-1',
      author: 'copilot',
      path: '(PR comment)',
      line: null,
      createdAt: new Date().toISOString(),
      body: '2. **Non-null assertion (line 290)**: While the `isPrediction` guard makes this safe, consider avoiding `item.yesPercent!` in `TickerClient.tsx`.',
    };

    const result = assessSolvability(dir, comment, makeStateContext(dir));

    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe(filePath);
    expect(result.retargetedLine).toBe(290);
  });

  it('resolves (PR comment) when body contains full path with slashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-pr-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    mkdirSync(join(dir, 'apps', 'web', 'src'), { recursive: true });
    const filePath = 'apps/web/src/TickerClient.tsx';
    writeFileSync(join(dir, filePath), '// code\n', 'utf8');
    execFileSync('git', ['add', filePath], { cwd: dir, stdio: 'ignore' });

    const comment: ReviewComment = {
      id: 'ic-456',
      threadId: 't-2',
      author: 'bot',
      path: '(PR comment)',
      line: null,
      createdAt: new Date().toISOString(),
      body: '**Light Mode Fill Color (Lines 127-129)** — see `apps/web/src/TickerClient.tsx`.',
    };

    const result = assessSolvability(dir, comment, makeStateContext(dir));

    expect(result.solvable).toBe(true);
    expect(result.resolvedPath).toBe(filePath);
    expect(result.retargetedLine).toBe(129);
  });

  it('dismisses (PR comment) when body has no path hints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-pr-'));
    tempDirs.push(dir);
    initGitRepo(dir);

    const comment: ReviewComment = {
      id: 'ic-789',
      threadId: 't-3',
      author: 'bot',
      path: '(PR comment)',
      line: null,
      createdAt: new Date().toISOString(),
      body: '### Test Coverage\n\nNo tests were added for the new helper functions.',
    };

    const result = assessSolvability(dir, comment, makeStateContext(dir));

    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
    expect(result.reason).toContain('(PR comment)');
  });

  it('dismisses (PR comment) when path hint does not match any tracked file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solvability-pr-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    writeFileSync(join(dir, 'README.md'), '# Hi\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });

    const comment: ReviewComment = {
      id: 'ic-none',
      threadId: 't-4',
      author: 'bot',
      path: '(PR comment)',
      line: null,
      createdAt: new Date().toISOString(),
      body: 'Fix the bug in `nonexistent/OtherFile.tsx` at line 10.',
    };

    const result = assessSolvability(dir, comment, makeStateContext(dir));

    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
  });
});

describe('human-confirmed addressed (solvability 0a5b)', () => {
  it('dismisses when maintainer confirmed the thread is addressed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-confirmed-'));
    tempDirs.push(dir);
    const comment: ReviewComment = {
      id: 'c-conf',
      threadId: 't-conf',
      author: 'coderabbitai',
      path: 'packages/foo.ts',
      line: 12,
      createdAt: new Date().toISOString(),
      body: '_Potential issue_\n\n**Trim order**\n\n✅ Confirmed as addressed by @odilitime',
    };
    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
    expect(result.reason).toMatch(/confirmed issue already addressed/i);
  });

  it('does not dismiss when text says not confirmed as addressed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-not-conf-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    writeFileSync(join(dir, 'x.ts'), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['add', 'x.ts'], { cwd: dir, stdio: 'ignore' });
    const comment: ReviewComment = {
      id: 'c-nc',
      threadId: 't-nc',
      author: 'bot',
      path: 'x.ts',
      line: 1,
      createdAt: new Date().toISOString(),
      body: 'Not confirmed as addressed — please fix the race condition.',
    };
    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.dismissCategory).not.toBe('not-an-issue');
    expect(result.reason ?? '').not.toMatch(/confirmed issue already addressed/i);
    expect(result.solvable).toBe(true);
  });
});
