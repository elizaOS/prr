/**
 * Custom assertion helpers for PRR scenarios
 */

import { expect } from 'vitest';
import type { EvalResult } from '../../evals/runner/types.js';

// Placeholder type for scenario results until full implementation
export interface ScenarioResult {
  success: boolean;
  outputs?: {
    state?: {
      verifiedFixed?: string[];
      dismissedIssues?: Array<{ commentId: string; category: string }>;
      committedFiles?: string[];
    };
    pushed?: boolean;
  };
  exitReason?: string;
}

/**
 * Assert that a comment was verified as fixed
 */
export function expectVerified(commentId: string, result: EvalResult | ScenarioResult): void {
  const verified = result.outputs?.state?.verifiedFixed || [];
  expect(verified).toContain(commentId);
}

/**
 * Assert that a comment was dismissed
 */
export function expectDismissed(
  commentId: string,
  category: string,
  result: EvalResult | ScenarioResult
): void {
  const dismissed = result.outputs?.state?.dismissedIssues || [];
  const dismissedIssue = dismissed.find((d: any) => d.commentId === commentId);
  expect(dismissedIssue).toBeDefined();
  expect(dismissedIssue?.category).toBe(category);
}

/**
 * Assert that files were committed
 */
export function expectCommitted(files: string[], result: EvalResult | ScenarioResult): void {
  const committed = result.outputs?.state?.committedFiles || [];
  for (const file of files) {
    expect(committed).toContain(file);
  }
}

/**
 * Assert that changes were pushed
 */
export function expectPushed(result: EvalResult | ScenarioResult): void {
  expect(result.outputs?.pushed).toBe(true);
}
