import { describe, it, expect } from 'vitest';
import { getConsolidateDuplicateTargetPath } from '../tools/prr/analyzer/prompt-builder.js';
import type { UnresolvedIssue } from '../tools/prr/analyzer/types.js';

function makeIssue(path: string, body: string): UnresolvedIssue {
  return {
    comment: {
      id: '1',
      threadId: 't',
      author: 'a',
      body,
      path,
      line: 1,
      createdAt: '',
    },
    codeSnippet: '',
    stillExists: true,
    explanation: '',
  };
}

describe('getConsolidateDuplicateTargetPath', () => {
  it('skips db-errors and returns the next path in body order', () => {
    const issue = makeIssue(
      'src/views/error-ui.tsx',
      'Duplication with lib/utils/db-errors.ts — also matches packages/api/errors.ts',
    );
    expect(getConsolidateDuplicateTargetPath(issue)).toBe('packages/api/errors.ts');
  });

  it('matches packages/ and shared/ roots', () => {
    const issue = makeIssue(
      'apps/web/foo.ts',
      'Consolidate duplicate logic with shared/lib/format.ts',
    );
    expect(getConsolidateDuplicateTargetPath(issue)).toBe('shared/lib/format.ts');
  });

  it('normalizes backslash comment path when comparing', () => {
    const issue = makeIssue(
      'src\\a\\b.ts',
      'Remove duplication in packages/c/d.ts',
    );
    expect(getConsolidateDuplicateTargetPath(issue)).toBe('packages/c/d.ts');
  });

  it('returns null when every mention is db-errors or the comment path', () => {
    const issue = makeIssue(
      'src/x.ts',
      'Duplication: align with lib/utils/db-errors.ts only',
    );
    expect(getConsolidateDuplicateTargetPath(issue)).toBeNull();
  });
});
