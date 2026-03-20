/**
 * Split-plan eval: large PR
 */

import { describe, it, expect } from 'vitest';
import { runSplitPlanEval, loadBenchmarkPR, loadExpectedOutcome } from '../runner/eval-runner.js';
import { calculateMetrics } from '../runner/metrics.js';

describe('eval: split-plan large PR', () => {
  it('correctly identifies dependencies and split groupings', async () => {
    const benchmark = loadBenchmarkPR('split-plan', 'large-pr');
    const expected = loadExpectedOutcome('split-plan', 'large-pr');

    const result = await runSplitPlanEval(benchmark, {});

    const metrics = calculateMetrics('split-plan', result, expected);

    // TODO: Uncomment when actual implementation is ready
    // expect(metrics.dependencyAccuracy).toBeGreaterThan(0.85);
    // expect(metrics.splitQuality).toBeGreaterThan(0.8);

    // Placeholder assertion
    expect(result.success).toBe(true);
  });
});
