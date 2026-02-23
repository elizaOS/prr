import { describe, it, expect } from 'vitest';
import { runHeuristicPredictionOnDiff } from '../src/workflow/bot-prediction-heuristics.js';

function diffWith(...addedLines: string[]): string {
  const body = addedLines.map((l) => `+${l}`).join('\n');
  return `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
${body}
`;
}

describe('runHeuristicPredictionOnDiff', () => {
  it('returns one match when diff contains TODO', () => {
    const diff = diffWith('  // TODO: refactor later');
    const changedFiles = ['src/foo.ts'];
    const matches = runHeuristicPredictionOnDiff(diff, changedFiles);
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('src/foo.ts');
    expect(matches[0].rule).toBe('todo');
    expect(matches[0].suggestion).toContain('TODO');
  });

  it('returns no todo match when diff has no TODO/FIXME/XXX/HACK', () => {
    const diff = diffWith('  const x = 1;');
    const changedFiles = ['src/foo.ts'];
    const matches = runHeuristicPredictionOnDiff(diff, changedFiles);
    const todoMatches = matches.filter((m) => m.rule === 'todo');
    expect(todoMatches).toHaveLength(0);
  });

  it('returns one match when added line contains console.log', () => {
    const diff = diffWith('  console.log("debug");');
    const changedFiles = ['src/foo.ts'];
    const matches = runHeuristicPredictionOnDiff(diff, changedFiles);
    expect(matches).toHaveLength(1);
    expect(matches[0].rule).toBe('console_log');
    expect(matches[0].suggestion).toContain('debug');
  });

  it('does not flag console.log in context/removed lines (only added)', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
-  console.log("old");
+  return value;
`;
    const changedFiles = ['src/foo.ts'];
    const matches = runHeuristicPredictionOnDiff(diff, changedFiles);
    const consoleMatches = matches.filter((m) => m.rule === 'console_log');
    expect(consoleMatches).toHaveLength(0);
  });

  it('returns empty when changedFiles is empty', () => {
    const diff = diffWith('  // TODO');
    expect(runHeuristicPredictionOnDiff(diff, [])).toEqual([]);
  });

  it('ignores files not in changedFiles', () => {
    const diff = diffWith('  // TODO: x');
    const matches = runHeuristicPredictionOnDiff(diff, ['other.ts']);
    expect(matches).toHaveLength(0);
  });
});
