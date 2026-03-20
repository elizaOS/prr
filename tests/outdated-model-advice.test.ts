import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  parseModelRenameAdvice,
  commentSuggestsInvalidModelId,
  catalogValidatesBothIds,
  getOutdatedModelCatalogDismissal,
} from '../tools/prr/workflow/helpers/outdated-model-advice.js';
import { assessSolvability } from '../tools/prr/workflow/helpers/solvability.js';
import type { ReviewComment } from '../tools/prr/github/types.js';
import type { StateContext } from '../tools/prr/state/state-context.js';
import type { ResolverState } from '../tools/prr/state/types.js';
import {
  replaceModelIdInQuotedStringsInLines,
  applyCatalogModelAutoHeals,
} from '../tools/prr/workflow/catalog-model-autoheal.js';

describe('outdated-model-advice', () => {
  it('parses change A to B (eliza-style)', () => {
    const body =
      '❌ CRITICAL: Model name typo\nChange gpt-5-mini to gpt-4o-mini for API compatibility.';
    expect(parseModelRenameAdvice(body)).toEqual({
      catalogGoodId: 'gpt-5-mini',
      wronglySuggestedId: 'gpt-4o-mini',
    });
    expect(commentSuggestsInvalidModelId(body)).toBe(true);
  });

  it('parses backtick change', () => {
    const body = 'Model name typo: change `gpt-5-mini` to `gpt-4o-mini`';
    expect(parseModelRenameAdvice(body)).toEqual({
      catalogGoodId: 'gpt-5-mini',
      wronglySuggestedId: 'gpt-4o-mini',
    });
  });

  it('parses use B instead of A', () => {
    const body = 'Invalid model: use `gpt-4o-mini` instead of `gpt-5-mini`';
    expect(parseModelRenameAdvice(body)).toEqual({
      catalogGoodId: 'gpt-5-mini',
      wronglySuggestedId: 'gpt-4o-mini',
    });
  });

  it('parses have X instead of Y (CodeRabbit-style)', () => {
    const body = 'Lines 31-32 still have incorrect model name "gpt-5-mini" instead of "gpt-4o-mini"';
    expect(parseModelRenameAdvice(body)).toEqual({
      catalogGoodId: 'gpt-5-mini',
      wronglySuggestedId: 'gpt-4o-mini',
    });
    expect(commentSuggestsInvalidModelId(body)).toBe(true);
  });

  it('parses still have X instead of Y', () => {
    const body = 'Still have `gpt-5-mini` instead of `gpt-4o-mini`';
    expect(parseModelRenameAdvice(body)).toEqual({
      catalogGoodId: 'gpt-5-mini',
      wronglySuggestedId: 'gpt-4o-mini',
    });
  });

  it('parses CodeRabbit-style heading plus recommended id later in body', () => {
    const body = `### Model name typo \`gpt-5-mini\` in telegram example

Lines 31-32 still set models. Please use \`gpt-4o-mini\` for compatibility.`;
    expect(parseModelRenameAdvice(body)).toEqual({
      catalogGoodId: 'gpt-5-mini',
      wronglySuggestedId: 'gpt-4o-mini',
    });
    const d = getOutdatedModelCatalogDismissal(body);
    expect(d).not.toBeNull();
    expect(d!.pair.catalogGoodId).toBe('gpt-5-mini');
  });

  it('returns null without rename pattern', () => {
    expect(
      parseModelRenameAdvice('We should use gpt-5-mini everywhere for cost.'),
    ).toBeNull();
  });

  it('catalogValidatesBothIds for gpt-5-mini and gpt-4o-mini', () => {
    expect(catalogValidatesBothIds('gpt-5-mini', 'gpt-4o-mini')).toBe(true);
  });

  it('getOutdatedModelCatalogDismissal returns null without invalid framing', () => {
    const body = 'Prefer change gpt-5-mini to gpt-4o-mini for latency'; // no typo/invalid framing
    expect(getOutdatedModelCatalogDismissal(body)).toBeNull();
  });

  it('getOutdatedModelCatalogDismissal returns reason for full eliza-shaped body', () => {
    const body =
      '❌ CRITICAL: Model name typo in example\nChange gpt-5-mini to gpt-4o-mini';
    const d = getOutdatedModelCatalogDismissal(body);
    expect(d).not.toBeNull();
    expect(d!.reason).toContain('model-provider-catalog');
    expect(d!.pair.catalogGoodId).toBe('gpt-5-mini');
  });

  it('getOutdatedModelCatalogDismissal respects PRR_DISABLE_MODEL_CATALOG_SOLVABILITY', () => {
    process.env.PRR_DISABLE_MODEL_CATALOG_SOLVABILITY = '1';
    const body = '❌ CRITICAL: Model name typo\nChange gpt-5-mini to gpt-4o-mini';
    expect(getOutdatedModelCatalogDismissal(body)).toBeNull();
    delete process.env.PRR_DISABLE_MODEL_CATALOG_SOLVABILITY;
  });
});

