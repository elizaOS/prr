# Evaluation Framework

This directory contains the evaluation framework for all stochastic tools in the PRR codebase.

## Structure

- `benchmark/` - Golden datasets for each tool
  - `prr/` - PRR benchmark PRs and expected outcomes
  - `pill/` - Pill benchmark logs and expected improvements
  - `split-plan/` - Split-plan benchmark PRs and expected plans
  - `story/` - Story benchmark PRs and expected narratives
- `runner/` - Eval execution engine
  - `eval-runner.ts` - Tool-agnostic runner with tool-specific implementations
  - `metrics.ts` - Tool-specific metrics calculation
  - `comparison.ts` - Regression detection
  - `types.ts` - Type definitions
- `results/` - Eval results storage (JSON files)
- `prr/`, `pill/`, `split-plan/`, `story/` - Tool-specific eval test files

## Usage

### Running evals manually

```bash
# Run eval on a specific benchmark
npm run eval -- run -t prr -b simple-fix

# Compare against baseline
npm run eval -- run -t prr -b simple-fix --compare

# List available benchmarks
npm run eval -- list
```

### Running evals in tests

```typescript
import { runPRREval, loadBenchmarkPR, loadExpectedOutcome } from '../runner/eval-runner.js';
import { calculateMetrics } from '../runner/metrics.js';

const benchmark = loadBenchmarkPR('prr', 'simple-fix');
const expected = loadExpectedOutcome('prr', 'simple-fix');
const result = await runPRREval(benchmark, {});
const metrics = calculateMetrics('prr', result, expected);
```

## Metrics

Each tool has specific metrics:

- **PRR**: fix rate, accuracy, false positives/negatives, token/time efficiency
- **Pill**: improvement relevance, severity accuracy, coverage
- **Split-plan**: dependency accuracy, split quality, merge order correctness
- **Story**: narrative quality, changelog accuracy, completeness

## CI Integration

Evals run in CI via `.github/workflows/eval.yml`:
- Fast evals on PRs (subset of benchmarks)
- Full evals on main branch
- Regression detection and alerts
