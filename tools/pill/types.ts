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
  /**
   * Absolute path to the output log to audit. When unset, uses `join(targetDir, logPrefix-output.log | output.log)`.
   * CLI `--output-log` or env `PILL_OUTPUT_LOG_PATH`.
   */
  outputLogPath?: string;
  /**
   * Absolute path to the prompts log. When unset, uses default name under targetDir.
   * CLI `--prompts-log` or env `PILL_PROMPTS_LOG_PATH`.
   */
  promptsLogPath?: string;
  /** Override path for pill-output.md (e.g. from --instructions-out). */
  instructionsOut?: string;
  /** Max context tokens for the audit request (user + system). Overridable via PILL_CONTEXT_BUDGET_TOKENS. Default 35k; use 20k for small-context models. */
  contextBudgetTokens?: number;
  /** Hard cap on user-message chars per audit HTTP request (chunk size). Set via PILL_AUDIT_MAX_USER_CHARS (6000–80000). */
  auditMaxUserChars?: number;
  /**
   * Max concurrent audit LLM requests when context is chunked (default 4). Set via PILL_AUDIT_CHUNK_CONCURRENCY (1–16).
   * WHY: Slow models + 12k-char chunks can mean hundreds of sequential HTTP calls → multi-hour runs; parallel chunks are independent.
   */
  auditChunkConcurrency: number;
  /**
   * When true, drop improvements whose `file` is not under this repo’s tool layout (tools/, shared/, tests/, …).
   * Default: on if `tools/prr` exists under targetDir; override with PILL_TOOL_REPO_SCOPE_FILTER.
   */
  toolRepoScopeFilter: boolean;
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

