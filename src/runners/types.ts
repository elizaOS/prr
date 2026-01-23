export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface RunnerOptions {
  model?: string;
}

export interface RunnerStatus {
  installed: boolean;
  ready: boolean;        // Logged in, configured, etc.
  version?: string;
  error?: string;        // Why it's not ready
}

export interface Runner {
  name: string;
  displayName: string;   // Human-friendly name
  /** List of models this runner can use, in rotation order */
  supportedModels?: string[];
  run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult>;
  isAvailable(): Promise<boolean>;
  checkStatus(): Promise<RunnerStatus>;
}

/**
 * Default model rotation lists for each tool type.
 * 
 * WHY MODEL ROTATION EXISTS:
 * AI models get stuck. They'll make the same mistake repeatedly.
 * Different models have different strengths:
 * - Claude excels at following complex instructions
 * - GPT excels at common patterns  
 * - Opus has better reasoning for hard problems
 * - Mini models work fine for simple fixes (and are faster/cheaper)
 * 
 * When a model fails twice, we rotate to the next one.
 * This often unsticks the fix loop without human intervention.
 * 
 * WHY THIS ORDER:
 * Start with the balanced model (sonnet), escalate to powerful (opus),
 * try alternative provider (GPT), then fast/cheap options (mini).
 * 
 * Updated January 2026 with latest model versions from official docs.
 */
export const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  // Cursor: Uses short model names (from `cursor --list-models`)
  // WHY these names: Cursor has its own model aliases, not full API names
  'cursor': [
    'sonnet-4.5',                      // Claude 4.5 Sonnet - balanced
    'gpt-5.2',                         // GPT-5.2 - best for coding/agentic
    'opus-4.5',                        // Claude 4.5 Opus - most capable
    'gpt-5.2-codex',                   // GPT-5.2 Codex - optimized for code
    'gemini-3-pro',                    // Gemini 3 Pro - alternative
  ],
  // Claude Code: Claude 4.5 models only (uses full API names)
  'claude-code': [
    'claude-sonnet-4-5-20250929',      // Claude 4.5 Sonnet
    'claude-opus-4-5-20251101',        // Claude 4.5 Opus
    'claude-haiku-4-5-20251001',       // Claude 4.5 Haiku - fast
  ],
  // Aider: Supports many providers (provider-prefixed)
  'aider': [
    'anthropic/claude-sonnet-4-5-20250929',
    'openai/gpt-5.2',
    'anthropic/claude-opus-4-5-20251101',
    'openai/gpt-5-mini',
  ],
  // OpenCode: Mix of providers
  'opencode': [
    'claude-sonnet-4-5-20250929',
    'gpt-5.2',
    'gpt-5-mini',
  ],
  // Codex: OpenAI models (use codex-optimized variants)
  'codex': [
    'gpt-5.2-codex',                   // Best for coding tasks
    'gpt-5.2',                         // Fallback to standard
    'gpt-5-mini',                      // Fast option
  ],
  // LLM API: Direct Anthropic API calls (uses full API names)
  'llm-api': [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ],
};
