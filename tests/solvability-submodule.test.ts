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

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

describe('assessSolvability — git submodule path (0e0)', () => {
  it('dismisses comments on submodule paths as not-an-issue before snippet phase', () => {
    const parent = mkdtempSync(join(tmpdir(), 'prr-solv-sub-'));
    tempDirs.push(parent);
    const child = join(parent, 'child-repo');
    mkdirSync(child, { recursive: true });

    git(child, ['init', '-b', 'main']);
    writeFileSync(join(child, 'README.md'), '# child\n', 'utf8');
    git(child, ['add', 'README.md']);
    git(child, ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'init']);
    const childHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: child,
      encoding: 'utf8',
    }).trim();

    git(parent, ['init', '-b', 'main']);
    writeFileSync(join(parent, 'root.txt'), 'root\n', 'utf8');
    git(parent, ['add', 'root.txt']);
    git(parent, ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'root']);
    git(parent, ['update-index', '--add', '--cacheinfo', `160000,${childHead},plugins/plugin-sql`]);
    git(parent, ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'add gitlink']);

    const comment: ReviewComment = {
      id: 'ic-sub-1',
      threadId: 't-sub',
      author: 'coderabbit',
      path: 'plugins/plugin-sql',
      line: 1,
      createdAt: new Date().toISOString(),
      body: 'Consider fixing SQL adapter exports.',
    };

    const r = assessSolvability(parent, comment, makeStateContext(parent));
    expect(r.solvable).toBe(false);
    expect(r.dismissCategory).toBe('not-an-issue');
    expect(r.reason).toContain('git submodule');
    expect(r.remediationHint).toContain('submodule');
  });
});
