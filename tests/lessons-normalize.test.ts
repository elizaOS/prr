import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LessonsManager } from '../src/state/lessons';
import * as fs from 'fs';
import * as path from 'path';

describe('normalizeLessonText', () => {
  let lessonsManager: LessonsManager;
  const testDir = '/tmp/test-lessons-normalize';

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    lessonsManager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Helper to access private method
  const normalize = (text: string): string | null => {
    return (lessonsManager as any).normalizeLessonText(text);
  };

  describe('code fence removal', () => {
    it('removes code fences', () => {
      expect(normalize('```typescript\nsome code\n```')).toBeNull();
    });

    it('removes inline code backticks', () => {
      expect(normalize('use `const` instead')).toBeNull();
    });
  });

  describe('markdown header removal', () => {
    it('removes markdown headers', () => {
      expect(normalize('### Important Note')).toBeNull();
    });

    it('removes multiple header levels', () => {
      expect(normalize('# Title')).toBeNull();
      expect(normalize('## Subtitle')).toBeNull();
    });
  });

  describe('bold line removal', () => {
    it('removes bold markers', () => {
      expect(normalize('**important text**')).toBeNull();
    });
  });

  describe('list numbering and bullets', () => {
    it('removes numbered list prefixes', () => {
      expect(normalize('1. First item')).toBeNull();
      expect(normalize('42. Some item')).toBeNull();
    });

    it('removes bullet points', () => {
      expect(normalize('- bullet item')).toBeNull();
      expect(normalize('* star item')).toBeNull();
    });
  });

  describe('comment token removal', () => {
    it('removes single-line comment tokens', () => {
      expect(normalize('// this is a comment')).toBeNull();
    });

    it('removes multi-line comment tokens', () => {
      expect(normalize('/* block comment */')).toBeNull();
      expect(normalize('* continuation')).toBeNull();
    });
  });

  describe('access modifier removal', () => {
    it('removes public/private/protected', () => {
      expect(normalize('public method()')).toBeNull();
      expect(normalize('private field')).toBeNull();
      expect(normalize('protected value')).toBeNull();
    });
  });

  describe('declaration keyword removal', () => {
    it('removes class/interface/type keywords', () => {
      expect(normalize('class MyClass')).toBeNull();
      expect(normalize('interface IFace')).toBeNull();
      expect(normalize('type MyType')).toBeNull();
    });

    it('removes const/let/var keywords', () => {
      expect(normalize('const value')).toBeNull();
      expect(normalize('let variable')).toBeNull();
      expect(normalize('var old')).toBeNull();
    });

    it('removes import/export keywords', () => {
      expect(normalize('import something')).toBeNull();
      expect(normalize('export default')).toBeNull();
    });
  });

  describe('(inferred) removal', () => {
    it('removes (inferred) markers', () => {
      expect(normalize('(inferred) some text')).toBeNull();
      expect(normalize('text (inferred) more')).toBeNull();
    });
  });

  describe('file extension suffix stripping', () => {
    it('strips common file extensions from paths', () => {
      const result = normalize('Fix issue in file.ts');
      expect(result).not.toContain('.ts:');
    });

    it('handles .js, .md, .json, .yml extensions', () => {
      expect(normalize('edit config.json carefully before release')).toBeTruthy();
      expect(normalize('update readme.md with release steps')).toBeTruthy();
    });
  });

  describe('trailing type/line-number patterns', () => {
    it('strips trailing line numbers like a:123', () => {
      const result = normalize('file.ts:123');
      expect(result).toBeNull();
    });

    it('strips file:line patterns', () => {
      const result = normalize('src/index.ts:45');
      expect(result).toBeNull();
    });
  });

  describe('made no changes normalization', () => {
    it('normalizes "tool made no changes"', () => {
      const result = normalize('tool made no changes without explanation');
      expect(result).toBe('tool made no changes without explanation');
    });

    it('normalizes "fixer made no changes"', () => {
      const result = normalize('fixer made no changes without explanation');
      expect(result).toBe('fixer made no changes without explanation');
    });

    it('normalizes with "trying different approach"', () => {
      const result = normalize('tool made no changes - trying different approach');
      expect(result).toBe('tool made no changes - trying different approach');
    });

    it('normalizes runner-prefixed variants', () => {
      const result = normalize('claude-code made no changes without explanation');
      expect(result).toBe('tool made no changes without explanation');
    });

    it('collapses numeric prefixes', () => {
      const result = normalize('42 made no changes');
      expect(result).toBe('tool made no changes');
    });
  });

  describe('truncated and Fix for cases returning null', () => {
    it('returns null for "chars truncated"', () => {
      expect(normalize('500 chars truncated')).toBeNull();
      expect(normalize('some text chars truncated here')).toBeNull();
    });

    it('returns null for "Fix for file:null"', () => {
      expect(normalize('Fix for src/file.ts:null')).toBeNull();
    });

    it('returns null for "Fix for file:undefined"', () => {
      expect(normalize('Fix for src/file.ts:undefined')).toBeNull();
    });

    it('returns null for "Fix for file:123"', () => {
      expect(normalize('Fix for src/file.ts:123')).toBeNull();
    });

    it('returns null for "Fix for file" without line', () => {
      expect(normalize('Fix for src/file.ts')).toBeNull();
    });

    it('returns null for bare numbers', () => {
      expect(normalize('123')).toBeNull();
      expect(normalize('42.')).toBeNull();
    });
  });

  describe('trimming and cleanup', () => {
    it('trims trailing colons', () => {
      const result = normalize('Always document decisions:');
      expect(result).toBe('Always document decisions');
    });

    it('trims trailing dashes', () => {
      const result = normalize('Always document decisions -');
      expect(result).toBe('Always document decisions');
    });

    it('returns null for empty result', () => {
      expect(normalize('')).toBeNull();
      expect(normalize('   ')).toBeNull();
    });
  });

  describe('combined/edge inputs', () => {
    it('handles multiple transformations in sequence', () => {
      const input = '### **1. // public class MyClass**';
      const result = normalize(input);
      expect(result).toBeNull();
    });

    it('handles nested patterns', () => {
      const input = '```ts\n// private const value\n```';
      const result = normalize(input);
      expect(result).toBeNull();
    });

    it('preserves meaningful content after all transformations', () => {
      const input = 'Always validate user input before processing';
      const result = normalize(input);
      expect(result).toBe('Always validate user input before processing');
    });
  });
});
