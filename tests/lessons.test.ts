import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonsManager } from '../src/state/lessons.js';

async function run(): Promise<void> {
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

  assert.ok(!saved.includes('private isShuttingDown'));
  assert.ok(!saved.includes('// Bail-out tracking'));
  assert.ok(!saved.includes('**Issues'));
  assert.ok(!saved.includes('claude-code with'));
  assert.equal(saved.match(/tool made no changes - trying different approach/g)?.length ?? 0, 1);
  assert.ok(saved.includes('Fix for README.md rejected:'));
  assert.ok(saved.includes('### src/state/manager.ts:117'));
  assert.ok(saved.includes('### src/llm/client.ts:319'));

  const normalizeLessonText = (input: string) => (manager as any).normalizeLessonText(input) as string | null;
  assert.equal(normalizeLessonText('```ts\nconst x = 1;\n```\n# Header\n**Bold**\n- Keep this'), 'Keep this');
  assert.equal(normalizeLessonText('1. Numbered item'), 'Numbered item');
  assert.equal(normalizeLessonText('// comment only'), null);
  assert.equal(normalizeLessonText('/* block comment */'), null);
  assert.equal(normalizeLessonText('* leading comment'), 'leading comment');
  assert.equal(normalizeLessonText('private isShuttingDown = false;'), null);
  assert.equal(normalizeLessonText('progressThisCycle = 0;'), null);
  assert.equal(normalizeLessonText('modelsTriedThisToolRound: number;'), null);
  assert.equal(normalizeLessonText('public name: string;'), null);
  assert.equal(normalizeLessonText('const foo = 1;'), null);
  assert.equal(normalizeLessonText('export type Foo = {}'), null);
  assert.equal(normalizeLessonText('class Foo {}'), null);
  assert.equal(normalizeLessonText('interface Foo {}'), null);
  assert.equal(normalizeLessonText('import foo from "bar"'), null);
  assert.equal(normalizeLessonText('use this (inferred)'), 'use this');
  assert.equal(normalizeLessonText('lesson - ts'), 'lesson');
  assert.equal(normalizeLessonText('lesson - json'), 'lesson');
  assert.equal(normalizeLessonText('lesson - a:123'), 'lesson');
  assert.equal(normalizeLessonText('lesson - a.ts:123'), 'lesson - a.ts:123');
  assert.equal(
    normalizeLessonText('claude-code with claude-sonnet-4-5-20250929 made no changes without explanation - trying different approach'),
    'tool made no changes without explanation - trying different approach'
  );
  assert.equal(normalizeLessonText('2-codex with gpt-5-mini made no changes'), 'tool made no changes');
  assert.equal(normalizeLessonText('tool made no changes, tool made no changes'), 'tool made no changes');
  assert.equal(normalizeLessonText('chars truncated'), null);
  assert.equal(normalizeLessonText('Fix for src/file.ts:123'), null);
  assert.equal(normalizeLessonText('Fix for src/file.ts:null'), null);
  assert.equal(normalizeLessonText('Fix for src/file.ts:undefined'), null);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
