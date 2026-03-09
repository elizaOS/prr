import { describe, it, expect, afterEach } from 'vitest';
import * as Reporter from '../tools/prr/ui/reporter.js';
import type { UnresolvedIssue } from '../tools/prr/analyzer/types.js';
import type { ReviewComment } from '../tools/prr/github/types.js';

function makeIssue(overrides: Partial<UnresolvedIssue> & { verifierContradiction?: string }): UnresolvedIssue {
  const comment: ReviewComment = {
    id: 'test-id',
    threadId: 'thread-1',
    author: 'bot',
    body: 'Review: add null check here',
    path: 'src/foo.ts',
    line: 10,
    createdAt: new Date().toISOString(),
  };
  return {
    comment,
    codeSnippet: 'const x = 1;',
    stillExists: true,
    explanation: 'Issue still present.',
    ...overrides,
  };
}

describe('printAfterActionReport — Verifier said', () => {
  let logCalls: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    logCalls = [];
  });

  it('includes "Verifier said (why still not fixed):" when issue has verifierContradiction', async () => {
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    const issue = makeIssue({
      verifierContradiction: 'getHistoricalPrices method not found in Current Code; restore historical endpoint or rename method.',
    });
    await Reporter.printAfterActionReport(
      [issue],
      [issue.comment],
      false, // noAfterAction
      null,
      null
    );
    const out = logCalls.join('\n');
    expect(out).toContain('Verifier said (why still not fixed)');
    expect(out).toContain('getHistoricalPrices method not found');
  });

  it('does not include Verifier said when verifierContradiction is missing', async () => {
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    const issue = makeIssue({});
    await Reporter.printAfterActionReport(
      [issue],
      [issue.comment],
      false,
      null,
      null
    );
    const out = logCalls.join('\n');
    expect(out).not.toContain('Verifier said (why still not fixed)');
  });
});
