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
 * Updated January 2026 with latest model versions.
 */
export const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  // Cursor: Mix of Claude 4 and OpenAI reasoning models
  'cursor': [
    'claude-sonnet-4-20250514',      // Claude 4 Sonnet - balanced
    'gpt-4o',                         // GPT-4o - fast multimodal
    'claude-opus-4-20250514',         // Claude 4 Opus - most capable
    'o3-mini',                        // OpenAI o3-mini - reasoning
  ],
  // Claude Code: Claude 4 models only
  'claude-code': [
    'claude-sonnet-4-20250514',       // Claude 4 Sonnet
    'claude-opus-4-20250514',         // Claude 4 Opus
    'claude-haiku-4-5-20251001',      // Claude 4.5 Haiku - fast
  ],
  // Aider: Supports many providers (provider-prefixed)
  'aider': [
    'anthropic/claude-sonnet-4-20250514',
    'openai/gpt-4o',
    'anthropic/claude-opus-4-20250514',
    'openai/o3-mini',
  ],
  // OpenCode: Mix of providers
  'opencode': [
    'claude-sonnet-4-20250514',
    'gpt-4o',
    'o3-mini',
  ],
  // Codex: OpenAI models (reasoning-focused)
  'codex': [
    'gpt-4o',
    'o3-mini',
    'o1',
  ],
  // LLM API: Direct Anthropic API calls
  'llm-api': [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-5-20251001',
  ],
};
