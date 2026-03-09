import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMClient } from '../tools/prr/llm/client.js';
import { CONFLICT_USE_CHUNKED_FIRST_CHUNKS } from '../shared/constants.js';
import { buildConflictResolutionPromptWithContent } from '../tools/prr/git/git-conflict-prompts.js';
import { extractConflictChunks, resolveConflictChunk } from '../tools/prr/git/git-conflict-chunked.js';

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

    const result = await resolveConflictChunk(llm, 'demo.ts', chunk, 'main');

    expect(result.resolved).toBe(true);
    expect(result.resolvedLines).toEqual(['const merged = true;']);
    expect(result.explanation).toBe('Resolved');
  });
});
