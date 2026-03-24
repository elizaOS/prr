import { describe, expect, it } from 'vitest';
import { LessonsManager } from '../tools/prr/state/lessons.js';

function normalize(lesson: string): string | null {
  const manager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
  return (manager as any).normalizeLessonText(lesson) as string | null;
}

describe('normalizeLessonText (direct)', () => {
  it('strips code blocks and keeps lesson text or returns null', () => {
    expect(
      normalize('```ts\nconst x = 1;\n```\n# Header\n**Bold line**\n- Keep this lesson text for later reference')
    ).toBe('Keep this lesson text for later reference');
    expect(normalize('```ts\ncode\n```\n# Header\n**Bold line**')).toBe(null);
  });

  it('normalizes lists and bullets to single line', () => {
    expect(normalize('1. item one\n2. item two\n- bullet\n+ plus\n* star')).toBe('item one item two bullet plus');
    expect(normalize('- **bold bullet**\n- kept lesson about sync errors')).toBe('kept lesson about sync errors');
  });

  it('strips comment-only lines but keeps lesson after', () => {
    expect(normalize('// comment only')).toBe(null);
    expect(normalize('// comment only\n- keep this lesson about conflict resolution')).toBe(
      'keep this lesson about conflict resolution'
    );
    expect(normalize('/* comment */\n1. keep this lesson about merge failures')).toBe(
      'keep this lesson about merge failures'
    );
  });

  it('strips code-like lines but keeps lesson on same input', () => {
    expect(normalize('private isShuttingDown = false;\n- keep this lesson about safe shutdowns')).toBe(
      'keep this lesson about safe shutdowns'
    );
    expect(normalize('const foo = 1;\n- keep this lesson about timeouts')).toBe('keep this lesson about timeouts');
    expect(normalize('class Foo {}\n- keep this lesson about retries')).toBe('keep this lesson about retries');
    expect(normalize('import { foo } from "bar"\n- keep this lesson about error handling')).toBe(
      'keep this lesson about error handling'
    );
  });

  it('strips (inferred) suffix', () => {
    expect(normalize('use this (inferred) before publishing changes')).toBe('use this before publishing changes');
  });

  it('strips file extension suffixes like - ts, - js, - ts:8', () => {
    expect(normalize('Always validate user input - ts')).toBe('Always validate user input');
    expect(normalize('Always validate user input - js')).toBe('Always validate user input');
    expect(normalize('Always validate user input - md')).toBe('Always validate user input');
    expect(normalize('Always validate user input - json')).toBe('Always validate user input');
    expect(normalize('Always validate user input - yml')).toBe('Always validate user input');
    expect(normalize('Always validate user input - ts:8')).toBe('Always validate user input');
    expect(normalize('ts:8` already includes all runners')).toBe('already includes all runners');
    expect(normalize('Always document decisions - a:123')).toBe('Always document decisions');
    expect(normalize('Always document decisions - a.ts:123')).toBe('Always document decisions - a.ts:123');
  });

  it('normalizes tool-made-no-changes phrasing', () => {
    expect(
      normalize('claude-code with gpt-5-mini made no changes: without explanation - trying different approach')
    ).toBe('tool made no changes without explanation - trying different approach');
    expect(normalize('tool made no changes, tool made no changes and tool made no changes')).toBe(
      'tool made no changes'
    );
  });

  it('preserves or drops Fix for / rejected lines as expected', () => {
    expect(
      normalize('Fix for README.md:null rejected: The diff only adds an import for `rm` from fs/promises')
    ).toBe('Fix for README.md rejected: The diff only adds an import for `rm` from fs/promises');
    expect(normalize('Fix for src/resolver.ts:null - (inferred) : string;')).toBe(null);
    expect(normalize('Do NOT repeat them:')).toBe(null);
    expect(normalize('chars truncated')).toBe(null);
  });

  it('handles edge cases', () => {
    expect(normalize('Always document decisions:')).toBe('Always document decisions');
    expect(normalize('Always document decisions -')).toBe('Always document decisions');
    expect(normalize('Fix for README.md. rejected: ok')).toBe('Fix for README.md rejected: ok');
    expect(normalize('123')).toBe(null);
    expect(normalize('123.')).toBe(null);
  });
});
