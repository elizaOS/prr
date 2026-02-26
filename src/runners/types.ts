/**
 * Error types for runner failures
 * - 'permission': Tool lacks write permissions (bail out immediately - don't waste tokens)
 * - 'auth': Authentication/API key issues
 * - 'timeout': API/gateway timeout (504) — transient, rotate models
 * - 'tool_timeout': Runner process killed after hard time limit — skip this tool for rest of run
 * - 'model': Wrong model for this runner (e.g., claude model sent to codex) - rotate, don't bail
 * - 'quota': API quota or rate limit exceeded - rotate to different tool/model, don't bail
 * - 'tool': General tool failure (retry with different model/tool)
 * - 'environment': Tool environment issue (e.g., TTY/cursor position) - bail out, won't fix with retries
 * - 'tool_config': Tool CLI/version mismatch (e.g. unknown option) - skip this tool for rest of run
 */
export type RunnerErrorType = 'permission' | 'auth' | 'model' | 'quota' | 'timeout' | 'tool_timeout' | 'tool' | 'environment' | 'tool_config';

/**
 * Structured outcome codes from fixer output (parsed by workflow, not set by runners).
 * Fix prompts ask the model to output e.g. RESULT: ALREADY_FIXED — <detail>.
 * WHY: Without a shared vocabulary, "no changes" was freeform text and PRR couldn't route
 * (e.g. WRONG_LOCATION → record "provide wider context"). Codes enable targeted lessons and
 * correct follow-up without forcing cosmetic edits when the issue is already fixed or unclear.
 */
export type ResultCode =
  | 'FIXED'
  | 'ALREADY_FIXED'
  | 'NEEDS_DISCUSSION'
  | 'UNCLEAR'
  | 'WRONG_LOCATION'
  | 'CANNOT_FIX'
  | 'ATTEMPTED';

/** Token usage from a single run (e.g. Codex exec --json turn.completed). */
export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
}

export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
  /** Type of error - used to determine retry strategy */
  errorType?: RunnerErrorType;
  /** Parsed from output by workflow post-processing (not set by runners). WHY optional: runners return raw output; parseResultCode() in workflow/utils.ts populates these so no-changes and has-changes handlers can branch on resultCode. */
  resultCode?: ResultCode;
  resultDetail?: string;
  caveat?: string;
  /** Token usage for this run (e.g. Codex --json). Callers can aggregate across runs. */
  usage?: TokenUsage;
}