describe('catalog-model-autoheal replace', () => {
  it('replaces only quoted occurrences in window lines', () => {
    const lines = [
      'const x = "gpt-4o-mini";',
      '// gpt-4o-mini in comment',
      "y = 'gpt-4o-mini'",
    ];
    const { lines: out, count } = replaceModelIdInQuotedStringsInLines(lines, 'gpt-4o-mini', 'gpt-5-mini');
    expect(count).toBe(2);
    expect(out[0]).toContain('"gpt-5-mini"');
    expect(out[1]).toContain('// gpt-4o-mini'); // comment untouched
    expect(out[2]).toContain("'gpt-5-mini'");
  });
});

describe('assessSolvability catalog dismissal', () => {
  const minimalState = (): StateContext => ({
    statePath: join(tmpdir(), 'fake-state.json'),
    state: {
      iterations: [],
      verifiedFixed: [],
      verifiedComments: [],
      dismissedIssues: [],
    } as ResolverState,
    currentPhase: 'test',
  });

  it('dismisses outdated model catalog advice before path checks', () => {
    const body =
      '❌ CRITICAL: Model name typo\nChange gpt-5-mini to gpt-4o-mini';
    const comment: ReviewComment = {
      id: 'ic_test_1',
      threadId: 't1',
      author: 'claude',
      body,
      path: 'examples/foo.ts',
      line: 10,
      createdAt: new Date().toISOString(),
    };
    const ctx = minimalState();
    const r = assessSolvability(join(tmpdir(), 'no-such-prr-workdir'), comment, ctx);
    expect(r.solvable).toBe(false);
    expect(r.dismissCategory).toBe('not-an-issue');
    expect(r.reason).toContain('catalog');
  });

  it('dismisses merge/closing meta comment anchored on a file', () => {
    const body =
      'Closing — the `odi-want` branch was already merged directly into develop. No further action needed on this PR.';
    const comment: ReviewComment = {
      id: 'ic_merge_meta',
      threadId: 't1',
      author: 'human',
      body,
      path: 'examples/foo.ts',
      line: 1,
      createdAt: new Date().toISOString(),
    };
    const ctx = minimalState();
    const r = assessSolvability(join(tmpdir(), 'no-such-prr-workdir'), comment, ctx);
    expect(r.solvable).toBe(false);
    expect(r.dismissCategory).toBe('not-an-issue');
    expect(r.reason).toMatch(/merge|closing/i);
  });
});

