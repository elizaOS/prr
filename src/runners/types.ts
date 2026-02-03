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
    'claude-3.7-sonnet',               // Claude 3.7 Sonnet - balanced
    'gpt-4.5-preview',                 // GPT-4.5 preview - coding/agentic
    'claude-3-opus',                   // Claude 3 Opus - most capable
    'o3-mini',                         // OpenAI o3-mini - fast reasoning
  ],
  // Claude Code: Claude 4.5 models only (uses full API names)
  'claude-code': [
    'claude-sonnet-4-5-20250929',      // Claude 4.5 Sonnet
    'claude-opus-4-5-20251101',        // Claude 4.5 Opus
    'claude-haiku-4-5-20251001',       // Claude 4.5 Haiku - fast
  ],
  // Aider: Supports many providers (provider-prefixed)
  'aider': [
    'anthropic/claude-3-7-sonnet-20250219',
    'openai/gpt-5.2',
    'anthropic/claude-3-5-haiku-20241022',
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
