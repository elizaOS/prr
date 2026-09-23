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

describe('review rollup headings (solvability 0a2 — Cycle 72)', () => {
  it('dismisses "### Remaining Issues" recap anchored on a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-rollup-'));
    tempDirs.push(dir);
    initGitRepo(dir);
    mkdirSync(join(dir, 'agent'), { recursive: true });
    writeFileSync(join(dir, 'agent', 'x.ts'), 'export {};\n', 'utf8');
    execFileSync('git', ['add', 'agent/x.ts'], { cwd: dir, stdio: 'ignore' });
    const comment: ReviewComment = {
      id: 'ic-rollup-rem',
      threadId: 't-r1',
      author: 'coderabbitai',
      path: 'agent/x.ts',
      line: 1,
      createdAt: new Date().toISOString(),
      body: '### Remaining Issues\n\n- [ ] Thread A still open\n- [ ] Thread B still open\n',
    };
    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
    expect(result.reason).toMatch(/meta-review|rollup/i);
  });

  it('dismisses "Issues Fixed Since Previous Reviews" heading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-rollup-fix'));
    tempDirs.push(dir);
    initGitRepo(dir);
    writeFileSync(join(dir, 'z.ts'), 'export const z = 1;\n', 'utf8');
    execFileSync('git', ['add', 'z.ts'], { cwd: dir, stdio: 'ignore' });
    const comment: ReviewComment = {
      id: 'ic-rollup-fixed',
      threadId: 't-r2',
      author: 'coderabbitai',
      path: 'z.ts',
      line: 1,
      createdAt: new Date().toISOString(),
      body: '## Issues Fixed Since Previous Reviews\n\n✅ Item one\n',
    };
    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
  });

  it('dismisses bold-only "Issues Fixed Since Previous Reviews" (no # heading)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-rollup-bold'));
    tempDirs.push(dir);
    initGitRepo(dir);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    execFileSync('git', ['add', 'a.ts'], { cwd: dir, stdio: 'ignore' });
    const comment: ReviewComment = {
      id: 'ic-rollup-bold',
      threadId: 't-r2b',
      author: 'coderabbitai',
      path: 'a.ts',
      line: 1,
      createdAt: new Date().toISOString(),
      body: '**Issues Fixed Since Previous Reviews**\n\n- ✅ Thread one addressed\n',
    };
    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
  });

  it('dismisses HTML h3 "Issues Fixed Since Previous Reviews"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-rollup-html'));
    tempDirs.push(dir);
    initGitRepo(dir);
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n', 'utf8');
    execFileSync('git', ['add', 'b.ts'], { cwd: dir, stdio: 'ignore' });
    const comment: ReviewComment = {
      id: 'ic-rollup-html',
      threadId: 't-r2h',
      author: 'coderabbitai',
      path: 'b.ts',
      line: 1,
      createdAt: new Date().toISOString(),
      body: '<h3>Issues Fixed Since Previous Reviews</h3>\n<p>Recap only.</p>\n',
    };
    const result = assessSolvability(dir, comment, makeStateContext(dir));
    expect(result.solvable).toBe(false);
    expect(result.dismissCategory).toBe('not-an-issue');
  });

  it('dismisses (PR comment) with rollup heading before path inference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-solv-rollup-pr'));
    tempDirs.push(dir);
    initGitRepo(dir);
    const longBody =
      '### Remaining Issues\n\n' +
      '- [ ] a\n'.repeat(20) +
      'Some filler so body length exceeds short-path threshold.';
    const comment: ReviewComment = {
      id: 'ic-rollup-pr',
      threadId: 't-r3',
      author: 'coderabbitai',
      path: '(PR comment)',
      line: null,
      createdAt: new Date().toISOString(),
      body: longBody,
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
