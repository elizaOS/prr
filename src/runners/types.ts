/**
 * Error types for runner failures
 * - 'permission': Tool lacks write permissions (bail out immediately - don't waste tokens)
 * - 'auth': Authentication/API key issues
 * - 'timeout': Process timed out
 * - 'model': Wrong model for this runner (e.g., claude model sent to codex) - rotate, don't bail
 * - 'quota': API quota or rate limit exceeded - rotate to different tool/model, don't bail
 * - 'tool': General tool failure (retry with different model/tool)
 * - 'environment': Tool environment issue (e.g., TTY/cursor position) - bail out, won't fix with retries
 */
export type RunnerErrorType = 'permission' | 'auth' | 'model' | 'quota' | 'timeout' | 'tool' | 'environment';

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
  /** Install command/instructions shown when tool is not installed */
  installHint?: string;
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
 * Different models have different strengths and availabilities change frequently.
 * NOTE: These are examples and may become outdated as providers update their model offerings.
 * Models are validated at startup via API queries; unavailable models are skipped.
 * 
 * NOTE: The lists below are ILLUSTRATIVE EXAMPLES ONLY and will likely be outdated.
 * They are NOT used at runtime when dynamic model discovery is available.
 * Real model lists are fetched via API when possible. These are fallbacks only.
 * Actual model availability changes frequently. Use runner.supportedModels
 * or dynamic discovery (e.g., `cursor --list-models`) for up-to-date lists.
 * 
 * NOTE: Model names may need updating as providers release new versions.
 * Run `agent models` or check provider docs for current availability.  
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
 * Updated February 2026 with latest model versions from official docs.
 */
export const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  // ElizaCloud: Model gateway - one API key for Claude, GPT, Gemini
  'elizacloud': [
    'gpt-4o',                          // GPT-4o - general purpose
    'claude-3-5-sonnet-20241022',      // Claude 3.5 Sonnet - strong coding
    'gpt-4o-mini',                     // GPT-4o mini - fast, cost-effective
  ],
  // Cursor: Uses short model names (from `cursor --list-models`)
  // WHY these names: Cursor has its own model aliases, not full API names
  'cursor': [
    'claude-3.7-sonnet',               // Claude 3.7 Sonnet - balanced
    'claude-3.5-sonnet',               // Claude 3.5 Sonnet - strong coding
    'gpt-4o',                          // GPT-4o - general purpose
    'o3-mini',                         // OpenAI o3-mini - fast reasoning
  ],
  // Claude Code: Claude 4+ models (uses full API names)
  'claude-code': [
    'claude-3-5-sonnet-20241022',     // Claude 3.5 Sonnet - best speed/intelligence
    'claude-3-opus-20240229',         // Claude 3 Opus - most intelligent
    'claude-3-5-haiku-20241022',      // Claude 3.5 Haiku - fastest
  ],
  // Aider: Supports many providers (provider-prefixed)
  'aider': [
    'anthropic/claude-3-5-sonnet-20241022',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'anthropic/claude-3-5-haiku-20241022',
  ],
  // OpenCode: Mix of providers
  'opencode': [
    'claude-3-5-sonnet-20241022',
    'claude-3-opus-20240229',
    'gpt-4o',
    'gpt-4o-mini',
  ],
  // Codex: OpenAI models (use codex-optimized variants)
  'codex': [
    'gpt-4o',                        // GPT-4o - best general coding
    'gpt-4o-mini',                   // GPT-4o mini - fast and cost-effective
  ],
  // Gemini CLI: Google models (strong coding, free tier available)
  'gemini': [
    'gemini-2.5-pro',               // Gemini 2.5 Pro - best quality
    'gemini-2.5-flash',             // Gemini 2.5 Flash - fast and capable
  ],
  // Junie CLI: JetBrains AI agent (model selection may be limited by backend)
  'junie': [
    'gemini-3-flash',                  // Fast, high Terminal-Bench score with Junie
    'gemini-3-pro',                    // Gemini 3 Pro
  ],
  // Goose: Block's open-source agent (supports multiple providers)
  'goose': [
    'claude-3-5-sonnet-20241022',      // Claude 3.5 Sonnet via Anthropic provider
    'claude-3-opus-20240229',          // Claude 3 Opus
    'gpt-4o',                          // GPT-4o via OpenAI provider
  ],
  // OpenHands: Open-source agent (litellm format: provider/model)
  'openhands': [
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-3-opus-20240229',
    'openai/gpt-4o',
  ],
  // LLM API: Direct Anthropic API calls (uses full API names)
  // NOTE: Haiku intentionally excluded — 0% fix success rate across 147 attempts.
  // Haiku is used for verification (via LLMClient) but is too weak for code fixing.
  'llm-api': [
    'claude-3-5-sonnet-20241022',   // Claude 3.5 Sonnet - balanced
    'claude-3-opus-20240229',       // Claude 3 Opus - most intelligent
  ],
};
