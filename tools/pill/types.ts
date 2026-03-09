export interface PillConfig {
  targetDir: string;
  llmProvider: 'anthropic' | 'openai' | 'elizacloud';
  auditModel: string;
  llmModel: string;
  elizacloudApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  tool: string;
  fixerModel?: string;
  maxCycles: number;
  outputOnly: boolean;
  promptsOnly: boolean;
  commit: boolean;
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
}

export interface PillContext {
  docs: string;
  sourceFiles: string;
  directoryTree: string;
  outputLog: string;
  promptsDigest?: string;
}

export interface ImprovementPlan {
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

export interface VerifyResult {
  status: 'clean' | 'issues';
  issues?: Improvement[];
}

/** Per-chapter output when story-reading logs */
export interface ChapterAnalysis {
  observations: string[];
  answeredQuestions: string[];
  confirmedPredictions: string[];
  refutedPredictions: string[];
  newQuestions: string[];
  newPredictions: string[];
  threads: string[];
}

// ─── Audit cycles (per-directory, AUDIT-CYCLES.md–like storage) ─────────────────

/** Severity for findings: High = regression/data-loss, Medium = correctness/UX, Low = minor/cosmetic. */
export type AuditFindingSeverity = 'high' | 'medium' | 'low';

/** One recorded audit cycle for a directory (mirrors AUDIT-CYCLES.md cycle template). */
export interface AuditCycle {
  /** Date of the cycle (YYYY-MM-DD). */
  date: string;
  /** What was audited (e.g. "output.log from run X, prompts.log #0005–#0016"). */
  artifacts: string;
  /** Findings by severity (short one-line entries). */
  findings: {
    high: string[];
    medium: string[];
    low: string[];
  };
  /** Improvements implemented (bullet list). */
  improvementsImplemented: string[];
  /** Y = no revert/conflicting change; N = had revert or conflict. */
  flipFlopCheck: 'Y' | 'N';
  /** One-line note for flip-flop (e.g. "any revert or conflicting change?"). */
  flipFlopNote?: string;
  /** Optional notes. */
  notes?: string;
}

/** Per-directory audit store: cycles plus optional recurring patterns / regression watchlist. */
export interface PillAuditStore {
  /** Directory this store belongs to (resolved path). */
  directory: string;
  /** Last time the store was updated (ISO date string). */
  lastUpdated: string;
  /** Number of recorded cycles (length of cycles array). */
  recordedCycles: number;
  /** Audit cycles, newest last. */
  cycles: AuditCycle[];
  /** Optional: recurring patterns (pattern name + description). */
  recurringPatterns?: { pattern: string; description: string }[];
  /** Optional: regression watchlist (checklist items). */
  regressionWatchlist?: string[];
}
