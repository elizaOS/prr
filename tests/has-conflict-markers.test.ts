import { describe, expect, it } from 'vitest';
import {
  hasConflictMarkers,
  isGitConflictMiddleLine,
  isGitConflictOpenLine,
  isGitConflictCloseLine,
} from '../shared/git/git-lock-files.js';

describe('hasConflictMarkers', () => {
  it('returns true for full standard conflict', () => {
    const s = `intro
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
outro`;
    expect(hasConflictMarkers(s)).toBe(true);
  });

  it('returns false for markdown setext-style Title then ======= then body (single mid, no open/close)', () => {
    const s = `Title
=======
Section

More body.`;
    expect(hasConflictMarkers(s)).toBe(false);
  });

  it('returns true for orphan >>>>>>> (failed cleanup of closer)', () => {
    const s = 'line\n>>>>>>> branch-name\n';
    expect(hasConflictMarkers(s)).toBe(true);
  });

  it('returns true for orphan ======= alone (failed cleanup of middle, no open/close)', () => {
    const s = `left content
=======
right content
`;
    expect(hasConflictMarkers(s)).toBe(true);
  });

  it('returns true for two ======= lines without open/close (broken merge state)', () => {
    const s = `a
=======
b
=======
c
`;
    expect(hasConflictMarkers(s)).toBe(true);
  });

  it('returns true for ======= when >>>>>>> exists even without <<<<<<<', () => {
    const s = `merged badly
=======
theirs-side
>>>>>>> origin/main
`;
    expect(hasConflictMarkers(s)).toBe(true);
  });

  it('returns true for indented conflict opener', () => {
    const s = '  <<<<<<< HEAD\n  x\n';
    expect(hasConflictMarkers(s)).toBe(true);
  });

  it('returns false for clean file', () => {
    expect(hasConflictMarkers('no markers here\n')).toBe(false);
  });

  it('returns false for eight equals divider (not git middle marker)', () => {
    const s = `Title
========
Section`;
    expect(hasConflictMarkers(s)).toBe(false);
  });
});

describe('marker predicates', () => {
  it('isGitConflictMiddleLine is exactly seven equals', () => {
    expect(isGitConflictMiddleLine('=======')).toBe(true);
    expect(isGitConflictMiddleLine('=======  ')).toBe(true);
    expect(isGitConflictMiddleLine('========')).toBe(false);
    expect(isGitConflictMiddleLine('===  ')).toBe(false);
  });

  it('open/close line helpers', () => {
    expect(isGitConflictOpenLine('<<<<<<< HEAD')).toBe(true);
    expect(isGitConflictCloseLine('>>>>>>> x')).toBe(true);
  });
});
