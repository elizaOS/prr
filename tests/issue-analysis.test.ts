import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, afterEach } from 'vitest';
import {
  commentNeedsConservativeAnalysisContext,
  commentNeedsOrderingContext,
  getCodeSnippet,
  getFullFileForAudit,
  parseLineReferencesFromBody,
} from '../tools/prr/workflow/issue-analysis.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseLineReferencesFromBody', () => {
  it('extracts "around lines N - M" (CodeRabbit format)', () => {
    const body = 'In `@src/foo.ts` around lines 52 - 93, fix the issue.';
    expect(parseLineReferencesFromBody(body)).toEqual([52, 93]);
  });

  it('extracts "lines N-M"', () => {
    const body = 'Duplicate block at lines 70-78.';
    expect(parseLineReferencesFromBody(body)).toEqual([70, 78]);
  });

  it('extracts "at line N" and "on line N"', () => {
    const body = 'At line 128 we call createReadStream. On line 129 we close it.';
    expect(parseLineReferencesFromBody(body)).toEqual([128, 129]);
  });

  it('extracts "Line N" (capital L)', () => {
    const body = 'Line 45 has the null check.';
    expect(parseLineReferencesFromBody(body)).toEqual([45]);
  });

  it('extracts #LN and #LN-LM (LOCATIONS-style)', () => {
    const body = 'See #L100 and #L200-L210.';
    expect(parseLineReferencesFromBody(body)).toEqual([100, 200, 210]);
  });

  it('returns sorted, de-duplicated 1-based line numbers', () => {
    const body = 'Lines 93 and 52. Also around lines 52 - 93.';
    expect(parseLineReferencesFromBody(body)).toEqual([52, 93]);
  });

  it('does not match HTTP status or port numbers', () => {
    const body = 'HTTP 404 error. Connect to port 8080. Version 2.0.';
    expect(parseLineReferencesFromBody(body)).toEqual([]);
  });

  it('does not match "pipeline" or "deadline"', () => {
    const body = 'The pipeline runs in stage 2. Deadline is line 10.';
    // "line 10" should match; "pipeline" and "deadline" should not add line numbers
    expect(parseLineReferencesFromBody(body)).toEqual([10]);
  });

  it('skips lines containing sed -n / cat -n (CodeRabbit script blocks)', () => {
    const body = `Some comment about the code.
\`\`\`shell
sed -n '225,245p' file.ts
\`\`\`
The actual issue is at line 100.`;
    expect(parseLineReferencesFromBody(body)).toEqual([100]);
  });

  it('returns empty array for empty or whitespace input', () => {
    expect(parseLineReferencesFromBody('')).toEqual([]);
    expect(parseLineReferencesFromBody('   ')).toEqual([]);
  });
});

describe('commentNeedsConservativeAnalysisContext', () => {
  it('detects lifecycle issues that need broader analysis context', () => {
    expect(
      commentNeedsConservativeAnalysisContext(
        'latestResponseIds Map potential memory leak because entries are never cleared on early returns.'
      )
    ).toBe(true);
  });

  it('detects ordering issues that need broader analysis context', () => {
    expect(
      commentNeedsOrderingContext(
        'sliceToFitBudget with fromEnd: true keeps oldest runs instead of newest-first history.'
      )
    ).toBe(true);
  });
});