describe('applyCatalogModelAutoHeals', () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };

  it('rewrites quoted model id in tracked file near comment line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-heal-'));
    try {
      execFileSync('git', ['init'], { cwd: dir, env: gitEnv });
      const rel = 'examples/telegram-agent.ts';
      mkdirSync(join(dir, 'examples'), { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 35; i++) {
        if (i === 30) lines.push('export const OPENAI_SMALL_MODEL = "gpt-4o-mini";');
        else lines.push(`// line ${i}`);
      }
      writeFileSync(join(dir, rel), lines.join('\n') + '\n');
      execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, env: gitEnv });

      const body =
        '❌ CRITICAL: Model name typo in example\nChange gpt-5-mini to gpt-4o-mini';
      const comment: ReviewComment = {
        id: 'ic_heal_1',
        threadId: 't1',
        author: 'claude',
        body,
        path: rel,
        line: 31,
        createdAt: new Date().toISOString(),
      };
      const ctx: StateContext = {
        statePath: join(dir, '.pr-resolver-state.json'),
        state: {
          iterations: [],
          verifiedFixed: [],
          verifiedComments: [],
          dismissedIssues: [],
        } as ResolverState,
        currentPhase: 'test',
      };
      const outcome = applyCatalogModelAutoHeals(dir, [comment], ctx);
      expect(outcome.modifiedPaths).toEqual([rel]);
      expect(outcome.verificationTouched).toBe(true);
      const text = readFileSync(join(dir, rel), 'utf8');
      expect(text).toContain('"gpt-5-mini"');
      expect(text).not.toMatch(/OPENAI_SMALL_MODEL = "gpt-4o-mini"/);
      expect(ctx.verifiedThisSession?.has('ic_heal_1')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.PRR_DISABLE_MODEL_CATALOG_AUTOHEAL;
    }
  });

  it('marks verified noop when file already has catalog id and wrong id never appears quoted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-heal-noop-'));
    try {
      execFileSync('git', ['init'], { cwd: dir, env: gitEnv });
      const rel = 'examples/telegram-agent.ts';
      mkdirSync(join(dir, 'examples'), { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 70; i++) {
        if (i === 5) lines.push('export const OPENAI_SMALL_MODEL = "gpt-5-mini";');
        else lines.push(`// line ${i}`);
      }
      writeFileSync(join(dir, rel), lines.join('\n') + '\n');
      execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, env: gitEnv });

      const body =
        '❌ CRITICAL: Model name typo in example\nChange gpt-5-mini to gpt-4o-mini';
      const comment: ReviewComment = {
        id: 'ic_heal_noop',
        threadId: 't2',
        author: 'claude',
        body,
        path: rel,
        line: 50,
        createdAt: new Date().toISOString(),
      };
      const ctx: StateContext = {
        statePath: join(dir, '.pr-resolver-state.json'),
        state: {
          iterations: [],
          verifiedFixed: [],
          verifiedComments: [],
          dismissedIssues: [],
        } as ResolverState,
        currentPhase: 'test',
      };
      const outcome = applyCatalogModelAutoHeals(dir, [comment], ctx);
      expect(outcome.modifiedPaths).toEqual([]);
      expect(outcome.verificationTouched).toBe(true);
      expect(ctx.verifiedThisSession?.has('ic_heal_noop')).toBe(true);
      const text = readFileSync(join(dir, rel), 'utf8');
      expect(text).toContain('"gpt-5-mini"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heals quoted wrong id outside ±20 line window via full-file fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-heal-full-'));
    try {
      execFileSync('git', ['init'], { cwd: dir, env: gitEnv });
      const rel = 'examples/telegram-agent.ts';
      mkdirSync(join(dir, 'examples'), { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 80; i++) {
        if (i === 3) lines.push('export const OPENAI_SMALL_MODEL = "gpt-4o-mini";');
        else lines.push(`// line ${i}`);
      }
      writeFileSync(join(dir, rel), lines.join('\n') + '\n');
      execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, env: gitEnv });

      const body =
        '❌ CRITICAL: Model name typo in example\nChange gpt-5-mini to gpt-4o-mini';
      const comment: ReviewComment = {
        id: 'ic_heal_full',
        threadId: 't3',
        author: 'claude',
        body,
        path: rel,
        line: 55,
        createdAt: new Date().toISOString(),
      };
      const ctx: StateContext = {
        statePath: join(dir, '.pr-resolver-state.json'),
        state: {
          iterations: [],
          verifiedFixed: [],
          verifiedComments: [],
          dismissedIssues: [],
        } as ResolverState,
        currentPhase: 'test',
      };
      const outcome = applyCatalogModelAutoHeals(dir, [comment], ctx);
      expect(outcome.modifiedPaths).toEqual([rel]);
      expect(outcome.verificationTouched).toBe(true);
      const text = readFileSync(join(dir, rel), 'utf8');
      expect(text).toContain('"gpt-5-mini"');
      expect(text).not.toMatch(/OPENAI_SMALL_MODEL = "gpt-4o-mini"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    delete process.env.PRR_DISABLE_MODEL_CATALOG_AUTOHEAL;
  });
});
