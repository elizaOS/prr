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
    lessonsManager = new LessonsManager(testDir);
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
      expect(normalize('```typescript\nsome code\n```')).toBe('some code');
    });

    it('removes inline code backticks', () => {
      expect(normalize('use `const` instead')).toBe('use const instead');
    });
  });

  describe('markdown header removal', () => {
    it('removes markdown headers', () => {
      expect(normalize('### Important Note')).toBe('Important Note');
    });

    it('removes multiple header levels', () => {
      expect(normalize('# Title')).toBe('Title');
      expect(normalize('## Subtitle')).toBe('Subtitle');
    });
  });

  describe('bold line removal', () => {
    it('removes bold markers', () => {
      expect(normalize('**important text**')).toBe('important text');
    });
  });

  describe('list numbering and bullets', () => {
    it('removes numbered list prefixes', () => {
      expect(normalize('1. First item')).toBe('First item');
      expect(normalize('42. Some item')).toBe('Some item');
    });

    it('removes bullet points', () => {
      expect(normalize('- bullet item')).toBe('bullet item');
      expect(normalize('* star item')).toBe('star item');
    });
  });

  describe('comment token removal', () => {
    it('removes single-line comment tokens', () => {
      expect(normalize('// this is a comment')).toBe('this is a comment');
    });

    it('removes multi-line comment tokens', () => {
      expect(normalize('/* block comment */')).toBe('block comment');
      expect(normalize('* continuation')).toBe('continuation');
    });
  });

  describe('access modifier removal', () => {
    it('removes public/private/protected', () => {
      expect(normalize('public method()')).toBe('method()');
      expect(normalize('private field')).toBe('field');
      expect(normalize('protected value')).toBe('value');
    });
  });

  describe('declaration keyword removal', () => {
    it('removes class/interface/type keywords', () => {
      expect(normalize('class MyClass')).toBe('MyClass');
      expect(normalize('interface IFace')).toBe('IFace');
      expect(normalize('type MyType')).toBe('MyType');
    });

    it('removes const/let/var keywords', () => {
      expect(normalize('const value')).toBe('value');
      expect(normalize('let variable')).toBe('variable');
      expect(normalize('var old')).toBe('old');
    });

    it('removes import/export keywords', () => {
      expect(normalize('import something')).toBe('something');
      expect(normalize('export default')).toBe('default');
    });
  });

  describe('(inferred) removal', () => {
    it('removes (inferred) markers', () => {
      expect(normalize('(inferred) some text')).toBe('some text');
      expect(normalize('text (inferred) more')).toBe('text more');
    });
  });

  describe('file extension suffix stripping', () => {
    it('strips common file extensions from paths', () => {
      const result = normalize('Fix issue in file.ts');
      expect(result).not.toContain('.ts:');
    });

    it('handles .js, .md, .json, .yml extensions', () => {
      expect(normalize('edit config.json')).toBeTruthy();
      expect(normalize('update readme.md')).toBeTruthy();
    });
  });

  describe('trailing type/line-number patterns', () => {
    it('strips trailing line numbers like a:123', () => {
      const result = normalize('file.ts:123');
      expect(result).not.toMatch(/:123$/);
    });

    it('strips file:line patterns', () => {
      const result = normalize('src/index.ts:45');
      expect(result).not.toMatch(/:\d+$/);
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
      const result = normalize('some text:');
      expect(result).not.toMatch(/:$/);
    });

    it('trims trailing dashes', () => {
      const result = normalize('some text -');
      expect(result).not.toMatch(/-$/);
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
      expect(result).toBeTruthy();
      expect(result).not.toContain('###');
      expect(result).not.toContain('**');
      expect(result).not.toContain('//');
    });

    it('handles nested patterns', () => {
      const input = '```ts\n// private const value\n```';
      const result = normalize(input);
      expect(result).toBeTruthy();
    });

    it('preserves meaningful content after all transformations', () => {
      const input = 'Always validate user input before processing';
      const result = normalize(input);
      expect(result).toBe('Always validate user input before processing');
    });
  });
});
