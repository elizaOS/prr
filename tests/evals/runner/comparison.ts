/**
 * Comparison logic for regression detection
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import type { EvalResult, ToolMetrics } from './types.js';

const RESULTS_DIR = join(process.cwd(), 'tests/evals/results');

export interface ComparisonResult {
  tool: string;
  benchmarkName: string;
  current: ToolMetrics;
  baseline: ToolMetrics | null;
  regressions: Array<{
    metric: string;
    current: number;
    baseline: number;
    change: number;
    threshold: number;
  }>;
  improvements: Array<{
    metric: string;
    current: number;
    baseline: number;
    change: number;
  }>;
}

/**
 * Load baseline result from previous commit
 */
export function loadBaselineResult(
  tool: string,
  benchmarkName: string,
  commitSha?: string
): EvalResult | null {
  try {
    // Look for baseline file: results/{tool}/{benchmarkName}-{commitSha}.json
    // If no commitSha, look for latest: results/{tool}/{benchmarkName}-latest.json
    const baselineFile = commitSha
      ? join(RESULTS_DIR, tool, `${benchmarkName}-${commitSha}.json`)
      : join(RESULTS_DIR, tool, `${benchmarkName}-latest.json`);
    
    if (existsSync(baselineFile)) {
      const content = readFileSync(baselineFile, 'utf-8');
      return JSON.parse(content);
    }
    
    // Fallback: look for any file matching the pattern
    const { readdirSync } = require('fs');
    const toolDir = join(RESULTS_DIR, tool);
    if (existsSync(toolDir)) {
      const files = readdirSync(toolDir);
      const matchingFiles = files.filter((f: string) => 
        f.startsWith(`${benchmarkName}-`) && f.endsWith('.json')
      );
      if (matchingFiles.length > 0) {
        // Use the most recent one (by modification time)
        const sortedFiles = matchingFiles.map((f: string) => ({
          name: f,
          path: join(toolDir, f),
          mtime: require('fs').statSync(join(toolDir, f)).mtime,
        })).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        
        const content = readFileSync(sortedFiles[0].path, 'utf-8');
        return JSON.parse(content);
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Compare current eval result with baseline
 */
export function compareEvals(
  current: EvalResult,
  baseline: EvalResult | null,
  thresholds: Record<string, number> = {}
): ComparisonResult {
  const tool = current.tool;
  const benchmarkName = current.benchmarkName;
  const currentMetrics = current.metrics || {};
  const baselineMetrics = baseline?.metrics || null;

  const regressions: ComparisonResult['regressions'] = [];
  const improvements: ComparisonResult['improvements'] = [];

  if (baselineMetrics) {
    // Compare metrics
    for (const [metric, currentValue] of Object.entries(currentMetrics)) {
      if (typeof currentValue !== 'number') continue;
      const baselineValue = baselineMetrics[metric];
      if (typeof baselineValue !== 'number') continue;

      const change = currentValue - baselineValue;
      const threshold = thresholds[metric] || 0.1; // 10% default threshold

      if (change < -threshold) {
        // Regression: metric decreased significantly
        regressions.push({
          metric,
          current: currentValue,
          baseline: baselineValue,
          change,
          threshold,
        });
      } else if (change > threshold) {
        // Improvement: metric increased significantly
        improvements.push({
          metric,
          current: currentValue,
          baseline: baselineValue,
          change,
        });
      }
    }
  }

  return {
    tool,
    benchmarkName,
    current: currentMetrics as ToolMetrics,
    baseline: baselineMetrics,
    regressions,
    improvements,
  };
}