export interface RunnerOptions {
  model?: string;
  codexAddDirs?: string[];
  /** OpenAI API key for runners that use OpenAI (e.g. Codex). When set, passed to the child process so it sees the key even if process.env was not set in the runner's cwd. */
  openaiApiKey?: string;
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
  /** List of models this runner can use, in rotation order. May be set at runtime from provider API (e.g. llm-api). */
  supportedModels?: string[];
  /** Provider backend when runner is multi-provider (e.g. llm-api: 'elizacloud' | 'openai' | 'anthropic'). Used to build rotation from API model list. */
  provider?: 'elizacloud' | 'openai' | 'anthropic';
  run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult>;
  isAvailable(): Promise<boolean>;
  checkStatus(): Promise<RunnerStatus>;
  /**
   * Report files that were modified but FAILED verification.
   *
   * HISTORY: The original escalation system (searchReplaceFailures) only tracked
   * search/replace MATCHING failures — when the LLM's search text didn't match the
   * file. But a file like lib/cache/client.ts can get small patches that technically
   * match yet fail verification (the patch is inadequate for structural corruption).
   * Those files never escalated to full-file-rewrite because the S/R "succeeded."
   *
   * Now the caller reports verification failures too, and both signals count toward
   * escalation. This ensures structurally damaged files eventually get full rewrites
   * instead of an infinite loop of ineffective patches.
   */
  reportVerificationFailures?(failedFiles: string[]): void;
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
 * ⚠️ Do NOT rely on this table for current availability — providers change frequently and these entries are examples only.
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
 * Updated February 2026 with current model versions from official docs:
 *   Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
 *   OpenAI:    https://developers.openai.com/api/docs/models
 *
 * Current Anthropic models (Feb 2026):
 *   claude-opus-4-5-20251101   — Most intelligent, agents/coding ($5/$25 per MTok)
 *   claude-sonnet-4-5-20250929 — Best speed/intelligence ($3/$15 per MTok)
 *   claude-haiku-4-5-20251001  — Fastest ($1/$5 per MTok)
 *
 * Current OpenAI models (Feb 2026):
 *   gpt-5.2       — Best for coding/agentic tasks (frontier)
 *   gpt-5-mini    — Faster, cost-efficient
 *   gpt-5-nano    — Fastest, cheapest
 *   gpt-4.1       — Smartest non-reasoning model
 *
 * DEPRECATED (return 404):
 *   claude-3-5-sonnet-20241022, claude-3-opus-20240229, claude-3-5-haiku-20241022
 */
export const DEFAULT_MODEL_ROTATIONS: Record<string, string[]> = {
  // ElizaCloud: use API model IDs (owner/name). One key for Claude, GPT, Gemini, Qwen, etc.
  'elizacloud': [
    'openai/gpt-5.1-codex-max',           // GPT-5.1 Codex Max - purpose-built for agentic coding
    'openai/gpt-5.2-codex',               // GPT-5.2-Codex - agentic coding
    'anthropic/claude-opus-4.5',          // Claude Opus 4.5 - most capable
    'anthropic/claude-sonnet-4.5',        // Claude Sonnet 4.5 - strong coding
    'openai/gpt-4.1',                     // GPT-4.1 - flagship
    'openai/gpt-5-mini',                  // GPT-5 mini - fast, cost-effective
  ],
  // Cursor: Uses short model names (from `cursor-agent models`)
  // WHY these names: Cursor has its own model aliases, not full API names.
  // These get discovered dynamically at runtime via `cursor-agent models`.
  // This is just the fallback list if discovery fails.
  'cursor': [
    'claude-sonnet-4-5',                   // Claude Sonnet 4.5 - balanced
    'gpt-4.1',                             // GPT-4.1 - general purpose
    'claude-opus-4-5',                     // Claude Opus 4.5 - most intelligent
    'gpt-5.2',                             // GPT-5.2 - frontier coding
  ],
  // Claude Code: Claude models (uses full API names)
  'claude-code': [
    'claude-sonnet-4-5-20250929',          // Claude Sonnet 4.5 - best speed/intelligence
    'claude-opus-4-5-20251101',            // Claude Opus 4.5 - most intelligent
    'claude-haiku-4-5-20251001',           // Claude Haiku 4.5 - fastest
  ],
  // Aider: Supports many providers (provider-prefixed)
  'aider': [
    'anthropic/claude-sonnet-4-5-20250929',
    'openai/gpt-4.1',
    'openai/gpt-5-mini',
    'anthropic/claude-haiku-4-5-20251001',
  ],
  // OpenCode: Mix of providers
  'opencode': [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'gpt-4.1',
    'gpt-5-mini',
  ],
  // Codex: OpenAI models (use codex-optimized variants when available)
  'codex': [
    'gpt-5.2-codex',                      // GPT-5.2-Codex - optimized for agentic coding
    'gpt-5-mini',                          // GPT-5 mini - fast and cost-effective
  ],
  // Gemini CLI: Google models (strong coding, free tier available)
  'gemini': [
    'gemini-2.5-pro',                      // Gemini 2.5 Pro - best quality
    'gemini-2.5-flash',                    // Gemini 2.5 Flash - fast and capable
  ],
  // Junie CLI: JetBrains AI agent (model selection may be limited by backend)
  'junie': [
    'gemini-3-flash',                      // Fast, high Terminal-Bench score with Junie
    // Review: using latest model identifiers for optimal compatibility with available Gemini features
    'gemini-3-pro-preview',                // Gemini 3 Pro Preview - official model ID
  ],
  // Goose: Block's open-source agent (supports multiple providers)
  'goose': [
    'claude-sonnet-4-5-20250929',          // Claude Sonnet 4.5 via Anthropic provider
    'claude-opus-4-5-20251101',            // Claude Opus 4.5
    'gpt-4.1',                             // GPT-4.1 via OpenAI provider
  ],
  // OpenHands: Open-source agent (litellm format: provider/model)
  'openhands': [
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-opus-4-5-20251101',
    'openai/gpt-4.1',
  ],
  // LLM API (ElizaCloud): use API model IDs (owner/name). Same as elizacloud.
  // When provider is native OpenAI or Anthropic, llm-api runner uses the lists below instead.
  'llm-api': [
    'openai/gpt-4o',                      // GPT-4o - current flagship
    'openai/gpt-4o-mini',                 // GPT-4o mini - fast, cost-effective
    'anthropic/claude-3.7-sonnet',        // Claude 3.7 Sonnet - balanced coding
    'anthropic/claude-3.5-sonnet',        // Claude 3.5 Sonnet - strong coding
    // anthropic/claude-3-opus skipped on ElizaCloud (ELIZACLOUD_SKIP_MODELS) — 500s at 45k–407k prompt
    'google/gemini-2.0-pro-exp',          // Gemini 2.0 Pro Experimental
  ],
};

// Native OpenAI/Anthropic model lists are no longer hardcoded — llm-api rotation
// is built from the provider's model list in validateAndFilterModels (see rotation.ts).
