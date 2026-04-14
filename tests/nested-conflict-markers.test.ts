import { describe, expect, it } from 'vitest';
import { hasNestedConflictMarkers } from '../shared/git/git-lock-files.js';

describe('hasNestedConflictMarkers', () => {
  it('returns false for a single standard conflict', () => {
    const s = `before
<<<<<<< HEAD
a
=======
b
>>>>>>> other
after`;
    expect(hasNestedConflictMarkers(s)).toBe(false);
  });

  it('returns true when a second opener appears before =======', () => {
    const s = `<<<<<<< HEAD
<<<<<<< HEAD
inner
=======
inner theirs
>>>>>>> x
=======
outer theirs
>>>>>>> y`;
    expect(hasNestedConflictMarkers(s)).toBe(true);
  });

  it('returns false when markers are sequential regions', () => {
    const s = `<<<<<<< A
1
=======
2
>>>>>>> A
<<<<<<< B
3
=======
4
>>>>>>> B`;
    expect(hasNestedConflictMarkers(s)).toBe(false);
  });
});