describe('getCodeSnippet', () => {
  it('returns lifecycle-aware excerpts for leak comments on large files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-issue-analysis-'));
    tempDirs.push(dir);

    const filler = Array.from({ length: 260 }, (_, i) => `const filler${i} = ${i};`).join('\n');
    const content = [
      'const latestResponseIds = new Map<string, Map<string, string>>();',
      filler,
      'function finish(agentId: string, roomId: string) {',
      '  const agentResponses = latestResponseIds.get(agentId);',
      '  if (!agentResponses) return;',
      '  agentResponses.delete(roomId);',
      '  if (agentResponses.size === 0) latestResponseIds.delete(agentId);',
      '}',
    ].join('\n');

    writeFileSync(join(dir, 'message.ts'), content, 'utf-8');

    const snippet = await getCodeSnippet(
      dir,
      'message.ts',
      1,
      'latestResponseIds Map potential memory leak still exists because cleanup is skipped on early returns.'
    );

    expect(snippet).toContain('Lifecycle excerpts for `latestResponseIds`');
    expect(snippet).toContain('latestResponseIds.delete(agentId)');
  });

  it('returns ordering-aware multi-range excerpts for large ordering comments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-issue-analysis-'));
    tempDirs.push(dir);

    const fillerA = Array.from({ length: 140 }, (_, i) => `const fillerA${i} = ${i};`).join('\n');
    const fillerB = Array.from({ length: 140 }, (_, i) => `const fillerB${i} = ${i};`).join('\n');
    const content = [
      'function loadRuns() {',
      '  const groupedByRun = new Map<string, string[]>();',
      '  groupedByRun.set("newest", ["a"]);',
      '}',
      fillerA,
      'function trimRuns(groupedByRun: Map<string, string[]>) {',
      '  return sliceToFitBudget(',
      '    Array.from(groupedByRun.entries()),',
      '    ([runId, memories]) => runId.length + memories.length,',
      '    2000,',
      '    { fromEnd: true },',
      '  );',
      '}',
      fillerB,
    ].join('\n');

    writeFileSync(join(dir, 'recentMessages.ts'), content, 'utf-8');

    const snippet = await getCodeSnippet(
      dir,
      'recentMessages.ts',
      2,
      'sliceToFitBudget with fromEnd: true keeps oldest runs because groupedByRun is already newest-first.'
    );

    expect(snippet).toContain('Ordering excerpts for recentMessages.ts');
    expect(snippet).toContain('groupedByRun = new Map');
    expect(snippet).toContain('sliceToFitBudget(');
    expect(snippet).toContain('{ fromEnd: true }');
  });

  it('returns create-file guidance for missing test files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-issue-analysis-'));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, 'widget.ts'),
      [
        'export function buildWidgetState(input: string) {',
        '  return { normalized: input.trim().toLowerCase() };',
        '}',
      ].join('\n'),
      'utf-8'
    );

    const snippet = await getCodeSnippet(
      dir,
      'src/__tests__/widget.test.ts',
      null,
      'Add tests for `widget.ts` by creating `src/__tests__/widget.test.ts`.'
    );

    expect(snippet).toContain('Requested new file `src/__tests__/widget.test.ts` does not exist yet.');
    expect(snippet).toContain('create-file issue');
    expect(snippet).toContain('Review comment:');
  });

  it('returns create-file guidance with source context for inferred test targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-issue-analysis-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });

    writeFileSync(
      join(dir, 'src', 'reply.ts'),
      [
        'export function hasRequestedInState(value: string) {',
        '  return value.length > 0;',
        '}',
      ].join('\n'),
      'utf-8'
    );

    const snippet = await getCodeSnippet(
      dir,
      'src/reply.test.ts',
      106,
      '`reply.ts:106-113` has no tests. Add coverage for hasRequestedInState.'
    );

    expect(snippet).toContain('Requested new file `src/reply.test.ts` does not exist yet.');
    expect(snippet).toContain('Nearby source context from `src/reply.ts`:');
    expect(snippet).toContain('hasRequestedInState');
  });
});

describe('getFullFileForAudit', () => {
  it('returns full line-numbered file when under size cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-audit-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'small.ts'), ['alpha', 'beta', 'gamma'].join('\n'), 'utf-8');
    const out = await getFullFileForAudit(dir, 'small.ts', 2, '');
    expect(out).toContain('1: alpha');
    expect(out).toContain('2: beta');
    expect(out).toContain('3: gamma');
  });

  it('centers excerpt on review line when file exceeds audit char cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-audit-'));
    tempDirs.push(dir);
    const lines: string[] = [];
    for (let i = 1; i <= 2000; i++) {
      lines.push(`// line ${i} ${'x'.repeat(40)}`);
    }
    const content = lines.join('\n');
    expect(content.length).toBeGreaterThan(50_000);
    writeFileSync(join(dir, 'big.ts'), content, 'utf-8');
    const out = await getFullFileForAudit(dir, 'big.ts', 1500, '');
    expect(out).toContain('excerpt only');
    expect(out).toMatch(/1500:\s*\/\/ line 1500/);
    expect(out).not.toMatch(/^1:\s*\/\/ line 1/m);
  });
});
