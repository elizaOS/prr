/**
 * Types for eval framework
 */

export type ToolName = 'prr' | 'pill' | 'split-plan' | 'story';

export interface EvalResult {
  tool: ToolName;
  benchmarkName: string;
  timestamp: string;
  commitSha?: string;
  success: boolean;
  error?: string;
  outputs: {
    state?: any;
    logs?: string;
    workdir?: string;
    files?: Record<string, string>;
    [key: string]: any;
  };
  metrics?: ToolMetrics;
}

export interface ToolMetrics {
  tool: ToolName;
  [key: string]: any;
}

export interface PRRMetrics extends ToolMetrics {
  tool: 'prr';
  fixRate: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  accuracy: number;
  tokenEfficiency: number;
  timeEfficiency: number;
  modelPerformance: Record<string, {
    fixes: number;
    failures: number;
    noChanges: number;
  }>;
}

export interface PillMetrics extends ToolMetrics {
  tool: 'pill';
  improvementRelevance: number;
  severityAccuracy: number;
  coverage: number;
}

export interface SplitPlanMetrics extends ToolMetrics {
  tool: 'split-plan';
  dependencyAccuracy: number;
  splitQuality: number;
  mergeOrderCorrectness: number;
}

export interface StoryMetrics extends ToolMetrics {
  tool: 'story';
  narrativeQuality: number;
  changelogAccuracy: number;
  completeness: number;
}

export interface EvalOptions {
  maxFixIterations?: number;
  autoPush?: boolean;
  auditModel?: string;
  [key: string]: any;
}

export interface BenchmarkPR {
  name: string;
  description?: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body?: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  files?: Array<{
    path: string;
    content?: string;
    status: string;
    additions?: number;
    deletions?: number;
  }>;
  comments?: Array<{
    id: string;
    threadId: string;
    author: string;
    path: string;
    line: number | null;
    body: string;
    createdAt: string;
  }>;
  commits?: Array<{
    sha: string;
    message: string;
    authoredDate: string;
  }>;
}

export interface ExpectedOutcome {
  name: string;
  expectedFixes?: Array<{
    commentId: string;
    expectedAction: string;
    expectedFile: string;
    expectedChange?: string;
  }>;
  expectedDismissals?: Array<{
    commentId: string;
    expectedCategory: string;
    expectedReason: string;
  }>;
  expectedRemaining?: string[];
  minFixRate?: number;
  maxFalsePositiveRate?: number;
  minAccuracy?: number;
  [key: string]: any;
}
