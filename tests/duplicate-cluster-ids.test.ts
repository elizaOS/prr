import { describe, it, expect } from 'vitest';
import { getDuplicateClusterCommentIds } from '../tools/prr/workflow/utils.js';

describe('getDuplicateClusterCommentIds', () => {
  it('returns singleton when map missing', () => {
    expect(getDuplicateClusterCommentIds('a', undefined)).toEqual(['a']);
  });

  it('returns canonical and dupes when id is canonical', () => {
    const m = new Map<string, string[]>([['c1', ['d1', 'd2']]]);
    expect(getDuplicateClusterCommentIds('c1', m)).toEqual(['c1', 'd1', 'd2']);
  });

  it('returns full cluster when id is a duplicate', () => {
    const m = new Map<string, string[]>([['c1', ['d1', 'd2']]]);
    expect(getDuplicateClusterCommentIds('d1', m)).toEqual(['c1', 'd1', 'd2']);
  });
});
