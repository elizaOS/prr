import { describe, expect, it } from 'vitest';
import { parseMarkdownReviewIssues } from '../tools/prr/github/api.js';

describe('parseMarkdownReviewIssues', () => {
  it('skips summary/status recap table items', () => {
    const markdown = `## Findings

| Location | Suggestion |
| --- | --- |
| logger.ts | Add JSDoc |
| reply.ts | Still missing tests |`;

    expect(parseMarkdownReviewIssues(markdown)).toEqual([]);
  });

  it('keeps explicit bare-file issues when they are written as actionable items', () => {
    const markdown = `## Blocking Issues

### 1. Missing tests
Add tests for \`reply.ts:106\` so the new path is covered.`;

    expect(parseMarkdownReviewIssues(markdown)).toEqual([
      expect.objectContaining({
        path: 'reply.ts',
        line: 106,
      }),
    ]);
  });
});
