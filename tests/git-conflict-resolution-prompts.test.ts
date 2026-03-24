import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMClient } from '../tools/prr/llm/client.js';
import { CONFLICT_USE_CHUNKED_FIRST_CHUNKS } from '../shared/constants.js';
import {
  buildConflictResolutionPromptWithContent,
  splitConflictFilesIntoBatches,
} from '../tools/prr/git/git-conflict-prompts.js';
import {
  extractConflictChunks,
  extractConflictSides,
  findConflictChunkEdges,
  getBaseSegmentForChunk,
  resolveConflictChunk,
} from '../tools/prr/git/git-conflict-chunked.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConflictFile(conflictCount: number): string {
  const sections: string[] = [];
  for (let i = 0; i < conflictCount; i++) {
    sections.push(
      `before_${i}`,
      '<<<<<<< HEAD',
      `ours_${i}`,
      '=======',
      `theirs_${i}`,
      '>>>>>>> main',
      `after_${i}`,
    );
  }
  return sections.join('\n');
}

describe('conflict resolution prompt improvements', () => {
  it('embeds sections instead of the whole file when a modest file has many conflict chunks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-conflicts-'));
    tempDirs.push(dir);

    const filePath = join(dir, 'demo.ts');
    writeFileSync(filePath, makeConflictFile(CONFLICT_USE_CHUNKED_FIRST_CHUNKS), 'utf-8');

    const prompt = buildConflictResolutionPromptWithContent(
      ['demo.ts'],
      'main',
      dir,
      200_000
    );

    expect(extractConflictChunks(makeConflictFile(CONFLICT_USE_CHUNKED_FIRST_CHUNKS))).toHaveLength(
      CONFLICT_USE_CHUNKED_FIRST_CHUNKS
    );
    expect(prompt).toContain('--- FILE: demo.ts (section 1/');
    expect(prompt).not.toContain('--- FILE: demo.ts ---\nbefore_0');
  });

  it('splits conflict files into multiple batches when a single prompt would exceed the batch char cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-conflicts-split-'));
    tempDirs.push(dir);

    const small = `line\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n`;
    writeFileSync(join(dir, 'one.ts'), small, 'utf-8');
    writeFileSync(join(dir, 'two.ts'), small, 'utf-8');
    writeFileSync(join(dir, 'three.ts'), small, 'utf-8');

    const maxTotal = 200_000;
    const full = buildConflictResolutionPromptWithContent(['one.ts', 'two.ts', 'three.ts'], 'main', dir, maxTotal);
    const oneOnly = buildConflictResolutionPromptWithContent(['one.ts'], 'main', dir, maxTotal).length;
    const twoFiles = buildConflictResolutionPromptWithContent(['one.ts', 'two.ts'], 'main', dir, maxTotal).length;
    expect(twoFiles).toBeGreaterThan(oneOnly);
    const tightBatch = oneOnly + Math.floor((twoFiles - oneOnly) / 2);
    expect(full.length).toBeGreaterThan(tightBatch);
    expect(oneOnly).toBeLessThanOrEqual(tightBatch);
    expect(twoFiles).toBeGreaterThan(tightBatch);

    const batches = splitConflictFilesIntoBatches(['one.ts', 'two.ts', 'three.ts'], 'main', dir, maxTotal, tightBatch);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(buildConflictResolutionPromptWithContent(batch, 'main', dir, maxTotal).length).toBeLessThanOrEqual(tightBatch);
    }
    expect(new Set(batches.flat())).toEqual(new Set(['one.ts', 'two.ts', 'three.ts']));
  });

  it('omits a chunked file entirely when all sections will not fit in the prompt budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-conflicts-'));
    tempDirs.push(dir);

    writeFileSync(join(dir, 'demo.ts'), makeConflictFile(CONFLICT_USE_CHUNKED_FIRST_CHUNKS), 'utf-8');

    const prompt = buildConflictResolutionPromptWithContent(
      ['demo.ts'],
      'main',
      dir,
      300
    );

    expect(prompt).not.toContain('--- FILE: demo.ts (section 1/');
    expect(prompt).toContain('Files too large for this model (resolve manually): demo.ts');
  });

  it('normalizes placeholder chunk explanations from the model', async () => {
    const llm = {
      complete: async () => ({
        content: `RESOLVED:
\`\`\`
const merged = true;
\`\`\`
EXPLANATION: Brief explanation of what you merged/kept/changed`
      })
    } as unknown as LLMClient;

    const chunk = extractConflictChunks(`prefix
<<<<<<< HEAD
const merged = false;
=======
const merged = true;
>>>>>>> main
suffix`)[0];

    const result = await resolveConflictChunk(llm, 'demo.ts', chunk, 'main', undefined, 'const merged = false;');

    expect(result.resolved).toBe(true);
    expect(result.resolvedLines).toEqual(['const merged = true;']);
    expect(result.explanation).toBe('Resolved');
  });
});

describe('findConflictChunkEdges', () => {
  it('returns edges at statement boundaries for TS', async () => {
    const lines = [
      'const a = 1;',
      'const b = 2;',
      'function f() { return 3; }',
      'export {};',
    ];
    const edges = await findConflictChunkEdges(lines, 'file.ts', 1000);
    expect(edges[0]).toBe(0);
    expect(edges).toContain(lines.length);
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it('fallback forces split when no blank lines and segment too large', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    const edges = await findConflictChunkEdges(lines, 'file.txt', 500);
    expect(edges[0]).toBe(0);
    expect(edges).toContain(lines.length);
    expect(edges.length).toBeGreaterThan(2);
  });
});

describe('getBaseSegmentForChunk', () => {
  it('slices base by chunk start and content extent', () => {
    const baseContent = 'line0\nline1\nline2\nline3';
    const chunk = extractConflictChunks(
      'pre\n<<<<<<<\nours1\nours2\n=======\ntheirs1\n>>>>>>>\npost'
    )[0]!;
    const segment = getBaseSegmentForChunk(baseContent, chunk);
    const baseLines = baseContent.split('\n');
    const { ours } = extractConflictSides(chunk.conflictLines);
    expect(ours.length).toBe(2);
    expect(segment).toBe(baseLines.slice(chunk.startLine, chunk.startLine + 2).join('\n'));
  });

  it('returns truncated segment when base has fewer lines than chunk extent', () => {
    const baseContent = 'only';
    const chunk = extractConflictChunks(
      'pre\n<<<<<<<\nours1\nours2\n=======\ntheirs1\n>>>>>>>\npost'
    )[0]!;
    const segment = getBaseSegmentForChunk(baseContent, chunk);
    expect(segment).toBe('');
  });
});
