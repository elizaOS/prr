/**
 * Shared types for the PRR LLM client (transport + higher-level operations).
 * WHY: Keeps `client.ts` as a thin facade without circular imports between split modules.
 */

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens written to Anthropic's prompt cache (1.25x cost, 5-min TTL). */
    cacheCreationInputTokens?: number;
    /** Tokens read from Anthropic's prompt cache (0.1x cost — 90% savings). */
    cacheReadInputTokens?: number;
  };
}

export interface CompleteOptions {
  model?: string;
  /**
   * Override the generic ElizaCloud 500/504 retry count for special callers.
   * WHY: Conflict resolution should fall back to chunked/manual strategies quickly
   * instead of spending ~10 minutes exhausting the global retry ladder first.
   */
  max504Retries?: number;
  /** Optional phase label for prompts.log metadata (e.g. batch-verify, final-audit). Helps pill and auditors filter by step. */
  phase?: string;
}

/**
 * Batch check result with optional model recommendation
 */
export interface BatchCheckResult {
  issues: Map<
    string,
    {
      exists: boolean;
      explanation: string;
      stale: boolean;
      /**
       * Importance score (1-5): 1=critical, 5=trivial.
       * Defaults to 3 if LLM doesn't provide or issue is NO/STALE.
       */
      importance: number;
      /**
       * Fix difficulty score (1-5): 1=easy one-liner, 5=major refactor.
       * Defaults to 3 if LLM doesn't provide or issue is NO/STALE.
       */
      ease: number;
    }
  >;
  /** Recommended models to use for fixing, in order of preference */
  recommendedModels?: string[];
  /** Reasoning behind the model recommendation */
  modelRecommendationReasoning?: string;
  /** True when a batch failed (e.g. 504) but earlier batches were returned so state can be persisted */
  partial?: boolean;
}

/**
 * Filter attempt history to only lines for issues in the current batch.
 * WHY: Audit showed full history (all issues) sent to every verify batch; only the current batch is relevant.
 * NOTE: batchIds should be raw comment IDs (PRRC_...) matching the format from getAttemptHistoryForIssues.
 * The batch input uses synthetic issue_N IDs, so callers must map back to comment IDs before calling this.
 */
export function filterAttemptHistoryToBatch(attemptHistory: string, batchIds: string[]): string {
  const set = new Set(batchIds);
  return attemptHistory
    .split('\n')
    .filter((line) => {
      const m = line.match(/^Issue\s+(\S+):/);
      return m && set.has(m[1]);
    })
    .join('\n');
}
