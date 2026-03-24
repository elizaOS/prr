import { describe, expect, it } from 'vitest';
import { extractConflictChunks } from '../tools/prr/git/git-conflict-chunked.js';

describe('extractConflictChunks (nested-aware)', () => {
  it('parses a simple single conflict', () => {
    const s = `line0
<<<<<<< HEAD
a
=======
b
>>>>>>> other
tail`;
    const chunks = extractConflictChunks(s, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.conflictLines.join('\n')).toContain('a');
    expect(chunks[0]!.conflictLines.join('\n')).toContain('>>>>>>> other');
  });

  it('parses nested conflict as one outer region', () => {
    const s = `pre
<<<<<<< HEAD
<<<<<<< HEAD
inner-ours
=======
inner-theirs
>>>>>>> inner
outer-ours-tail
=======
outer-theirs
>>>>>>> outer
post`;
    const chunks = extractConflictChunks(s, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const text = chunks[0]!.conflictLines.join('\n');
    expect(text).toContain('<<<<<<< HEAD');
    expect(text).toContain('>>>>>>> outer');
    expect(text).toContain('inner-ours');
    expect(text).toContain('outer-theirs');
  });

  it('extracts two sequential top-level conflicts', () => {
    const s = `<<<<<<< A
1
=======
2
>>>>>>> A
mid
<<<<<<< B
3
=======
4
>>>>>>> B`;
    const chunks = extractConflictChunks(s, 0);
    expect(chunks).toHaveLength(2);
  });

  it('normalizes leading whitespace on conflict markers', () => {
    const s = `  <<<<<<< HEAD
  a
  =======
  b
  >>>>>>> other
tail`;
    const chunks = extractConflictChunks(s, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.conflictLines[0]).toBe('<<<<<<< HEAD');
  });

  it('repairs two-marker conflict (inserts =======) and still parses following conflict', () => {
    const s = `<<<<<<< broken
only-ours-side
>>>>>>> ref
ok
<<<<<<< good
x
=======
y
>>>>>>> good`;
    const chunks = extractConflictChunks(s, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.conflictLines.join('\n')).toContain('only-ours-side');
    expect(chunks[0]!.conflictLines.join('\n')).toContain('=======');
    expect(chunks[1]!.conflictLines.join('\n')).toContain('x');
    expect(chunks[1]!.conflictLines.join('\n')).toContain('y');
  });
});
