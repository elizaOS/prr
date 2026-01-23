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
 * These provide variety when a tool gets stuck - different models may have different strengths.
 * Updated January 2026 with latest model versions from official docs.
 */
export const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  // Cursor: Mix of Claude 4.5 and GPT-5.x models
  'cursor': [
    'claude-sonnet-4-5-20250929',     // Claude 4.5 Sonnet - balanced
    'gpt-5.2',                         // GPT-5.2 - best for coding/agentic
    'claude-opus-4-5-20251101',        // Claude 4.5 Opus - most capable
    'gpt-5-mini',                      // GPT-5 mini - faster, cost-efficient
  ],
  // Claude Code: Claude 4.5 models only
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
  // LLM API: Direct Anthropic API calls
  'llm-api': [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ],
};
