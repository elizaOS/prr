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
    'claude-4-sonnet',                 // Claude 4.5 Sonnet - balanced, fast
    'claude-4-opus',                   // Claude 4.6 Opus - most intelligent
    'gpt-5.2',                         // GPT-5.3 - latest OpenAI
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
    'claude-sonnet-4-5-20250929',      // Claude 4.5 Sonnet via Anthropic provider
    'claude-opus-4-5-20251101',        // Claude 4.5 Opus
    'gpt-5.3',                         // GPT-5.3 via OpenAI provider
  ],
  // OpenHands: Open-source agent (litellm format: provider/model)
  'openhands': [
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-opus-4-5-20251101',
    'openai/gpt-5.3',
  ],
  // LLM API: Direct Anthropic API calls (uses full API names)
  // NOTE: Haiku intentionally excluded — 0% fix success rate across 147 attempts.
  // Haiku is used for verification (via LLMClient) but is too weak for code fixing.
  'llm-api': [
    'claude-sonnet-4-5-20250929',   // Claude 4.5 Sonnet - balanced ($3/$15 per MTok)
    'claude-opus-4-5-20251101',     // Claude 4.5 Opus - most intelligent ($5/$25 per MTok)
  ],
};
