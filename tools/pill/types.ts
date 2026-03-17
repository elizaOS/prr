export interface PillConfig {
  targetDir: string;
  llmProvider: 'anthropic' | 'openai' | 'elizacloud';
  auditModel: string;
  llmModel: string;
  elizacloudApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** '' | undefined = output.log; 'story' = story-output.log; 'pill' = pill-output.log */
  logPrefix?: string;
  /** Override path for pill-output.md (e.g. from --instructions-out). */
  instructionsOut?: string;
  outputOnly: boolean;
  promptsOnly: boolean;
  dryRun: boolean;
  verbose: boolean;
}

export interface PillContext {
  docs: string;
  sourceFiles: string;
  directoryTree: string;
  outputLog: string;
  promptsDigest?: string;
  /** Set when context was trimmed to stay under audit request budget (avoids 504/timeout). */
  contextTrimmed?: boolean;
}

export interface ImprovementPlan {
  /** Hypeman summary for console (engaging, high-stakes). */
  pitch: string;
  summary: string;
  improvements: Improvement[];
}

export interface Improvement {
  file: string;
  description: string;
  rationale: string;
  severity: 'critical' | 'important' | 'minor';
  category: 'code' | 'docs';
}

/** Per-chapter output when story-reading logs (from shared story-read). */
export type { ChapterAnalysis } from '../../shared/llm/story-read.js';

