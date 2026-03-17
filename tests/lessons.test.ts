import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonsManager } from '../tools/prr/state/lessons.js';

describe('LessonsManager load/save and normalizeLessonText', () => {
  it('sanitizes corrupted lessons on load and save', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'prr-lessons-test-'));
    await mkdir(join(workdir, '.prr'), { recursive: true });

    const corruptedLessons = `# PRR Lessons Learned

## Global Lessons
- Fix for src/resolver.ts:null - (inferred) : string;
  private isShuttingDown = false;
  // Bail-out tracking: detect stalemates where no progress is made
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach
- codex with gpt-5-mini made no changes - trying different approach
- Fix for README.md:null rejected: The diff only adds an import for \`rm\` from 'fs/promises'

## File-Specific Lessons
### src/state/manager.ts:117 - (inferred) ts
- Fix for src/state/manager.ts:117 - (inferred) ts:117 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:
### src/llm/client.ts:319 - (inferred) ts
- Fix for src/llm/client.ts:319 - (inferred) ts:319 - (inferred) The code after \`Updated upstream\` already has the fix.
`;

    const lessonsPath = join(workdir, '.prr', 'lessons.md');
    await writeFile(lessonsPath, corruptedLessons, 'utf-8');

    const manager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
    manager.setWorkdir(workdir);
    await manager.load();
    await manager.saveToRepo();

    const saved = await readFile(lessonsPath, 'utf-8');

    expect(saved).not.toContain('private isShuttingDown');
    expect(saved).not.toContain('// Bail-out tracking');
    expect(saved).not.toContain('**Issues');
    expect(saved).not.toContain('claude-code with');
    expect((saved.match(/tool made no changes - trying different approach/g) ?? []).length).toBe(1);
    expect(saved).toContain('Fix for README.md rejected:');
    expect(saved).toContain('### src/state/manager.ts');
    expect(saved).toContain('### src/llm/client.ts');
  });

  it('normalizeLessonText strips code blocks and keeps lesson text', () => {
    const workdir = join(tmpdir(), 'prr-lessons-normalize-' + Date.now());
    const manager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
    manager.setWorkdir(workdir);
    const normalizeLessonText = (input: string) => (manager as any).normalizeLessonText(input) as string | null;

    expect(
      normalizeLessonText('```ts\nconst x = 1;\n```\n# Header\n**Bold**\n- Keep this lesson text for later reference')
    ).toBe('Keep this lesson text for later reference');
    expect(normalizeLessonText('1. Always verify fixes before commit')).toBe('Always verify fixes before commit');
    expect(normalizeLessonText('// comment only')).toBe(null);
    expect(normalizeLessonText('/* block comment */')).toBe(null);
    expect(normalizeLessonText('* leading comment')).toBe(null);
    expect(normalizeLessonText('private isShuttingDown = false;')).toBe(null);
    expect(normalizeLessonText('progressThisCycle = 0;')).toBe(null);
    expect(normalizeLessonText('modelsTriedThisToolRound: number;')).toBe(null);
    expect(normalizeLessonText('public name: string;')).toBe(null);
    expect(normalizeLessonText('const foo = 1;')).toBe(null);
    expect(normalizeLessonText('export type Foo = {}')).toBe(null);
    expect(normalizeLessonText('class Foo {}')).toBe(null);
    expect(normalizeLessonText('interface Foo {}')).toBe(null);
    expect(normalizeLessonText('import foo from "bar"')).toBe(null);
    expect(
      normalizeLessonText('Fix for src/resolver.ts - : string; tool made no changes - trying different approach tool made no changes  already includes all runners')
    ).toBe(null);
    expect(normalizeLessonText('Fixer made no changes  already includes all runners')).toBe(
      'fixer made no changes - already includes all runners'
    );
    expect(normalizeLessonText('use this (inferred) before publishing changes')).toBe('use this before publishing changes');
    expect(normalizeLessonText('Always validate user input - ts')).toBe('Always validate user input');
    expect(normalizeLessonText('Always validate config files - json')).toBe('Always validate config files');
    expect(normalizeLessonText('Always document decisions - a:123')).toBe('Always document decisions');
    expect(normalizeLessonText('Always document decisions - a.ts:123')).toBe('Always document decisions - a.ts:123');
    expect(
      normalizeLessonText('claude-code with claude-sonnet-4-5-20250929 made no changes without explanation - trying different approach')
    ).toBe('tool made no changes without explanation - trying different approach');
    expect(normalizeLessonText('2-codex with gpt-5-mini made no changes')).toBe('tool made no changes');
    expect(normalizeLessonText('tool made no changes, tool made no changes')).toBe('tool made no changes');
    expect(normalizeLessonText('chars truncated')).toBe(null);
    expect(normalizeLessonText('Fix for src/file.ts:123')).toBe(null);
    expect(normalizeLessonText('Fix for src/file.ts:null')).toBe(null);
    expect(normalizeLessonText('Fix for src/file.ts:undefined')).toBe(null);
  });
});
