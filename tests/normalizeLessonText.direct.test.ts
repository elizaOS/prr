import { strict as assert } from 'node:assert';
import { LessonsManager } from '../src/state/lessons.js';

function normalize(lesson: string): string | null {
  const manager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
  return (manager as any).normalizeLessonText(lesson) as string | null;
}

async function run(): Promise<void> {
  assert.equal(
    normalize('```ts\ncode\n```\n# Header\n**Bold line**\n- Keep this'),
    'code Keep this'
  );
  assert.equal(normalize('```ts\ncode\n```\n# Header\n**Bold line**'), 'code');

  assert.equal(normalize('1. item one\n2. item two\n- bullet\n+ plus\n* star'), 'item one item two bullet plus star');
  assert.equal(normalize('- **bold bullet**\n- kept'), 'kept');

  assert.equal(normalize('// comment only'), null);
  assert.equal(normalize('// comment only\n- keep'), 'keep');
  assert.equal(normalize('/* comment */\n1. keep'), 'keep');

  assert.equal(normalize('private isShuttingDown = false;\n- keep'), 'keep');
  assert.equal(normalize('const foo = 1;\n- keep'), 'keep');
  assert.equal(normalize('class Foo {}\n- keep'), 'keep');
  assert.equal(normalize('import { foo } from "bar"\n- keep'), 'keep');

  assert.equal(normalize('use this (inferred)'), 'use this');

  assert.equal(normalize('lesson - ts'), 'lesson');
  assert.equal(normalize('lesson - js'), 'lesson');
  assert.equal(normalize('lesson - md'), 'lesson');
  assert.equal(normalize('lesson - json'), 'lesson');
  assert.equal(normalize('lesson - yml'), 'lesson');

  assert.equal(normalize('lesson - ts:8'), 'lesson');
  assert.equal(normalize('ts:8` already includes all runners'), 'already includes all runners');
  assert.equal(normalize('lesson - a:123'), 'lesson');
  assert.equal(normalize('lesson - a.ts:123'), 'lesson - a.ts:123');

  assert.equal(
    normalize('claude-code with gpt-5-mini made no changes: without explanation - trying different approach'),
    'tool made no changes without explanation - trying different approach'
  );
  assert.equal(normalize('tool made no changes, tool made no changes and tool made no changes'), 'tool made no changes');

  assert.equal(
    normalize('Fix for README.md:null rejected: The diff only adds an import for `rm` from fs/promises'),
    'Fix for README.md rejected: The diff only adds an import for `rm` from fs/promises'
  );
  assert.equal(normalize('Fix for src/resolver.ts:null - (inferred) : string;'), null);
  assert.equal(normalize('Do NOT repeat them:'), null);
  assert.equal(normalize('chars truncated'), null);

  assert.equal(normalize('lesson:'), 'lesson');
  assert.equal(normalize('lesson -'), 'lesson');
  assert.equal(normalize('Fix for README.md. rejected: ok'), 'Fix for README.md rejected: ok');
  assert.equal(normalize('123'), null);
  assert.equal(normalize('123.'), null);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
