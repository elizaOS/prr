/**
 * Error types for runner failures
 * - 'permission': Tool lacks write permissions (bail out immediately - don't waste tokens)
 * - 'auth': Authentication/API key issues
 * - 'timeout': Process timed out
 * - 'tool': General tool failure (retry with different model/tool)
 * - 'environment': Tool environment issue (e.g., TTY/cursor position) - bail out, won't fix with retries
 */
export type RunnerErrorType = 'permission' | 'auth' | 'timeout' | 'tool' | 'environment';

export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
  /** Type of error - used to determine retry strategy */
  errorType?: RunnerErrorType;
}

export interface RunnerOptions {
  model?: string;
  codexAddDirs?: string[];
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
    'claude-4-sonnet',                 // Claude 4.5 Sonnet - balanced, fast
    'claude-4-opus',                   // Claude 4.6 Opus - most intelligent
    'gpt-5.3',                         // GPT-5.3 - latest OpenAI
    'o3-mini',                         // OpenAI o3-mini - fast reasoning
  ],
  // Claude Code: Claude 4+ models (uses full API names)
  'claude-code': [
    'claude-sonnet-4-5-20250929',     // Claude 4.5 Sonnet - best speed/intelligence
    'claude-opus-4-6',                // Claude 4.6 Opus - NEW! Most intelligent
    'claude-haiku-4-5-20251001',      // Claude 4.5 Haiku - fastest
  ],
  // Aider: Supports many providers (provider-prefixed)
  'aider': [
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-opus-4-6',     // NEW! Claude 4.6 Opus
    'openai/gpt-5.3',                // NEW! GPT-5.3
    'anthropic/claude-haiku-4-5-20251001',
  ],
  // OpenCode: Mix of providers
  'opencode': [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-6',               // NEW! Claude 4.6 Opus
    'gpt-5.3',                       // NEW! GPT-5.3
    'gpt-5.3-mini',                  // GPT-5.3 mini variant
  ],
  // Codex: OpenAI models (use codex-optimized variants)
  'codex': [
    'gpt-5.3-codex',                 // NEW! GPT-5.3 Codex - best for coding
    'gpt-5.3',                       // NEW! GPT-5.3 standard
    'gpt-5.2-codex',                 // Fallback to 5.2 Codex
  ],
  // LLM API: Direct Anthropic API calls (uses full API names)
  // NOTE: Haiku intentionally excluded — 0% fix success rate across 147 attempts.
  // Haiku is used for verification (via LLMClient) but is too weak for code fixing.
  'llm-api': [
    'claude-sonnet-4-5-20250929',   // Claude 4.5 Sonnet - balanced
    'claude-opus-4-5-20251101',      // Claude 4.5 Opus - most intelligent
  ],
};
