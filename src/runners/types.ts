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
 */
export const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  // Cursor: Mix of Claude and GPT models
  'cursor': [
    'claude-sonnet-4-20250514',
    'gpt-4o',
    'claude-3-5-sonnet-20241022',
    'o1-mini',
  ],
  // Claude Code: Claude models only
  'claude-code': [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022', 
    'claude-3-opus-20240229',
  ],
  // Aider: Supports many providers
  'aider': [
    'anthropic/claude-sonnet-4-20250514',
    'openai/gpt-4o',
    'anthropic/claude-3-5-sonnet-20241022',
    'openai/o1-mini',
  ],
  // OpenCode: Mix of providers
  'opencode': [
    'claude-sonnet-4-20250514',
    'gpt-4o',
  ],
  // Codex: OpenAI models
  'codex': [
    'gpt-4o',
    'o1-mini',
    'gpt-4-turbo',
  ],
  // LLM API: Direct API calls
  'llm-api': [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-opus-20240229',
  ],
};
