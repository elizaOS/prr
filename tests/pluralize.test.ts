import { describe, it, expect } from 'vitest';
import { pluralize } from '../shared/logger.js';

describe('pluralize', () => {
  it('uses singular for exactly one', () => {
    expect(pluralize(1, 'issue')).toBe('issue');
  });

  it('uses default plural for zero and plural counts', () => {
    expect(pluralize(0, 'file')).toBe('files');
    expect(pluralize(2, 'file')).toBe('files');
  });

  it('accepts explicit plural form', () => {
    expect(pluralize(0, 'child', 'children')).toBe('children');
    expect(pluralize(3, 'child', 'children')).toBe('children');
  });
});
