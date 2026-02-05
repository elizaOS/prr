import { describe, it, expect, beforeEach } from 'vitest';
import { LessonsManager } from '../src/state/lessons';

describe('normalizeLessonText', () => {
  // Create an instance to access the private method via reflection
  let lessonsManager: LessonsManager;

  beforeEach(() => {
    lessonsManager = new LessonsManager('owner', 'repo', 'branch');
  });

  // Helper to call private method
  function normalize(lesson: string): string | null {
    return (lessonsManager as any).normalizeLessonText(lesson);
  }

  describe('code fence removal', () => {
    it('removes markdown code fences', () => {
      const input = '```typescript\ncode here\n```';
      expect(normalize(input)).not.toContain('```');
    });
  });

  describe('markdown header removal', () => {
    it('removes markdown headers', () => {
      const input = '# Header\n## Subheader';
      expect(normalize(input)).not.toContain('#');
    });
  });

  describe('bold text removal', () => {
    it('removes bold markdown', () => {
      const input = 'This is **bold** text';
      expect(normalize(input)).toBe('This is bold text');
    });
  });

  describe('list removal', () => {
    it('removes bullet points', () => {
      const input = '- Item 1\n- Item 2';
      expect(normalize(input)).not.toContain('-');
    });

    it('removes numbered lists', () => {
      const input = '1. First\n2. Second';
      expect(normalize(input)).not.toContain('1.');
    });
  });

  describe('comment token removal', () => {
    it('removes // comments', () => {
      const input = 'code // comment';
      expect(normalize(input)).not.toContain('//');
    });

    it('removes /* */ comments', () => {
      const input = 'code /* comment */';
      expect(normalize(input)).not.toContain('/*');
    });

    it('removes * line prefix', () => {
      const input = '* line\n* another';
      expect(normalize(input)).not.toContain('*');
    });
  });

  describe('access modifier removal', () => {
    it('drops public modifier lines', () => {
      const input = 'public method()';
      expect(normalize(input)).toBeNull();
    });

    it('drops private modifier lines', () => {
      const input = 'private field';
      expect(normalize(input)).toBeNull();
    });

    it('drops protected modifier lines', () => {
      const input = 'protected method';
      expect(normalize(input)).toBeNull();
    });
  });

  describe('declaration removal', () => {
    it('removes class declaration', () => {
      const input = 'class MyClass';
      expect(normalize(input)).not.toContain('class');
    });

    it('removes interface declaration', () => {
      const input = 'interface MyInterface';
      expect(normalize(input)).not.toContain('interface');
    });

    it('removes type declaration', () => {
      const input = 'type MyType';
      expect(normalize(input)).not.toContain('type');
    });

    it('removes const declaration', () => {
      const input = 'const value = 5';
      expect(normalize(input)).toBe('value = 5');
    });

    it('removes let declaration', () => {
      const input = 'let value = 5';
      expect(normalize(input)).toBe('value = 5');
    });

    it('removes var declaration', () => {
      const input = 'var value = 5';
      expect(normalize(input)).toBe('value = 5');
    });

    it('removes import declaration', () => {
      const input = 'import { foo } from "bar"';
      expect(normalize(input)).not.toContain('import');
    });

    it('removes export declaration', () => {
      const input = 'export function foo()';
      expect(normalize(input)).not.toContain('export');
    });
  });

  describe('inferred removal', () => {
    it('removes (inferred) tag', () => {
      const input = 'something (inferred) here';
      expect(normalize(input)).toBe('something here');
    });
  });

  describe('file extension stripping', () => {
    it('keeps .ts extension', () => {
      const input = 'src/file.ts';
      expect(normalize(input)).toBe('src/file.ts');
    });

    it('keeps .js extension', () => {
      const input = 'src/file.js';
      expect(normalize(input)).toBe('src/file.js');
    });

    it('keeps .md extension', () => {
      const input = 'src/file.md';
      expect(normalize(input)).toBe('src/file.md');
    });

    it('keeps .json extension', () => {
      const input = 'src/file.json';
      expect(normalize(input)).toBe('src/file.json');
    });

    it('keeps .yml extension', () => {
      const input = 'src/file.yml';
      expect(normalize(input)).toBe('src/file.yml');
    });
  });

  describe('trailing pattern removal', () => {
    it('removes trailing line numbers', () => {
      const input = 'src/file.ts:123';
      expect(normalize(input)).toBe('src/file');
    });

    it('removes trailing type and line number', () => {
      const input = 'src/file.ts:123-ts';
      expect(normalize(input)).not.toContain(':');
    });
  });

  describe('made no changes normalization', () => {
    it('normalizes "made no changes" variants without explanation', () => {
      const input = 'tool made no changes without explanation';
      expect(normalize(input)).toBe('tool made no changes');
    });

    it('normalizes with "trying different approach"', () => {
      const input = 'tool made no changes - trying different approach';
      expect(normalize(input)).toBe('tool made no changes');
    });
  });

  describe('chars truncated handling', () => {
    it('returns null for chars truncated', () => {
      const input = 'some text chars truncated more';
      expect(normalize(input)).toBeNull();
    });
  });

  describe('Fix for pattern handling', () => {
    it('returns null for "Fix for" with null/undefined/number', () => {
      expect(normalize('Fix for src/file.ts:null')).toBeNull();
      expect(normalize('Fix for src/file.ts:undefined')).toBeNull();
      expect(normalize('Fix for src/file.ts:123')).toBeNull();
    });

    it('returns null for "Fix for" without line number', () => {
      expect(normalize('Fix for src/file.ts')).toBeNull();
    });
  });

  describe('numeric-only input', () => {
    it('returns null for numeric-only strings', () => {
      expect(normalize('123')).toBeNull();
      expect(normalize('456.')).toBeNull();
    });
  });

  describe('trimming and cleanup', () => {
    it('removes trailing colons', () => {
      const input = 'some lesson:';
      expect(normalize(input)).toBe('some lesson');
    });

    it('removes trailing dashes', () => {
      const input = 'some lesson -';
      expect(normalize(input)).not.toContain('-');
    });

    it('returns null for empty strings', () => {
      expect(normalize('')).toBeNull();
    });

    it('returns null for whitespace-only strings', () => {
      expect(normalize('   ')).toBeNull();
    });
  });

  describe('combined edge cases', () => {
    it('handles multiple transformations in sequence', () => {
      const input = '**Fix for** src/file.ts with // comment (inferred)';
      const result = normalize(input);
      expect(result).not.toContain('**');
      expect(result).not.toContain('//');
      expect(result).not.toContain('(inferred)');
    });

    it('handles whitespace normalization', () => {
      const input = 'lesson   with   multiple   spaces';
      const result = normalize(input);
      expect(result).toBe('lesson with multiple spaces');
    });
  });
});
