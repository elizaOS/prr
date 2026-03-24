/**
 * Metrics calculation for eval results
 */

import type {
  ToolName,
  ToolMetrics,
  PRRMetrics,
  PillMetrics,
  SplitPlanMetrics,
  StoryMetrics,
  EvalResult,
  ExpectedOutcome,
} from './types.js';

/**
 * Calculate PRR-specific metrics
 */
export function calculatePRRMetrics(
  result: EvalResult,
  expected: ExpectedOutcome
): PRRMetrics {
  const state = result.outputs?.state || {};
  const verifiedFixed = state.verifiedFixed || [];
  const dismissedIssues = state.dismissedIssues || [];
  const finalUnresolvedIssues = state.finalUnresolvedIssues || [];

  // Expected outcomes
  const expectedFixes = expected.expectedFixes || [];
  const expectedDismissals = expected.expectedDismissals || [];
  const expectedRemaining = expected.expectedRemaining || [];

  // Calculate fix rate: (actual fixes) / (expected fixes)
  const totalExpectedToFix = expectedFixes.length;
  const actualFixes = verifiedFixed.length;
  const fixRate = totalExpectedToFix > 0 ? actualFixes / totalExpectedToFix : 0;

  // Calculate false positive rate: (fixed but shouldn't be) / (total fixed)
  // A false positive is when we fixed something that wasn't in expectedFixes
  const fixedCommentIds = new Set(verifiedFixed);
  const expectedFixIds = new Set(expectedFixes.map(f => f.commentId));
  const falsePositives = verifiedFixed.filter(id => !expectedFixIds.has(id)).length;
  const falsePositiveRate = actualFixes > 0 ? falsePositives / actualFixes : 0;

  // Calculate false negative rate: (should fix but didn't) / (total should fix)
  // A false negative is when expectedFixes contains something we didn't fix
  const falseNegatives = expectedFixes.filter(f => !fixedCommentIds.has(f.commentId)).length;
  const falseNegativeRate = totalExpectedToFix > 0 ? falseNegatives / totalExpectedToFix : 0;

  // Calculate accuracy: (correct fixes + correct dismissals + correct remaining) / (total)
  const totalIssues = totalExpectedToFix + expectedDismissals.length + expectedRemaining.length;
  let correct = 0;
  
  // Count correct fixes
  for (const expectedFix of expectedFixes) {
    if (fixedCommentIds.has(expectedFix.commentId)) {
      correct++;
    }
  }
  
  // Count correct dismissals
  const dismissedIds = new Set(dismissedIssues.map(d => d.commentId));
  for (const expectedDismissal of expectedDismissals) {
    if (dismissedIds.has(expectedDismissal.commentId)) {
      correct++;
    }
  }
  
  // Count correct remaining (unresolved)
  const remainingIds = new Set(finalUnresolvedIssues.map(r => r.commentId));
  for (const expectedRemainingId of expectedRemaining) {
    if (remainingIds.has(expectedRemainingId)) {
      correct++;
    }
  }
  
  const accuracy = totalIssues > 0 ? correct / totalIssues : 0;

  // Token efficiency: placeholder (would need token usage from result)
  const tokenEfficiency = 0.0;

  // Time efficiency: placeholder (would need timing from result)
  const timeEfficiency = 0.0;

  // Model performance: placeholder (would need per-model stats from result)
  const modelPerformance: Record<string, { fixes: number; failures: number; noChanges: number }> = {};

  return {
    tool: 'prr',
    fixRate,
    falsePositiveRate,
    falseNegativeRate,
    accuracy,
    tokenEfficiency,
    timeEfficiency,
    modelPerformance,
  };
}

/**
 * Calculate pill-specific metrics
 */
export function calculatePillMetrics(
  result: EvalResult,
  expected: ExpectedOutcome
): PillMetrics {
  // TODO: Implement actual metric calculation
  return {
    tool: 'pill',
    improvementRelevance: 0.0,
    severityAccuracy: 0.0,
    coverage: 0.0,
  };
}

/**
 * Calculate split-plan-specific metrics
 */
export function calculateSplitPlanMetrics(
  result: EvalResult,
  expected: ExpectedOutcome
): SplitPlanMetrics {
  // TODO: Implement actual metric calculation
  return {
    tool: 'split-plan',
    dependencyAccuracy: 0.0,
    splitQuality: 0.0,
    mergeOrderCorrectness: 0.0,
  };
}

/**
 * Calculate story-specific metrics
 */
export function calculateStoryMetrics(
  result: EvalResult,
  expected: ExpectedOutcome
): StoryMetrics {
  // TODO: Implement actual metric calculation
  return {
    tool: 'story',
    narrativeQuality: 0.0,
    changelogAccuracy: 0.0,
    completeness: 0.0,
  };
}

/**
 * Calculate tool-specific metrics
 */
export function calculateMetrics(
  tool: ToolName,
  result: EvalResult,
  expected: ExpectedOutcome
): ToolMetrics {
  switch (tool) {
    case 'prr':
      return calculatePRRMetrics(result, expected);
    case 'pill':
      return calculatePillMetrics(result, expected);
    case 'split-plan':
      return calculateSplitPlanMetrics(result, expected);
    case 'story':
      return calculateStoryMetrics(result, expected);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
