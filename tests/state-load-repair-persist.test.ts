import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolverState } from '../tools/prr/state/types.js';
import { getVerifiedDismissedOverlapIds, loadState } from '../tools/prr/state/state-core.js';
import type { StateContext } from '../tools/prr/state/state-context.js';

function diskState(pr: string): ResolverState {
  return {
    pr,
    branch: 'main',
    headSha: 'abc1111',
    startedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    lessonsLearned: [],
    iterations: [],
    verifiedFixed: ['ic_overlap'],
    verifiedComments: [],
    dismissedIssues: [
      {
        commentId: 'ic_overlap',
        reason: 'r',
        dismissedAt: '2026-01-01T00:00:00Z',
        dismissedAtIteration: 1,
        category: 'stale',
        filePath: 'a.ts',
        line: 1,
        commentBody: 'b',
      },
    ],
  } as ResolverState;
}

describe('loadState repair write-through', () => {
  const prevPersist = process.env.PRR_PERSIST_STATE_AFTER_LOAD_REPAIR;
  const prevStrict = process.env.PRR_STRICT_STATE_OVERLAP;

  beforeEach(() => {
    delete process.env.PRR_STRICT_STATE_OVERLAP;
  });

  afterEach(() => {
    if (prevPersist !== undefined) process.env.PRR_PERSIST_STATE_AFTER_LOAD_REPAIR = prevPersist;
    else delete process.env.PRR_PERSIST_STATE_AFTER_LOAD_REPAIR;
    if (prevStrict !== undefined) process.env.PRR_STRICT_STATE_OVERLAP = prevStrict;
    else delete process.env.PRR_STRICT_STATE_OVERLAP;
  });

  it('writes repaired state to disk by default so overlap does not survive on disk', async () => {
    delete process.env.PRR_PERSIST_STATE_AFTER_LOAD_REPAIR;
    const dir = await mkdtemp(join(tmpdir(), 'prr-state-persist-'));
    const statePath = join(dir, '.pr-resolver-state.json');
    const pr = 'o/r#1';
    await writeFile(statePath, JSON.stringify(diskState(pr)), 'utf-8');

    const ctx: StateContext = { statePath, state: null, currentPhase: 'init' };
    await loadState(ctx, pr, 'main', 'abc1111');

    expect(getVerifiedDismissedOverlapIds(ctx.state!)).toEqual([]);
    const round2 = JSON.parse(await readFile(statePath, 'utf-8')) as ResolverState;
    expect(getVerifiedDismissedOverlapIds(round2)).toEqual([]);
  });

  it('skips disk write when PRR_PERSIST_STATE_AFTER_LOAD_REPAIR=0', async () => {
    process.env.PRR_PERSIST_STATE_AFTER_LOAD_REPAIR = '0';
    const dir = await mkdtemp(join(tmpdir(), 'prr-state-nopersist-'));
    const statePath = join(dir, '.pr-resolver-state.json');
    const pr = 'o/r#2';
    const raw = diskState(pr);
    await writeFile(statePath, JSON.stringify(raw), 'utf-8');

    const ctx: StateContext = { statePath, state: null, currentPhase: 'init' };
    await loadState(ctx, pr, 'main', 'abc1111');

    expect(getVerifiedDismissedOverlapIds(ctx.state!)).toEqual([]);
    const onDisk = JSON.parse(await readFile(statePath, 'utf-8')) as ResolverState;
    expect(getVerifiedDismissedOverlapIds(onDisk).length).toBeGreaterThan(0);
  });
});
