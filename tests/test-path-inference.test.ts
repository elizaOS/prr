import { describe, expect, it } from 'vitest';
import {
  getTestPathForIssueLike,
  normalizeDoubledTestExtension,
  testBasenameWithSuffix,
} from '../tools/prr/analyzer/test-path-inference.js';

describe('testBasenameWithSuffix', () => {
  it('does not double-append .test when stem already ends with .test', () => {
    expect(testBasenameWithSuffix('x402-topup.test', '.ts', 'test')).toBe('x402-topup.test.ts');
    expect(testBasenameWithSuffix('x402-topup', '.ts', 'test')).toBe('x402-topup.test.ts');
  });

  it('does not double-append .spec when stem already ends with .spec', () => {
    expect(testBasenameWithSuffix('foo.spec', '.tsx', 'spec')).toBe('foo.spec.tsx');
  });
});

describe('normalizeDoubledTestExtension', () => {
  it('collapses .test.test and .spec.spec', () => {
    expect(normalizeDoubledTestExtension('__tests__/a.test.test.ts')).toBe('__tests__/a.test.ts');
    expect(normalizeDoubledTestExtension('b.spec.spec.js')).toBe('b.spec.js');
  });
});

describe('getTestPathForIssueLike', () => {
  it('infers colocated test path without .test.test when source is already *.test.ts', () => {
    const path = getTestPathForIssueLike(
      {
        comment: {
          path: 'packages/foo/bar.test.ts',
          body: 'Add coverage for edge case',
        },
      },
      { keepExistingTestPath: true },
    );
    expect(path).toBe('packages/foo/bar.test.ts');
  });

  it('maps source file to single .test suffix', () => {
    const path = getTestPathForIssueLike(
      {
        comment: {
          path: 'src/util/pay.ts',
          body: 'missing tests',
        },
      },
      {},
    );
    expect(path).toBe('src/util/pay.test.ts');
  });
});
