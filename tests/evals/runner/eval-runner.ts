/**
 * Eval runner - executes tools on benchmarks and collects results
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ToolName, EvalResult, EvalOptions, BenchmarkPR, ExpectedOutcome } from './types.js';
import { createTestRepo } from '../../test-utils/git-helpers.js';
import { createMockGitHubAPI } from '../../test-utils/github-mock.js';
import { createMockLLMClient } from '../../test-utils/llm-mock.js';
import { loadConfig } from '../../../shared/config.js';
import { GitHubAPI } from '../../../tools/prr/github/api.js';
import { LLMClient } from '../../../tools/prr/llm/client.js';
import { PRResolver } from '../../../tools/prr/resolver.js';
import { initOutputLog, closeOutputLog, getOutputLogPath } from '../../../shared/logger.js';
import type { PRInfo, ReviewComment } from '../../../tools/prr/github/types.js';

const BENCHMARK_BASE = join(process.cwd(), 'tests/evals/benchmark');

/**
 * Load benchmark PR fixture
 */
export function loadBenchmarkPR(tool: ToolName, name: string): BenchmarkPR {
  const path = join(BENCHMARK_BASE, tool, 'prs', `${name}.json`);
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content);
}

/**
 * Load expected outcome
 */
export function loadExpectedOutcome(tool: ToolName, name: string): ExpectedOutcome {
  const path = join(BENCHMARK_BASE, tool, 'expected', `${name}.json`);
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content);
}

/**
 * Run PRR eval on a benchmark PR
 * 
 * NOTE: This is a simplified eval runner. For full integration testing,
 * consider using scenario tests. This eval focuses on metrics collection.
 */
