import { strict as assert } from 'node:assert';
import { LessonsManager } from '../tools/prr/state/lessons.js';

function normalize(lesson: string): string | null {
  const manager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
  return (manager as any).normalizeLessonText(lesson) as string | null;
}

async function run(): Promise<void> {
  assert.equal(
    normalize('```ts\nconst x = 1;\n```\n# Header\n**Bold line**\n- Keep this lesson text for later reference'),
    'Keep this lesson text for later reference'
  );
  assert.equal(normalize('```ts\ncode\n```\n# Header\n**Bold line**'), null);

  assert.equal(normalize('1. item one\n2. item two\n- bullet\n+ plus\n* star'), 'item one item two bullet plus');
  assert.equal(normalize('- **bold bullet**\n- kept lesson about sync errors'), 'kept lesson about sync errors');

  assert.equal(normalize('// comment only'), null);
  assert.equal(normalize('// comment only\n- keep this lesson about conflict resolution'), 'keep this lesson about conflict resolution');
  assert.equal(normalize('/* comment */\n1. keep this lesson about merge failures'), 'keep this lesson about merge failures');

  assert.equal(normalize('private isShuttingDown = false;\n- keep this lesson about safe shutdowns'), 'keep this lesson about safe shutdowns');
  assert.equal(normalize('const foo = 1;\n- keep this lesson about timeouts'), 'keep this lesson about timeouts');
  assert.equal(normalize('class Foo {}\n- keep this lesson about retries'), 'keep this lesson about retries');
  assert.equal(normalize('import { foo } from "bar"\n- keep this lesson about error handling'), 'keep this lesson about error handling');

  assert.equal(normalize('use this (inferred) before publishing changes'), 'use this before publishing changes');

  assert.equal(normalize('Always validate user input - ts'), 'Always validate user input');
  assert.equal(normalize('Always validate user input - js'), 'Always validate user input');
  assert.equal(normalize('Always validate user input - md'), 'Always validate user input');
  assert.equal(normalize('Always validate user input - json'), 'Always validate user input');
  assert.equal(normalize('Always validate user input - yml'), 'Always validate user input');

  assert.equal(normalize('Always validate user input - ts:8'), 'Always validate user input');
  assert.equal(normalize('ts:8` already includes all runners'), 'already includes all runners');
  assert.equal(normalize('Always document decisions - a:123'), 'Always document decisions');
  assert.equal(normalize('Always document decisions - a.ts:123'), 'Always document decisions - a.ts:123');

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

  assert.equal(normalize('Always document decisions:'), 'Always document decisions');
  assert.equal(normalize('Always document decisions -'), 'Always document decisions');
  assert.equal(normalize('Fix for README.md. rejected: ok'), 'Fix for README.md rejected: ok');
  assert.equal(normalize('123'), null);
  assert.equal(normalize('123.'), null);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
