#!/usr/bin/env node
/**
 * eval - Run evaluations on benchmark datasets
 *
 * Standalone tool to run evals manually, compare against baselines,
 * and generate reports.
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { runEval, loadBenchmarkPR, loadBenchmarkLog, loadExpectedOutcome } from '../../tests/evals/runner/eval-runner.js';
import { calculateMetrics } from '../../tests/evals/runner/metrics.js';
import { compareEvals, loadBaselineResult } from '../../tests/evals/runner/comparison.js';
import type { ToolName } from '../../tests/evals/runner/types.js';

const program = new Command();

program
  .name('eval')
  .description('Run evaluations on benchmark datasets')
  .version('1.0.0');

program
  .command('run')
  .description('Run eval on a benchmark')
  .requiredOption('-t, --tool <tool>', 'Tool to evaluate (prr|pill|split-plan|story)')
  .requiredOption('-b, --benchmark <name>', 'Benchmark name')
  .option('--compare', 'Compare against baseline')
  .option('--commit-sha <sha>', 'Commit SHA for baseline comparison')
  .action(async (options) => {
    const tool = options.tool as ToolName;
    const benchmarkName = options.benchmark;

    console.log(chalk.cyan(`\nRunning eval: ${tool} on ${benchmarkName}\n`));

    try {
      // Load benchmark (tool-specific loader)
      const benchmark = tool === 'pill'
        ? loadBenchmarkLog(tool, benchmarkName)
        : loadBenchmarkPR(tool, benchmarkName);
      const expected = loadExpectedOutcome(tool, benchmarkName);

      // Run eval
      const result = await runEval(tool, benchmark, {});

      // Calculate metrics
      const metrics = calculateMetrics(tool, result, expected);
      result.metrics = metrics;

      // Save result
      const { writeFileSync, mkdirSync } = require('fs');
      const { join } = require('path');
      const resultsDir = join(process.cwd(), 'tests/evals/results', tool);
      mkdirSync(resultsDir, { recursive: true });
      const resultFile = join(resultsDir, `${benchmarkName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(resultFile, JSON.stringify(result, null, 2));
      console.log(chalk.gray(`\nResult saved: ${resultFile}`));

      // Also save as latest
      const latestFile = join(resultsDir, `${benchmarkName}-latest.json`);
      writeFileSync(latestFile, JSON.stringify(result, null, 2));

      // Display results
      console.log(chalk.green('✓ Eval completed'));
      console.log(chalk.gray('\nMetrics:'));
      for (const [key, value] of Object.entries(metrics)) {
        if (key !== 'tool' && typeof value === 'number') {
          console.log(chalk.gray(`  ${key}: ${value.toFixed(3)}`));
        }
      }

      // Compare if requested
      if (options.compare) {
        const baseline = loadBaselineResult(tool, benchmarkName, options.commitSha);
        if (baseline) {
          const comparison = compareEvals(result, baseline);
          if (comparison.regressions.length > 0) {
            console.log(chalk.red('\n⚠ Regressions detected:'));
            for (const reg of comparison.regressions) {
              console.log(chalk.red(`  ${reg.metric}: ${reg.current.toFixed(3)} (was ${reg.baseline.toFixed(3)})`));
            }
          }
          if (comparison.improvements.length > 0) {
            console.log(chalk.green('\n✓ Improvements:'));
            for (const imp of comparison.improvements) {
              console.log(chalk.green(`  ${imp.metric}: ${imp.current.toFixed(3)} (was ${imp.baseline.toFixed(3)})`));
            }
          }
        } else {
          console.log(chalk.yellow('\n⚠ No baseline found for comparison'));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List available benchmarks')
  .option('-t, --tool <tool>', 'Filter by tool (prr|pill|split-plan|story)')
  .action((options) => {
    // TODO: Implement benchmark listing
    console.log(chalk.cyan('\nAvailable benchmarks:\n'));
    console.log(chalk.gray('PRR:'));
    console.log(chalk.gray('  - simple-fix'));
    console.log(chalk.gray('  - multiple-comments'));
    console.log(chalk.gray('  - deleted-file'));
    console.log(chalk.gray('\nPill:'));
    console.log(chalk.gray('  - sample-run'));
    console.log(chalk.gray('\nSplit-plan:'));
    console.log(chalk.gray('  - large-pr'));
    console.log(chalk.gray('\nStory:'));
    console.log(chalk.gray('  - feature-pr'));
  });

program.parse();