export async function runPRREval(
  benchmark: BenchmarkPR,
  options: EvalOptions = {}
): Promise<EvalResult> {
  const workdir = mkdtempSync(join(tmpdir(), 'prr-eval-'));
  const outputLogPath = join(workdir, 'output.log');
  let outputLog = '';
  let testRepo: ReturnType<typeof createTestRepo> | null = null;

  try {
    // Initialize output logging to capture PRR's output
    initOutputLog({ outputPath: outputLogPath });

    // Create test repository with benchmark files
    testRepo = createTestRepo({
      files: benchmark.files?.map(f => ({
        path: f.path,
        content: f.content || '',
      })) || [],
      baseBranch: benchmark.baseBranch || 'main',
      featureBranch: benchmark.branch,
      commits: benchmark.files ? [{
        message: benchmark.title,
        files: benchmark.files.map(f => ({
          path: f.path,
          content: f.content || '',
        })),
      }] : [],
    });

    // Convert benchmark to PRInfo and ReviewComment[]
    const prInfo: PRInfo = {
      owner: benchmark.owner,
      repo: benchmark.repo,
      number: benchmark.number,
      title: benchmark.title,
      body: benchmark.body || '',
      branch: benchmark.branch,
      baseBranch: benchmark.baseBranch,
      headSha: benchmark.headSha,
      cloneUrl: `https://github.com/${benchmark.owner}/${benchmark.repo}.git`,
      mergeable: true,
      mergeableState: 'clean',
    };

    const comments: ReviewComment[] = (benchmark.comments || []).map(c => ({
      id: c.id,
      threadId: c.threadId,
      author: c.author,
      path: c.path,
      line: c.line,
      body: c.body,
      createdAt: c.createdAt,
      databaseId: c.id, // Use id as databaseId for eval purposes
    }));

    // For evals, we'll simulate PRR execution by:
    // 1. Setting up the test environment
    // 2. Running a simplified workflow that exercises core logic
    // 3. Collecting results
    
    // TODO: Integrate with actual PRR workflow when we have better dependency injection
    // For now, return structured results that metrics can process
    
    // Simulate verification: check if files match expected fixes
    const verifiedFixed: string[] = [];
    const dismissedIssues: Array<{ commentId: string; category: string; reason: string }> = [];
    const finalUnresolvedIssues: Array<{ commentId: string; path: string; line: number | null }> = [];

    // Simple heuristic: if a comment's expected fix is in the file, mark as verified
    // This is a placeholder - real implementation would run PRR workflow
    for (const comment of comments) {
      try {
        const filePath = join(testRepo.workdir, comment.path);
        const fileContent = readFileSync(filePath, 'utf-8');
        
        // Check if the problematic pattern is still present
        // This is a simplified check - real PRR would use LLM verification
        if (comment.body.includes('null!') && fileContent.includes('null!')) {
          finalUnresolvedIssues.push({
            commentId: comment.id,
            path: comment.path,
            line: comment.line,
          });
        } else if (comment.body.includes('null!') && !fileContent.includes('null!')) {
          // Pattern was removed - likely fixed
          verifiedFixed.push(comment.id);
        }
      } catch {
        // File doesn't exist or can't be read
        dismissedIssues.push({
          commentId: comment.id,
          category: 'missing-file',
          reason: 'File not found in workdir',
        });
      }
    }

    // Read output log
    try {
      outputLog = readFileSync(outputLogPath, 'utf-8');
    } catch {
      // Log file might not exist
    }

    return {
      tool: 'prr',
      benchmarkName: benchmark.name,
      timestamp: new Date().toISOString(),
      success: true,
      outputs: {
        state: {
          verifiedFixed,
          dismissedIssues,
          finalUnresolvedIssues,
        },
        logs: outputLog,
        workdir: testRepo.workdir,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      tool: 'prr',
      benchmarkName: benchmark.name,
      timestamp: new Date().toISOString(),
      success: false,
      error: errorMessage,
      outputs: {
        logs: outputLog,
        workdir,
      },
    };
  } finally {
    closeOutputLog();
    if (testRepo) {
      testRepo.cleanup();
    }
    // Clean up workdir
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Load benchmark log fixture (for pill)
 */
export function loadBenchmarkLog(tool: ToolName, name: string): any {
  const path = join(BENCHMARK_BASE, tool, 'logs', `${name}.json`);
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content);
}

/**
 * Run pill eval on benchmark logs
 */
export async function runPillEval(
  benchmark: any,
  options: EvalOptions = {}
): Promise<EvalResult> {
  // TODO: Actually execute pill on the benchmark logs
  // For now, return placeholder structure
  return {
    tool: 'pill',
    benchmarkName: benchmark.name,
    timestamp: new Date().toISOString(),
    success: true,
    outputs: {
      improvements: [],
    },
  };
}

/**
 * Run split-plan eval on a benchmark PR
 */
export async function runSplitPlanEval(
  benchmark: BenchmarkPR,
  options: EvalOptions = {}
): Promise<EvalResult> {
  // TODO: Actually execute split-plan on the benchmark PR
  return {
    tool: 'split-plan',
    benchmarkName: benchmark.name,
    timestamp: new Date().toISOString(),
    success: true,
    outputs: {
      plan: '',
    },
  };
}

/**
 * Run story eval on a benchmark PR
 */
export async function runStoryEval(
  benchmark: BenchmarkPR,
  options: EvalOptions = {}
): Promise<EvalResult> {
  // TODO: Actually execute story on the benchmark PR
  return {
    tool: 'story',
    benchmarkName: benchmark.name,
    timestamp: new Date().toISOString(),
    success: true,
    outputs: {
      narrative: '',
      changelog: '',
    },
  };
}

/**
 * Tool-agnostic eval runner
 */
export async function runEval(
  tool: ToolName,
  benchmark: BenchmarkPR | any,
  options: EvalOptions = {}
): Promise<EvalResult> {
  switch (tool) {
    case 'prr':
      return runPRREval(benchmark as BenchmarkPR, options);
    case 'pill':
      return runPillEval(benchmark, options);
    case 'split-plan':
      return runSplitPlanEval(benchmark as BenchmarkPR, options);
    case 'story':
      return runStoryEval(benchmark as BenchmarkPR, options);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
