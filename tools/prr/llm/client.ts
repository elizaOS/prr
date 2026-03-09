/**
 * LLM client for verification, issue detection, and commit message generation.
 * 
 * WHY separate from fixer tools: Verification needs different models than fixing.
 * We use Claude Haiku/Sonnet for fast verification checks, while fixer tools
 * might use Opus or GPT for actual code changes.
 * 
 * WHY extended thinking support: For complex verification, Claude's "thinking"
 * capability improves accuracy by reasoning through the problem before answering.
 * 
 * WHY adversarial prompts: Regular "is this fixed?" prompts have high false positive
 * rates - LLMs tend toward "yes". Adversarial prompts ("find what's NOT fixed")
 * are more reliable.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Fetch } from 'openai/core';
import type { Config, LLMProvider } from '../../../shared/config.js';
import { debug, warn, trackTokens, debugPrompt, debugResponse, debugPromptError } from '../../../shared/logger.js';
import { ELIZACLOUD_API_BASE_URL } from '../../../shared/constants.js';
import { acquireElizacloud, releaseElizacloud } from '../../../shared/llm/rate-limit.js';
import { createElizaCloudOpenAIClient } from '../../../shared/llm/elizacloud.js';
import { sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';
import { hasConflictMarkers } from '../../../shared/git/git-lock-files.js';

/** Extract response status, headers, and body from OpenAI-style or nested errors for ElizaCloud debugging. */
function getElizaCloudErrorContext(error: unknown): { status?: number; statusText?: string; headers?: Record<string, string>; body?: unknown; message?: string; cause?: unknown } {
  const out: { status?: number; statusText?: string; headers?: Record<string, string>; body?: unknown; message?: string; cause?: unknown } = {};
  if (error == null || typeof error !== 'object') return out;
  const e = error as Record<string, unknown>;
  out.message = e.message != null ? String(e.message) : undefined;
  out.cause = e.cause;
  if (typeof e.status === 'number') out.status = e.status as number;
  const headers = e.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const h = headers as Record<string, unknown> & { forEach?: (cb: (v: string, k: string) => void) => void };
    if (typeof h.forEach === 'function') {
      out.headers = {};
      h.forEach((v: string, k: string) => { out.headers![k] = v; });
    } else {
      out.headers = {};
      for (const [k, v] of Object.entries(h)) {
        if (typeof v === 'string') out.headers[k] = v;
        else if (Array.isArray(v) && v.length) out.headers[k] = String(v[0]);
      }
    }
  }
  if ('error' in e && e.error !== undefined) out.body = e.error;
  if (out.body === undefined && 'data' in e && e.data !== undefined) out.body = e.data;
  const cause = e.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === 'object' && out.body === undefined && 'responseBody' in cause) out.body = cause.responseBody;
  if (cause && typeof cause === 'object' && out.body === undefined && 'error' in cause) out.body = cause.error;
  return out;
}

/** Safe description of an API key for debug/error messages (never log the full key). */
function maskApiKey(key: string | undefined): string {
  if (key === undefined || key === null) return 'not set';
  const k = key.trim();
  if (!k.length) return 'empty after trim';
  const prefix = k.length <= 8 ? k.slice(0, 2) + '***' : k.slice(0, 6) + '...';
  return `length=${k.length}, prefix=${prefix}`;
}

/** File-type-specific rules for conflict resolution prompt (reduces invalid JSON/TS output). */
function getConflictFileTypeRules(filePath: string): string {
  if (filePath.endsWith('.json')) {
    return '\n6. Output must be strict JSON (no comments, no trailing commas).';
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) {
    return '\n6. Preserve all imports and ensure the result compiles.';
  }
  return '';
}

/** Re-export for consumers that still import from llm/client. */
export { createElizaCloudOpenAIClient } from '../../../shared/llm/elizacloud.js';
export { acquireElizacloud, releaseElizacloud } from '../../../shared/llm/rate-limit.js';

/** Normalize issue/comment IDs: strip markdown (headings, bold) and standardize to issue_<n> for matching. */
function normalizeIssueId(raw: string): string {
  // Strip markdown formatting that LLMs wrap around IDs.
  // HISTORY: Haiku started returning "**issue_1**: YES:" (bold markdown) instead
  // of "issue_1: YES:" — the regex only stripped '#' heading prefixes, so "**issue_1"
  // normalized to "issue_**issue_1" which never matched allowedIds. Observed: 0/15
  // parsed in batch analysis, every issue fell through to "assuming unresolved."
  // This single bug disabled the entire triage/priority system.
  const normalized = raw.trim()
    .replace(/^#+\s*/, '')      // "## issue_1" → "issue_1"
    .replace(/^\*{1,2}/, '')    // "**issue_1" or "*issue_1" → "issue_1"
    .replace(/\*{1,2}$/, '')    // "issue_1**" → "issue_1"
    .toLowerCase()
    .replace(/^issue[_\s]*/i, '') // "issue_1" → "1"
    .replace(/^#/, '');           // "#1" → "1"
  return normalized.length > 0 ? `issue_${normalized}` : normalized;
}

/**
 * Strip unpaired UTF-16 surrogates from a string.
 * Lone surrogates (U+D800–U+DFFF without a valid pair) are invalid in JSON
 * and cause API errors like "no low surrogate in string". Replaces them with U+FFFD.
 */
function sanitizeForJson(text: string): string {
  // Match lone high surrogates (not followed by low) and lone low surrogates (not preceded by high)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

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

interface CompleteOptions {
  model?: string;
  /**
   * Override the generic ElizaCloud 500/504 retry count for special callers.
   * WHY: Conflict resolution should fall back to chunked/manual strategies quickly
   * instead of spending ~10 minutes exhausting the global retry ladder first.
   */
  max504Retries?: number;
}

/**
 * Batch check result with optional model recommendation
 */
export interface BatchCheckResult {
  issues: Map<string, {
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
  }>;
  /** Recommended models to use for fixing, in order of preference */
  recommendedModels?: string[];
  /** Reasoning behind the model recommendation */
  modelRecommendationReasoning?: string;
  /** True when a batch failed (e.g. 504) but earlier batches were returned so state can be persisted */
  partial?: boolean;
}

export function commentNeedsConservativeExistenceCheck(comment: string): boolean {
  const c = comment.toLowerCase();
  return (
    /\bmemory leak\b/.test(c) ||
    /\b(?:potential )?leak\b/.test(c) ||
    /\b(?:cleanup|clean up|prune|evict|ttl|lru)\b/.test(c) ||
    /\b(?:stale|orphaned|dangling)\s+(?:entry|entries|state|map|set|cache)\b/.test(c) ||
    /\bnever\s+(?:cleared|cleaned|pruned|deleted|removed)\b/.test(c) ||
    /\bfromend\b/.test(c) ||
    /\b(?:newest|oldest)-first\b/.test(c) ||
    /\bkeep(?:s|ing)?\s+(?:the\s+)?(?:newest|oldest)\b/.test(c) ||
    /\bslicetofitbudget\b/.test(c)
  );
}

/**
 * True when the "already correct" explanation contains concrete code evidence
 * rather than generic reassurance.
 *
 * WHY: The YES->NO override is useful for obvious false positives, but vague
 * phrases like "already correct" are too risky for lifecycle/order-sensitive
 * bugs. Requiring evidence keeps the override from silently hiding real issues.
 */
export function explanationHasConcreteFixEvidence(explanation: string): boolean {
  return (
    /\bline\s+\d+\b/i.test(explanation) ||
    /`[^`\n]{2,120}`/.test(explanation) ||
    /\b(?:now|uses?|returns?|deletes?|removes?|calls?|sets?|sorts?|reverses?)\b.{0,80}\b(?:if|map|set|sliceToFitBudget|fromEnd|delete|cleanup|prune|reverse)\b/i.test(explanation)
  );
}

/**
 * True when the model is really saying "I couldn't see enough code to decide",
 * regardless of whether it labeled the result NO or STALE.
 *
 * WHY: Missing snippet context should keep an issue open, not dismiss it as stale.
 * Different models phrase this in many ways ("truncated snippet", "can't verify",
 * "current code doesn't show"), so we centralize the detection in one helper.
 */
export function explanationMentionsMissingCodeVisibility(explanation: string): boolean {
  return (
    /snippet.*(?:truncated|unavailable)/i.test(explanation) ||
    /(?:truncated|unavailable).*snippet/i.test(explanation) ||
    /cannot verify.*(?:truncated|unavailable)/i.test(explanation) ||
    /not visible in the provided excerpt/i.test(explanation) ||
    /not (?:visible|found) in the provided .* excerpt/i.test(explanation) ||
    /not visible in provided .* excerpt/i.test(explanation) ||
    /are not visible in the provided/i.test(explanation) ||
    /excerpt does not (?:include|show|contain)/i.test(explanation) ||
    /can'?t (?:be )?evaluat/i.test(explanation) ||
    /cannot (?:assess|determine|verify)/i.test(explanation) ||
    /(?:code|snippet|excerpt|current code) (?:doesn'?t|does not) show/i.test(explanation) ||
    /\bonly shows\b.*\b(?:not |beginning|start|first|lines? \d)/i.test(explanation) ||
    /\bincomplete\b.*\b(?:show|visible|implementation)\b/i.test(explanation) ||
    /not (?:visible|shown|included) in the (?:current |provided )?(?:excerpt|code|snippet)/i.test(explanation)
  );
}

/**
 * Context for model recommendation (optional)
 */
export interface ModelRecommendationContext {
  /** Available models to choose from */
  availableModels?: string[];
  /** Historical model performance summary (e.g., "sonnet: 5 fixes, 2 failures") */
  modelHistory?: string;
  /** Previous attempts on these issues (e.g., "sonnet failed: lesson was X") */
  attemptHistory?: string;
  /** When false, omit model recommendation block and Previous Attempts from prompt. WHY: Verification doesn't fix issues; audit showed ~60k chars wasted per run sending full history to every batch. */
  includeModelRecommendation?: boolean;
  /** Estimated fix prompt size in chars (audit: recommender didn't account for gateway timeout on 94k prompt). */
  estimatedFixPromptChars?: number;
}

/**
 * Fetch the list of model IDs available to the given OpenAI API key.
 * Uses GET /v1/models (openai.models.list()).
 *
 * WHY: Model rotation lists contain models that may not exist or may not be
 * accessible to the user's API key (e.g. "gpt-5.3-codex"). Without validation,
 * the fixer retries multiple times per unavailable model, wasting time and tokens.
 * Calling this once at startup lets us prune the rotation list up front.
 *
 * Returns an empty set on error (network issue, invalid key) so callers
 * can safely fall back to the full rotation list.
 */
export async function fetchAvailableOpenAIModels(apiKey: string): Promise<Set<string>> {
  try {
    const client = new OpenAI({ apiKey });
    const models = await client.models.list();
    const ids = new Set<string>();
    for await (const model of models) {
      ids.add(model.id);
    }
    debug(`Fetched ${ids.size} available OpenAI models`);
    return ids;
  } catch (err) {
    debug('Failed to fetch OpenAI models list', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set(); // Empty = skip filtering, keep all models
  }
}

/**
 * Validate OpenAI API key at startup (e.g. for Codex or llm-api).
 * Calls GET /v1/models and throws on 401 so we fail fast with a clear message.
 */
export async function validateOpenAIKey(apiKey: string): Promise<void> {
  const key = apiKey?.trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY is empty. Set it in your .env or environment.');
  }
  const keyHint = maskApiKey(key);
  debug('Validating OpenAI API key');
  try {
    const client = new OpenAI({ apiKey: key });
    for await (const _ of client.models.list()) {
      break; // one request to verify auth
    }
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const msg = err instanceof Error ? err.message : String(err);
    if (status === 401 || /401|Unauthorized|Authentication required|Missing bearer|invalid.*api.*key/i.test(msg)) {
      debug('OpenAI 401 during validation');
      throw new Error(
        `OpenAI API key was rejected (401 Unauthorized). ` +
        `API key: ${keyHint}. ` +
        `Check that OPENAI_API_KEY in .env is correct, has no extra spaces/newlines, and has not been revoked. ` +
        `If OPENAI_BASE_URL is set, unset it so the key is used with api.openai.com (see github.com/openai/codex/issues/9153).`
      );
    }
    throw err;
  }
}

/**
 * Fetch the list of model IDs available to the given Anthropic API key.
 * Uses GET https://api.anthropic.com/v1/models directly.
 *
 * WHY: Same reason as OpenAI - rotation lists may reference models the key
 * can't access (e.g. opus on a lower-tier plan). Validate once at startup
 * instead of discovering failures one retry at a time.
 *
 * NOTE: Uses raw fetch because the @anthropic-ai/sdk@0.32.x doesn't have
 * the .models namespace yet. The endpoint is stable (documented at
 * docs.anthropic.com/en/api/models-list).
 *
 * Returns an empty set on error so callers can safely fall back.
 */
export async function fetchAvailableAnthropicModels(apiKey: string): Promise<Set<string>> {
  try {
    const ids = new Set<string>();
    let afterId: string | undefined;
    let hasMore = true;
    const MAX_PAGES = 20; // Safety cap to prevent infinite loops
    let page = 0;
    
    while (hasMore) {
      if (++page > MAX_PAGES) {
        debug('Anthropic models pagination safety cap reached');
        break;
      }
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '1000');
      if (afterId) {
        url.searchParams.set('after_id', afterId);
      }
      
      const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
let response: Response;
try {
  response = await fetch(url.toString(), {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeout);
}
      
      if (!response.ok) {
        debug('Anthropic models API returned non-OK', {
          status: response.status,
          statusText: response.statusText,
        });
        break;
      }
      
      const body = await response.json() as {
        data: Array<{ id: string }>;
        has_more: boolean;
      };
      
      for (const model of body.data) {
        ids.add(model.id);
      }
      
      hasMore = body.has_more;
      if (body.data.length > 0) {
        afterId = body.data[body.data.length - 1].id;
      } else {
        hasMore = false;
      }
    }
    
    debug(`Fetched ${ids.size} available Anthropic models`);
    return ids;
  } catch (err) {
    debug('Failed to fetch Anthropic models list', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set(); // Empty = skip filtering, keep all models
  }
// Review: returning empty set allows skipping filtering when model fetch fails
}

/**
 * Validate ElizaCloud API key (e.g. at startup).
 * Throws with a clear message on 401 so we fail fast instead of many 401s later.
 */
export async function validateElizaCloudKey(apiKey: string): Promise<void> {
  const key = apiKey?.trim();
  if (!key) {
    throw new Error('ELIZACLOUD_API_KEY is empty. Set it in your .env file.');
  }
  const keyHint = maskApiKey(key);
  const url = ELIZACLOUD_API_BASE_URL;
  debug('Validating ElizaCloud API key', { requestURL: `${url}/models`, apiKey: keyHint });
  try {
    const client = createElizaCloudOpenAIClient(key);
    for await (const _ of client.models.list()) {
      break; // one request to verify auth
    }
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const msg = err instanceof Error ? err.message : String(err);
    if (status === 401 || /401|Unauthorized|Authentication required/i.test(msg)) {
      debug('ElizaCloud 401 during validation', { requestURL: `${url}/models`, apiKey: keyHint });
      throw new Error(
        `ElizaCloud API key was rejected (401 Unauthorized). ` +
        `Request URL: ${url}/models. API key: ${keyHint}. ` +
        `Check that ELIZACLOUD_API_KEY in .env is correct for this URL, has no extra spaces/newlines, and has not been revoked.`
      );
    }
    throw err;
  }
}

/**
 * Fetch all available models from ElizaCloud API.
 * Returns empty set if fetch fails (skip filtering).
 */
export async function fetchAvailableElizaCloudModels(apiKey: string): Promise<Set<string>> {
  try {
    const client = createElizaCloudOpenAIClient(apiKey?.trim() ?? '');
    const models = await client.models.list();
    const ids = new Set<string>();
    for await (const model of models) {
      ids.add(model.id);
    }
    debug(`Fetched ${ids.size} available ElizaCloud models`);
    return ids;
  } catch (err) {
    debug('Failed to fetch ElizaCloud models list', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

/**
 * Probe one ElizaCloud model with a minimal chat request.
 * Returns 'ok' if the model is usable, 'slow_pool' if the backend says it's not in the slow pool
 * (e.g. "switch to auto"), 'error' for other failures (network, auth, etc.).
 * Used at startup to drop models that would fail on first real request.
 */
export async function probeElizaCloudModel(apiKey: string, model: string): Promise<'ok' | 'slow_pool' | 'error'> {
  try {
    const client = createElizaCloudOpenAIClient(apiKey?.trim() ?? '');
    await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
    });
    return 'ok';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ctx = getElizaCloudErrorContext(err);
    const bodyStr = ctx.body != null ? JSON.stringify(ctx.body) : '';
    const combined = `${msg} ${bodyStr}`;
    if (/not available in the slow pool|switch to auto/i.test(combined)) {
      return 'slow_pool';
    }
    return 'error';
  }
}

/**
 * Cheap models for low-stakes tasks (commit messages, dismissal comments).
 *
 * WHY: Sonnet ($3/$15 per MTok) is overkill for generating a one-line commit
 * message or a 120-char dismissal comment. Haiku ($1/$5 per MTok) and
 * GPT-4o-mini ($0.15/$0.6 per MTok) produce equivalent results for constrained
 * text generation — the output is a single formatted sentence, not multi-step
 * code reasoning. This saves ~66-95% per call with zero quality impact.
 *
 * WHY per-provider map: The model name format differs between providers.
 * Anthropic uses versioned names, OpenAI uses its own naming scheme.
 * ElizaCloud proxies to OpenAI models.
 */
const CHEAP_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  elizacloud: 'openai/gpt-4o-mini',               // ElizaCloud uses owner/model IDs
};

/**
 * Filter attempt history to only lines for issues in the current batch.
 * WHY: Audit showed full history (all issues) sent to every verify batch; only the current batch is relevant.
 * NOTE: batchIds should be raw comment IDs (PRRC_...) matching the format from getAttemptHistoryForIssues.
 * The batch input uses synthetic issue_N IDs, so callers must map back to comment IDs before calling this.
 */
function filterAttemptHistoryToBatch(attemptHistory: string, batchIds: string[]): string {
  const set = new Set(batchIds);
  return attemptHistory
    .split('\n')
    .filter((line) => {
      const m = line.match(/^Issue\s+(\S+):/);
      return m && set.has(m[1]);
    })
    .join('\n');
}

export class LLMClient {
  private provider: LLMProvider;
  private model: string;
  /** When set (e.g. PRR_VERIFIER_MODEL), batch verification uses this instead of model to reduce false negatives. */
  private verifierModel?: string;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private thinkingBudget?: number;
  /** Masked API key hint for ElizaCloud 401 error messages (never the actual key). */
  private elizacloudKeyHint?: string;
  /** When set, all SDK requests use this signal so the run can cancel in-flight calls on fatal error. */
  private runAbortSignal: AbortSignal | null = null;

  /** Set the run-scoped abort signal; call with null to clear. Cancels in-flight requests when aborted. */
  setRunAbortSignal(signal: AbortSignal | null): void {
    this.runAbortSignal = signal;
  }

  /** Preferred model for verification (e.g. PRR_VERIFIER_MODEL). Used for escalation so "stronger" is deterministic. */
  getVerifierModel(): string | undefined {
    return this.verifierModel;
  }

  constructor(config: Config) {
    this.provider = config.llmProvider;
    this.model = config.llmModel;
    this.verifierModel = config.verifierModel;
    this.thinkingBudget = config.anthropicThinkingBudget;

    if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
      if (this.thinkingBudget) {
        debug(`Extended thinking enabled with budget: ${this.thinkingBudget} tokens`);
      }
    } else if (this.provider === 'elizacloud') {
      this.elizacloudKeyHint = maskApiKey(config.elizacloudApiKey);
      debug('ElizaCloud LLM client', {
        baseURL: ELIZACLOUD_API_BASE_URL,
        apiKey: this.elizacloudKeyHint,
      });
      if (!this.verifierModel) {
        debug('PRR_VERIFIER_MODEL not set — using llmModel for verification. Set PRR_VERIFIER_MODEL for stronger verification.');
      }
      this.openai = createElizaCloudOpenAIClient(config.elizacloudApiKey!);
    } else {
      this.openai = new OpenAI({
        apiKey: config.openaiApiKey,
      });
    }
  }

  async complete(prompt: string, systemPrompt?: string, options?: CompleteOptions): Promise<LLMResponse> {
    // Sanitize inputs: strip unpaired UTF-16 surrogates that cause JSON serialization
    // errors (Anthropic API returns 400 "no low surrogate in string"). These can appear
    // in code snippets read from binary or corrupted files.
    prompt = sanitizeForJson(prompt);
    if (systemPrompt) {
      systemPrompt = sanitizeForJson(systemPrompt);
    }

    // Allow callers to override the model for this request (no instance mutation to avoid race conditions)
    // WHY: The LLM client defaults to the verification model (often haiku),
    // but some callers (like tryDirectLLMFix) need a stronger model for code fixing
    const chosenModel = options?.model ?? this.model;

    debug(`LLM request to ${this.provider}/${chosenModel}`, {
      promptLength: prompt.length,
      hasSystemPrompt: !!systemPrompt,
    });
    
    // Log full prompt to debug file
    const fullPrompt = systemPrompt ? `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${prompt}` : prompt;
    debugPrompt(`llm-${this.provider}`, fullPrompt, { model: chosenModel });
    
    const is429 = (e: unknown) => {
      const status = (e as { status?: number })?.status;
      const msg = e instanceof Error ? e.message : String(e);
      return status === 429 || /429|Too many requests|rate limit/i.test(msg);
    };
    const isServerError = (e: unknown) => {
      const status = (e as { status?: number })?.status;
      const msg = e instanceof Error ? e.message : String(e);
      return status === 500 || /500|504|502|gateway.*timeout|deployment.*timeout|error occurred with your deployment/i.test(msg);
    };

    let elizaAcquired = false;
    try {
      if (this.provider === 'elizacloud') {
        await acquireElizacloud().then(() => elizaAcquired = true); // uses exported fn so same global limit as llm-api runner
        elizaAcquired = true;
      }
      const max429Retries = this.provider === 'elizacloud' ? 3 : 0;
      const max504Retries = options?.max504Retries ?? (this.provider === 'elizacloud' ? 2 : 0);
      const backoffMs = this.provider === 'elizacloud' ? [60_000, 60_000, 60_000] : [2000, 4000, 8000];
      const backoff504Ms = this.provider === 'elizacloud' ? [10_000, 20_000] : [10_000];
      // ElizaCloud STRICT = 10 req/min; short backoff (2s/4s/8s) sends 4 requests in ~14s → 429. Use 60s so retries stay under limit.
      let lastErr: unknown;
      for (let attempt = 0; attempt <= max429Retries; attempt++) {
        try {
          let response: LLMResponse | undefined;
          for (let attempt504 = 0; attempt504 <= max504Retries; attempt504++) {
            try {
              response = this.provider === 'anthropic'
                ? await this.completeAnthropic(prompt, systemPrompt, chosenModel)
                : await this.completeOpenAI(prompt, systemPrompt, chosenModel);
              break;
            } catch (e504) {
              if (this.provider === 'elizacloud') {
                debug('ElizaCloud error (response context)', getElizaCloudErrorContext(e504));
              }
              const timeoutMsg = e504 instanceof Error && /timeout/i.test(e504.message);
              if (attempt504 < max504Retries && (isServerError(e504) || timeoutMsg)) {
                const delayMs = Array.isArray(backoff504Ms) ? backoff504Ms[attempt504] ?? backoff504Ms[backoff504Ms.length - 1] : backoff504Ms;
                debug('Server error or request timeout, retrying', {
                  attempt: attempt504 + 1,
                  maxRetries: max504Retries,
                  delayMs,
                });
                await new Promise(r => setTimeout(r, delayMs));
              } else {
                throw e504;
              }
            }
          }

          if (!response) throw new Error('LLM request failed after retries');

          debug('LLM response', {
            responseLength: response.content.length,
            usage: response.usage,
          });

          debugResponse(`llm-${this.provider}`, response.content, {
            model: chosenModel,
            usage: response.usage,
          });

          if (response.usage) {
            trackTokens(response.usage.inputTokens, response.usage.outputTokens);
          }

          return response;
        } catch (err) {
          lastErr = err;
          if (this.provider === 'elizacloud') {
            const status = (err as { status?: number })?.status;
            const msg = err instanceof Error ? err.message : String(err);
            if (status === 401 || /401|Unauthorized|Authentication required/i.test(msg)) {
              const url = ELIZACLOUD_API_BASE_URL;
              const keyHint = this.elizacloudKeyHint ?? maskApiKey(undefined);
              debug('ElizaCloud 401', { requestURL: `${url}/chat/completions`, apiKey: keyHint, ...getElizaCloudErrorContext(err) });
              throw new Error(
                `ElizaCloud API key was rejected (401 Unauthorized). ` +
                `Request URL: ${url}/chat/completions. API key: ${keyHint}. ` +
                `Check that ELIZACLOUD_API_KEY in .env is correct for this URL, has no extra spaces/newlines, and has not been revoked.`
              );
            }
            if (is429(err) && attempt < max429Retries) {
              const wait = backoffMs[attempt] ?? 8000;
              debug(`ElizaCloud 429, retry ${attempt + 1}/${max429Retries} in ${wait}ms`);
              await new Promise(r => setTimeout(r, wait));
              continue;
            }
          }
          if (this.provider === 'elizacloud') {
            debug('ElizaCloud error (response context)', getElizaCloudErrorContext(err));
          }
          throw err;
        }
      }
      if (this.provider === 'elizacloud' && lastErr != null) {
        debug('ElizaCloud error (response context)', getElizaCloudErrorContext(lastErr));
      }
      const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      debugPromptError(`llm-${this.provider}`, lastMsg, {
        model: chosenModel,
        status: (lastErr as { status?: number })?.status,
        is504: lastErr != null && isServerError(lastErr),
        isTimeout: /timeout/i.test(lastMsg),
      });
      throw lastErr;
    } finally {
      if (this.provider === 'elizacloud' && elizaAcquired) {
        releaseElizacloud();
      }
    // Review: ensures slot release only if acquisition is successful to maintain accurate in-flight count.
    }
  }

  /**
   * Same as complete() but uses the cheap model for this provider (haiku/mini).
   * Use for lightweight tasks (e.g. LLM dedup) to save cost; default model is for verification/fixing.
   */
  async completeWithCheapModel(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    const cheapModel = CHEAP_MODELS[this.provider];
    if (!cheapModel) {
      return this.complete(prompt, systemPrompt);
    }
    return this.complete(prompt, systemPrompt, { model: cheapModel });
  }

  private async completeAnthropic(prompt: string, systemPrompt?: string, model?: string): Promise<LLMResponse> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    const chosenModel = model ?? this.model;

    // Build request options
    // max_tokens is required by the Anthropic API — we can't omit it.
    // Set it high so it's never the constraint; response length is controlled
    // via prompt instructions, not this parameter. You only pay for tokens
    // actually generated, not the budget ceiling.
    //
    // WHY 64K default: Sonnet/Haiku cap at 64K. Opus also caps at 64K unless
    // extended thinking is enabled — requesting 128K without thinking causes 400.
    const isHighOutputModel = chosenModel.includes('opus');
    const maxOutputTokens = (isHighOutputModel && this.thinkingBudget) ? 128_000 : 64_000;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestOptions: any = {
      model: chosenModel,
      max_tokens: maxOutputTokens,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    const maxTokens = requestOptions.max_tokens;
    if (this.thinkingBudget && this.thinkingBudget >= maxTokens) {
      throw new Error(`PRR_THINKING_BUDGET (${this.thinkingBudget}) must be < max_tokens (${maxTokens})`);
    }

    // Add extended thinking if budget is set
    if (this.thinkingBudget) {
      requestOptions.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudget,
      };
      debug('Using extended thinking', { budget: this.thinkingBudget });
    } else {
      // Only use system prompt when not using extended thinking
      // (extended thinking doesn't support system prompts).
      // Use block format with cache_control so Anthropic caches the system
      // prompt prefix across calls. Cache reads are 90% cheaper than base
      // input — big win for repeated calls like batch analysis and verification.
      const systemText = systemPrompt || 'You are a helpful code review assistant.';
      requestOptions.system = [
        {
          type: 'text',
          text: systemText,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    const requestOpts = this.runAbortSignal ? { signal: this.runAbortSignal } : undefined;
    const response = await this.anthropic.messages.create(requestOptions, requestOpts);

    // Extract text content (skip thinking blocks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = response.content
      .filter((block: any) => block.type === 'text' && 'text' in block)
      .map((block: any) => block.text)
      .join('');

    // Log thinking if present (extended thinking feature)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thinkingBlock = response.content.find((block: any) => block.type === 'thinking');
    if (thinkingBlock && 'thinking' in thinkingBlock) {
      debug('Extended thinking output', (thinkingBlock as any).thinking);
    }

    // Capture cache usage stats from Anthropic's response.
    // WHY log: Without observability, you can't tell if caching is actually
    // working. Cache hits depend on the system prompt exceeding the model's
    // minimum cacheable size (1024 tokens for Sonnet, 2048 for Haiku). If
    // you see only cacheWrite with zero cacheRead, the system prompt is too
    // small or the prefix changed between calls.
    const usage: any = response.usage;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    if (cacheCreation > 0 || cacheRead > 0) {
      debug('Anthropic prompt cache', {
        cacheWrite: cacheCreation,
        cacheRead: cacheRead,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        savingsPercent: cacheRead > 0
          ? Math.round((cacheRead / (response.usage.input_tokens + cacheRead)) * 90) + '%'
          : '0%',
      });
    }

    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: cacheCreation || undefined,
        cacheReadInputTokens: cacheRead || undefined,
      },
    };
  }

  private async completeOpenAI(prompt: string, systemPrompt?: string, model?: string): Promise<LLMResponse> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const chosenModel = model ?? this.model;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    
    // WHY suppress for Qwen: Asking the model not to emit <think> reduces output tokens and latency;
    // we still strip in response as a fallback for other models or when the instruction is ignored.
    const noThinkSuffix = /\bqwen\b/i.test(chosenModel)
      ? '\nDo NOT include <think> tags or internal reasoning. Respond directly.'
      : '';

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt + noThinkSuffix });
    } else if (noThinkSuffix) {
      messages.push({ role: 'system', content: noThinkSuffix.trim() });
    }
    
    messages.push({ role: 'user', content: prompt });

    // Cap completion tokens so input + completion stays under small-context model limits
    // (e.g. Qwen3-14B has 40,960 total; gateway often defaults to 16k output → over limit).
    const maxCompletionTokens = 8192;
    const requestOpts = this.runAbortSignal ? { signal: this.runAbortSignal } : undefined;
    const response = await this.openai.chat.completions.create(
      { model: chosenModel, messages, max_completion_tokens: maxCompletionTokens },
      requestOpts
    );

    let content = response.choices[0]?.message?.content || '';

    // Strip <think>…</think> reasoning blocks emitted by models like Qwen.
    // WHY: They waste ~30% output tokens and break parsers that expect content to start
    // with the answer (e.g. startsWith('YES')). Second replace handles unclosed think (truncated output).
    if (/<think>/i.test(content)) {
      content = content
        .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
        .replace(/<think>[\s\S]*/i, '')
        .trim();
    }

    return {
      content,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  // Static system prompt for checkIssueExists — extracted here so Anthropic can
  // cache it across sequential per-comment checks via cache_control (set in
  // completeAnthropic). WHY static readonly: The instructions never change
  // between calls — only the dynamic comment/code data varies. Keeping them
  // as a class constant avoids re-building the string on every call and makes
  // the cache-friendly structure explicit.
  private static readonly CHECK_ISSUE_SYSTEM_PROMPT = [
    'You are a strict code reviewer verifying whether a review comment has been properly addressed.',
    '',
    'INSTRUCTIONS:',
    '1. Carefully read the review comment to understand EXACTLY what is being requested',
    '2. Examine the code to see if the SPECIFIC issue has been fixed',
    '3. Be STRICT: partial fixes, workarounds, or tangentially related changes do NOT count',
    '4. If the comment asks for X and the code does Y, that is NOT fixed unless Y fully addresses X',
    '',
    'Is this SPECIFIC issue STILL PRESENT in the code?',
    '',
    'CRITICAL - Your explanation will be recorded for feedback between the issue generator and judge:',
    '- If you say NO (not present), you MUST provide a DETAILED explanation citing the SPECIFIC code that resolves the issue',
    '- Your explanation helps the generator learn to avoid false positives',
    '- Empty or vague explanations are NOT acceptable - be specific and cite actual code',
    '',
    'Respond with EXACTLY one of these formats:',
    'YES: <quote the problematic code or explain what\'s still missing>',
    'NO: <cite the SPECIFIC code/line that resolves this issue and explain HOW it addresses the comment>',
    'STALE: <explain why this comment no longer applies to the current code>',
    '',
    'Use STALE when the code has been restructured so fundamentally that the review',
    'comment\'s concern no longer applies — e.g., the function was removed, the file',
    'was rewritten, or the code pattern the comment referenced is gone. Do NOT use',
    'STALE just because the fix approach would be different than what the comment',
    'suggested — if the underlying issue still exists, say YES.',
    '',
    'Examples of GOOD explanations:',
    'NO: Line 45 now has null check: if (value === null) return;',
    'NO: TypeScript type \'NonNullable<T>\' at line 23 prevents null from being passed',
    'NO: Function already implements this at lines 67-70: try { ... } catch (error) { logger.error(error); }',
    'STALE: The processUser function mentioned in the comment no longer exists in this file; the entire module was refactored to use a different architecture',
    // Review: ensures we return true for unresolved issues when parsing fails for robust handling.
    '',
    'Examples of BAD explanations (NEVER do this):',
    'NO: Fixed',
    'NO: Already done',
    'NO: Looks good',
    'STALE: Not applicable',
  ].join('\n');

  async checkIssueExists(
    comment: string,
    filePath: string,
    line: number | null,
    codeSnippet: string,
    contextHints?: string[]
  ): Promise<{ exists: boolean; explanation: string; stale: boolean }> {
    const hintsSection = contextHints && contextHints.length > 0
      ? contextHints.map(hint => `NOTE: ${hint}`).join('\n') + '\n\n'
      : '';
    
    const cleanComment = sanitizeCommentForPrompt(comment);
    const prompt = `${hintsSection}REVIEW COMMENT:
---
File: ${filePath}
${line ? `Line: ${line}` : 'Line: (not specified)'}
Comment: ${cleanComment}
---

CURRENT CODE AT THAT LOCATION:
---
${codeSnippet}
---`;

    const response = await this.complete(prompt, LLMClient.CHECK_ISSUE_SYSTEM_PROMPT);
    const content = response.content.trim();

    const verdictMatch = content.match(/^(YES|NO|STALE)\b/i);
    if (!verdictMatch) {
      debug('checkIssueExists parse failed; marking as still exists', {
        filePath,
        line,
        responsePreview: content.substring(0, 300),
      });
      return {
        exists: true,
        stale: false,
        explanation: 'LLM response could not be parsed - needs manual review',
      };
    }

    const isStale = verdictMatch[1].toUpperCase() === 'STALE';
    const exists = verdictMatch[1].toUpperCase() === 'YES';
    const explanation = content.replace(/^(YES|NO|STALE)[:\s-]*/i, '').trim();

    return { 
      exists: !isStale && exists, 
      stale: isStale, 
      explanation 
    // Review: lenient parsing handles variations in expected response formats effectively
    };
  }

  /**
   * Batch check if issues still exist, with dynamic batching for large issue sets.
   * 
   * WHY BATCHING: 100 issues × 3KB each = 300KB prompt, which exceeds model limits.
   * We split into multiple batches based on maxContextChars.
   * 
   * @param maxContextChars - Maximum characters per batch (default 100k for ElizaCloud, 150k otherwise)
   * @param maxIssuesPerBatch - Override max issues per batch (default: 10 for small models on ElizaCloud, else 25/50)
   */
  async batchCheckIssuesExist(
    issues: Array<{
      id: string;
      comment: string;
      filePath: string;
      line: number | null;
      codeSnippet: string;
      contextHints?: string[];
    }>,
    modelContext?: ModelRecommendationContext,
    maxContextChars?: number,
    maxIssuesPerBatch?: number
  ): Promise<BatchCheckResult> {
    if (issues.length === 0) {
      return { issues: new Map() };
    }

    // ElizaCloud uses small-context models (e.g. Qwen3-14B 40k). Reserve room for completion.
    const providerCap = this.provider === 'elizacloud' ? 90_000 : 150_000;
    const effectiveMaxContextChars = maxContextChars != null
      ? Math.min(maxContextChars, providerCap)
      : providerCap;

    // Static instructions are passed as a system prompt so Anthropic can cache
    // them across batches (cache_control is added in completeAnthropic).
    // The user message only contains the dynamic issue data.
    const systemPrompt = [
      'You are a STRICT code reviewer verifying whether review comments have been properly addressed.',
      '',
      'RULES:',
      '- Be STRICT: partial fixes, workarounds, or tangentially related changes do NOT count as fixed',
      '- If the comment asks for X and the code does Y, that is NOT fixed unless Y fully addresses X',
      '- When in doubt, say YES (issue still exists) - false negatives are worse than false positives',
      // WHY: Without this, judge sometimes said YES when code already addressed the comment, triggering unnecessary fixer attempts; NO + citation reduces ALREADY_FIXED cycles.
      '- If the Current Code already implements what the review asks for, respond NO and cite the specific code that resolves it (reduces ALREADY_FIXED fix attempts).',
      '',
      'CRITICAL - Your explanations will be recorded for feedback between the issue generator and judge:',
      '- For NO (issue resolved), your explanation MUST cite specific code or line numbers; "Fixed" or "Done" alone is invalid.',
      '- Your explanations help the generator learn to avoid false positives',
      '- Empty or vague explanations like "Fixed" or "Looks good" are NOT acceptable',
      '- Be specific and cite actual code/line numbers',
      '',
      'For EACH issue, respond with a line in this exact format (use colons, no pipes):',
      'ISSUE_ID: YES|NO|STALE: I<1-5>: D<1-5>: cite specific code or explain',
      'Use colons between fields. No pipes except in YES|NO|STALE. No extra spaces.',
      '',
      'Output exactly one line per issue. Use each issue ID (issue_1, issue_2, ...) only once. Do not output multiple lines for the same issue.',
      '',
      'For issues that still exist (YES), also rate:',
      '- I<1-5> importance: 1=critical security/data loss, 2=major bug, 3=moderate, 4=minor, 5=trivial style',
      '- D<1-5> difficulty: 1=one-line fix, 2=simple, 3=moderate, 4=complex multi-file, 5=major refactor',
      '',
      'For NO/STALE responses, you may omit the I/D ratings (they won\'t be used).',
      '',
      'Use STALE when the code has been restructured so fundamentally that the review comment',
      'no longer applies — e.g., the function was removed, the file was rewritten, or the code',
      'pattern referenced is gone. Do NOT use STALE just because the fix approach would be',
      'different — if the underlying issue still exists, say YES.',
      '',
      'CRITICAL - Distinguish TRUNCATED snippets from COMPLETE files:',
      '- If the Current code block ends with "... (truncated — file has N lines total)" or "... (truncated — snippet was cut for prompt size)", the snippet is PARTIAL.',
      '  If you cannot see the specific lines referenced in the review at all, answer STALE (do not speculate). If you can see the referenced area and the issue still exists there, answer YES. Do NOT conclude a function/symbol was removed just because it does not appear in the excerpt.',
      '- If the Current code block ends with "(end of file — N lines total)", you are seeing the ENTIRE file.',
      '  If the review references code/lines that do not exist anywhere in the shown file, the code was genuinely',
      '  removed or rewritten. Use STALE.',
      '- If "(end of file)" says the file has N lines but the comment references line M where M > N,',
      '  the file was shortened and the referenced code no longer exists. Use STALE.',
      '',
      'CRITICAL - Base your verdict on the ACTUAL CODE shown, not the review comment\'s description:',
      '- Read the Current Code carefully. If the review says "rank += 1 inside enumerate" but the Current Code',
      '  contains no enumerate loop and no rank += 1, do NOT claim the bug still exists.',
      '- Your job is to check whether the CURRENT CODE has the problem, not whether the review\'s description sounds bad.',
      '- If the code pattern described in the review is absent from the Current Code (and the snippet is complete),',
      '  the issue is resolved or stale — do NOT parrot the review comment as if it describes the current state.',
      '',
      'CRITICAL - Verdict must match explanation: if your explanation says the issue "still exists"',
      'or "confirming the issue still exists", your verdict must be YES, not NO.',
      '',
      'CRITICAL FORMAT RULE: Do NOT use markdown formatting in your response lines.',
      'No bold (**), no headings (#), no backticks around issue IDs.',
      'Just plain text: issue_1: YES: I1: D2: explanation',
      '',
      'Example GOOD responses:',
      'issue_1: YES: I1: D2: Line 45 still has SQL injection via unsanitized user input',
      'issue_2: YES: I4: D1: Line 12 uses `var` instead of `const`',
      'issue_3: NO: Line 23 now has `if (input === null) return;` guard',
      'issue_4: STALE: The processUser function no longer exists; module was refactored',
      '',
      'Example BAD responses (NEVER do this):',
      '**issue_1**: YES: ...',
      '## issue_1: YES: ...',
      'issue_1: NO: Fixed',
      'issue_2: NO: Done',
      'issue_3: NO: Already implemented',
      'issue_4: STALE: Not applicable',
    ].join('\n');
    
    const headerSize = systemPrompt.length;
    const footerSize = 200; // Reserve space for closing instructions
    const includeModelRec = modelContext?.includeModelRecommendation !== false;
    const modelRecSize = (includeModelRec && modelContext?.availableModels?.length) ? 1500 : 0;
    const availableForIssues = effectiveMaxContextChars - headerSize - footerSize - modelRecSize;

    // WHY wider snippets when headroom: Truncated snippets led to conservative "say YES" and false positives (audit).
    // When effectiveMaxContextChars >= 100k we use 2500/3000 for comment/code per issue; smaller providers keep 2000/2000.
    const wideSnippets = effectiveMaxContextChars >= 100_000;
    const maxCommentLen = wideSnippets ? 2500 : 2000;
    const maxCodeLen = wideSnippets ? 3000 : 2000;

    const buildIssueText = (issue: typeof issues[0]): string => {
      // Sanitize HTML noise (base64 JWT links, metadata comments, <picture> tags)
      // THEN truncate. Without sanitizing first, a 600-char JWT blob can consume
      // 30% of the truncation budget, leaving too little actual description.
      const cleanComment = sanitizeCommentForPrompt(issue.comment);
      const truncatedComment = cleanComment.length > maxCommentLen
        ? cleanComment.substring(0, maxCommentLen) + '...'
        : cleanComment;
      // WHY hasCode + placeholder: Empty codeSnippet used to produce an empty ``` block; the judge had no context and
      // could respond STALE or guess. We show an explicit placeholder: do NOT respond STALE; if unable to verify,
      // respond YES with explanation (audit: prompts.log issue_8/issue_12 had empty Current code).
      const hasCode = (issue.codeSnippet ?? '').trim().length > 0;
      const truncatedCode = hasCode
        ? (issue.codeSnippet.length > maxCodeLen
            ? issue.codeSnippet.substring(0, maxCodeLen) + '\n... (truncated — snippet was cut for prompt size)'
            : issue.codeSnippet)
        : '';

      const parts = [];
      
      // Inject context hints as factual observations
      if (issue.contextHints && issue.contextHints.length > 0) {
        for (const hint of issue.contextHints) {
          parts.push(`NOTE: ${hint}`);
        }
        parts.push('');
      }
      
      parts.push(
        `## Issue ${issue.id}`,
        `File: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}`,
        `Comment: ${truncatedComment}`,
        '',
        'Current code:',
        '```',
        hasCode ? truncatedCode : '(snippet unavailable — do NOT respond STALE; if you cannot verify from the comment alone, respond YES with explanation that code was not visible)',
        '```',
        '',
      );

      return parts.join('\n');
    };

    // Build batches dynamically based on content size AND issue count.
    // WHY max issues per batch: Even if the prompt fits within context limits,
    // the LLM must produce one response line per issue. With 189 issues, that's
    // ~15K+ output chars. Haiku (and even larger models) often truncate or
    // summarize instead of listing all items. Cap at 50 issues per batch to
    // ensure the model can actually respond to each one.
    // WHY smaller for ElizaCloud: Gateways often 500/504 on large requests.
    // Small models (14b, mini) get 10 issues per batch to avoid 200k-char prompts.
    const defaultMaxPerBatch =
      this.provider === 'elizacloud'
        ? (/\b(14b|mini|qwen-3-14b|gpt-4o-mini)\b/i.test(this.model) ? 10 : 25)
        : 50;
    const MAX_ISSUES_PER_BATCH = maxIssuesPerBatch ?? defaultMaxPerBatch;
    const batches: Array<{ issues: typeof issues; issueTexts: string[] }> = [];
    let currentBatch: typeof issues = [];
    let currentTexts: string[] = [];
    let currentSize = 0;

    for (const issue of issues) {
      const issueText = buildIssueText(issue);
      const issueSize = issueText.length;

      // Start a new batch if adding this issue would exceed size OR count limit
      if ((currentSize + issueSize > availableForIssues || currentBatch.length >= MAX_ISSUES_PER_BATCH) && currentBatch.length > 0) {
        batches.push({ issues: currentBatch, issueTexts: currentTexts });
        currentBatch = [];
        currentTexts = [];
        currentSize = 0;
      }

      currentBatch.push(issue);
      currentTexts.push(issueText);
      currentSize += issueSize;
    }

    // Don't forget the last batch
    if (currentBatch.length > 0) {
      batches.push({ issues: currentBatch, issueTexts: currentTexts });
    }

    debug('Batch check batches', { 
      total: issues.length,
      batches: batches.length, 
      sizes: batches.map(b => b.issues.length),
      maxContextChars: effectiveMaxContextChars,
      maxIssuesPerBatch: MAX_ISSUES_PER_BATCH,
    });

    // Process all batches
    const allResults = new Map<string, {
      exists: boolean;
      explanation: string;
      stale: boolean;
      importance: number;
      ease: number;
    }>();
    let recommendedModels: string[] | undefined;
    let modelRecommendationReasoning: string | undefined;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const { issues: batchIssues, issueTexts } = batches[batchIdx];
      const isFirstBatch = batchIdx === 0;
      
      debug(`Processing batch ${batchIdx + 1}/${batches.length}`, { 
        issueCount: batchIssues.length,
        chars: issueTexts.join('').length + headerSize + footerSize
      });

      try {
      // Build user message with only dynamic content (static rules are in systemPrompt)
      const parts = [
        ...issueTexts,
        '---',
        '',
        'Now analyze each issue STRICTLY and respond with one line per issue:',
      ];

      // Only ask for model recommendation in first batch when requested (omitted for verification to save tokens).
      if (isFirstBatch && includeModelRec && modelContext?.availableModels?.length) {
        parts.push('');
        parts.push('---');
        parts.push('');
        parts.push('## Model Recommendation');
        parts.push('');
        parts.push('After analyzing the issues above, recommend which AI models should attempt to fix them.');
        parts.push(`Available models (in order): ${modelContext.availableModels.join(', ')}`);
        parts.push('');
        parts.push('Consider:');
        parts.push('- Issue complexity: security/refactoring issues need capable models, typos/style can use fast models');
        parts.push('- Issue count and diversity: many issues or multi-file changes need capable models');
        parts.push('- Previous attempts: if a model already failed, try a different one');
        parts.push('');
        
        // Cap model/attempt history so first batch doesn't exceed gateway limits (was 100k+ and caused 500)
        const MODEL_HISTORY_MAX = 1500;
        const ATTEMPT_HISTORY_MAX = 2500;
        if (modelContext.modelHistory) {
          parts.push('## Model Performance on This Codebase');
          const m = modelContext.modelHistory;
          parts.push(m.length <= MODEL_HISTORY_MAX ? m : m.slice(0, MODEL_HISTORY_MAX) + '\n...(truncated)');
          parts.push('');
        }
        if (modelContext.attemptHistory) {
          parts.push('## Previous Attempts on These Issues');
          // WHY filter to batch: Audit showed full attempt history (all issues) sent to every batch; only current batch is relevant.
          const filtered = filterAttemptHistoryToBatch(modelContext.attemptHistory, batchIssues.map(i => i.id));
          const a = filtered.length <= ATTEMPT_HISTORY_MAX ? filtered : filtered.slice(0, ATTEMPT_HISTORY_MAX) + '\n...(truncated)';
          parts.push(a);
          parts.push('');
        }
        
        parts.push('End your response with this line:');
        parts.push('MODEL_RECOMMENDATION: model1, model2, model3 | explain why these models in this order');
        parts.push('');
        parts.push('Examples:');
        parts.push('MODEL_RECOMMENDATION: claude-sonnet-4-5, gpt-5.2 | Complex security issues, skip mini models');
        parts.push('MODEL_RECOMMENDATION: gpt-5-mini, claude-haiku | Simple style/formatting fixes only');
      }

      const response = await this.complete(parts.join('\n'), systemPrompt);
      const allowedIds = new Set(batchIssues.map(issue => normalizeIssueId(issue.id)));

      // Parse issue responses with optional triage scores
      // WHY two-stage parse: LLM may omit I/D ratings for NO/STALE responses.
      // Graceful fallback to default (3) means old-format responses still parse correctly.
      const lines = response.content.split('\n');
      for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(YES|NO|STALE):\s*(.*)$/i);
        if (match) {
          let [, id, response, rest] = match;
          const resultId = normalizeIssueId(id);
          if (!allowedIds.has(resultId)) {
            debug('Ignoring unmatched batch issue id', { id: id.trim(), resultId });
            continue;
          }
          
          // Stage 2: Try to extract I<n>: D<n>: triage scores
          let importance = 3, ease = 3;  // Graceful defaults
          const triageMatch = rest.match(/^I(\d):\s*D(\d):\s*(.*)$/i);
          if (triageMatch) {
            // Clamp to 1-5 range (LLMs sometimes output 0 or 6)
            importance = Math.min(5, Math.max(1, parseInt(triageMatch[1], 10)));
            ease = Math.min(5, Math.max(1, parseInt(triageMatch[2], 10)));
            rest = triageMatch[3];
          }
          
          const responseUpper = response.toUpperCase();
          const explanation = rest.trim();
          let exists = responseUpper === 'YES';
          let stale = responseUpper === 'STALE';

          // Override: explanation contradicts verdict — e.g. "confirming the issue still exists" with NO
          if (responseUpper === 'NO' && (
            /confirming the issue still exists/i.test(explanation) ||
            /issue still exists/i.test(explanation) ||
            /still exists.*confirm/i.test(explanation)
          )) {
            debug('Batch override: NO→YES (explanation says issue still exists)', { resultId, explanationPreview: explanation.slice(0, 80) });
            exists = true;
            stale = false;
          }

          const missingCodeVisibility = explanationMentionsMissingCodeVisibility(explanation);

          // Override: NO but explanation says code/excerpt not visible or can't confirm — per judge instructions
          // "if you would say 'not in excerpt', say YES not STALE". Verifier said NO (fixed) while admitting
          // they couldn't see the code; that contradicts NO (we should treat as unverified / still exists).
          // WHY use the shared helper here too: the same underlying uncertainty can arrive as either
          // a NO or STALE verdict depending on model phrasing. In both cases the correct policy is
          // "keep the issue open until we have enough visible code," not "trust the fixed verdict."
          if (responseUpper === 'NO' && missingCodeVisibility) {
            debug('Batch override: NO→YES (explanation says code visibility was incomplete)', { resultId, explanationPreview: explanation.slice(0, 80) });
            exists = true;
            stale = false;
          }

          // Override: NO but explanation says the requested fix is missing (e.g. "without any mapping of editor").
          // Cycle 14 M2: Verifier said NO (fixed) while describing that the code still lacks the requested behavior.
          if (responseUpper === 'NO' && /\bwithout (?:any|proper) (?:mapping|handling|validation)\b/i.test(explanation)) {
            debug('Batch override: NO→YES (explanation says requested fix missing)', { resultId, explanationPreview: explanation.slice(0, 80) });
            exists = true;
            stale = false;
          }

          // Override: YES but explanation says the code is already correct or the review comment is mistaken.
          // Guard: skip override if explanation also says "still needs", "but X is missing", "however" — partial fix, not fully resolved.
          const looksAlreadyCorrect = (
            /\b(?:this is )?actually correct\b/i.test(explanation) ||
            /\bcode is (?:already )?correct\b/i.test(explanation) ||
            /\balready (?:implements?|addressed|handled|correct)\b/i.test(explanation) ||
            /\bcomment (?:appears to be |is |seems? )?mistaken\b/i.test(explanation) ||
            /\breview (?:comment )?(?:appears to be |is |seems? )?(?:mistaken|incorrect|wrong)\b/i.test(explanation)
          );
          const hasCounterSignal = (
            /\bstill (?:needs?|exists?|missing|requires?)\b/i.test(explanation) ||
            /\bbut\b.*\b(?:missing|needs?|lacks?|doesn't|does not)\b/i.test(explanation) ||
            /\bhowever\b.*\b(?:missing|needs?|lacks?|doesn't|does not)\b/i.test(explanation)
          );
          const sourceIssue = batchIssues.find((issue) => normalizeIssueId(issue.id) === resultId);
          const conservativeExistenceCheck = commentNeedsConservativeExistenceCheck(sourceIssue?.comment ?? '');
          const concreteEvidence = explanationHasConcreteFixEvidence(explanation);
          if (exists && looksAlreadyCorrect && !hasCounterSignal && !conservativeExistenceCheck && concreteEvidence) {
            debug('Batch override: YES→NO (explanation says code is already correct or comment is mistaken)', { resultId, explanationPreview: explanation.slice(0, 120) });
            exists = false;
          } else if (exists && looksAlreadyCorrect && !hasCounterSignal && (!conservativeExistenceCheck || !concreteEvidence)) {
            debug('Batch kept as YES (already-correct override lacked concrete evidence or comment needs conservative check)', {
              resultId,
              conservativeExistenceCheck,
              concreteEvidence,
              explanationPreview: explanation.slice(0, 120),
            });
          }

          if (exists && missingCodeVisibility) {
            debug('Batch kept as YES (explanation says code visibility was incomplete)', { resultId, explanationPreview: explanation.slice(0, 80) });
          }

          // Override: STALE only because symbol/code "not visible" or "can't evaluate" — treat as YES.
          // WHY: Judge instructions say "if you would say 'not visible in the provided excerpt' or 'not in excerpt', say YES not STALE".
          // The verifier often used different phrasings ("can't be evaluated", "code doesn't show", "only shows the beginning"); without this override
          // we falsely dismiss issues as STALE when the real reason is incomplete snippet (prompts.log audit: 48 such verdicts).
          const staleButMissingCode = stale && missingCodeVisibility;
          if (staleButMissingCode) {
            debug('Batch override: STALE→YES (reason was missing from excerpt, not removed)', { resultId, explanationPreview: explanation.slice(0, 80) });
            exists = true;
            stale = false;
          }

          allResults.set(resultId, {
            exists,
            stale,
            explanation,
            importance,
            ease,
          });
        }
      }

      // Per-batch outcome summary
      // WHY: Without this, the only signal between batches is the raw LLM response length.
      // Operators need to see how many issues were parsed and their disposition per batch
      // to diagnose prompt/model problems early (e.g., batch 2 parsed 0 = response format issue).
      {
        let batchParsed = 0, batchExists = 0, batchFixed = 0, batchStale = 0;
        let sumImportance = 0, sumEase = 0, countTriage = 0;
        for (const issue of batchIssues) {
          const rid = normalizeIssueId(issue.id);
          const r = allResults.get(rid);
          if (r) {
            batchParsed++;
            if (r.stale) batchStale++;
            else if (r.exists) batchExists++;
            else batchFixed++;
            // Accumulate triage scores for avg calculation
            sumImportance += r.importance;
            sumEase += r.ease;
            countTriage++;
          }
        }
        const avgImportance = countTriage > 0 ? (sumImportance / countTriage).toFixed(1) : 'N/A';
        const avgEase = countTriage > 0 ? (sumEase / countTriage).toFixed(1) : 'N/A';
        debug(`Batch ${batchIdx + 1}/${batches.length} results`, {
          parsed: batchParsed,
          expected: batchIssues.length,
          stillExists: batchExists,
          alreadyFixed: batchFixed,
          stale: batchStale,
          unparsed: batchIssues.length - batchParsed,
          avgImportance,
          avgEase,
        });

        // When parsing falls short, log enough to diagnose the problem
        if (batchParsed < batchIssues.length) {
          const unparsedIssueIds = batchIssues
            .filter(issue => !allResults.has(normalizeIssueId(issue.id)))
            .map(issue => issue.id);
          
          const unmatchedLines = lines
            .map(l => l.trim())
            .filter(l => l.length > 0)
            .filter(l => !l.match(/^([^:]+):\s*(YES|NO|STALE):\s*/i))
            .slice(0, 10);

          debug(`Batch ${batchIdx + 1} parse shortfall`, {
            missing: batchIssues.length - batchParsed,
            unparsedIssueIds,
            sampleUnmatchedLines: unmatchedLines,
            responsePreview: response.content.substring(0, 500),
          });
        }
      }

      // Parse model recommendation only from first batch when we asked for it
      if (isFirstBatch && includeModelRec && modelContext?.availableModels?.length) {
        const modelMatch = response.content.match(/MODEL_RECOMMENDATION:\s*([^|\n]+)\|?\s*(.*)?$/im);
        if (modelMatch) {
          const modelList = modelMatch[1];
          const reasoning = modelMatch[2]?.trim();
          
          const availableSet = new Set(modelContext.availableModels.map(m => m.toLowerCase()));
          recommendedModels = modelList
            .split(',')
            .map(m => m.trim())
            .filter(m => {
              const lower = m.toLowerCase();
              // Exact match (case-insensitive)
              if (availableSet.has(lower)) return true;
              // Prefix match: the recommended model is a prefix of an available model
              // (e.g., "claude-sonnet" matches "claude-sonnet-4-5-20250929")
              // But NOT the reverse — we don't want "gpt" to match "gpt-5.3-codex"
              // because that's too loose and could cross provider boundaries.
              for (const avail of modelContext.availableModels!) {
                const availLower = avail.toLowerCase();
                if (availLower.startsWith(lower + '-') || availLower.startsWith(lower + '/')) {
                  return true;
                }
              }
              return false;
            })
            .map(m => {
              const lower = m.toLowerCase();
              for (const avail of modelContext.availableModels!) {
                const availLower = avail.toLowerCase();
                if (availLower === lower) return avail;
                // Normalize to the full available model name
                if (availLower.startsWith(lower + '-') || availLower.startsWith(lower + '/')) {
                  return avail;
                }
              }
              return m;
            });
          
          modelRecommendationReasoning = reasoning || undefined;
          
          if (recommendedModels.length > 0) {
            debug('LLM model recommendation', { 
              recommendedModels, 
              reasoning: modelRecommendationReasoning,
            });
          }
        }
      }
      } catch (batchErr) {
        if (allResults.size > 0) {
          warn(`Batch ${batchIdx + 1}/${batches.length} failed (${batchErr instanceof Error ? batchErr.message : String(batchErr)}), returning ${allResults.size} partial result(s)`);
          return {
            issues: allResults,
            recommendedModels: recommendedModels?.length ? recommendedModels : undefined,
            modelRecommendationReasoning,
            partial: true,
          };
        }
        throw batchErr;
      }
    }

    // Aggregate summary across all batches
    {
      let totalExists = 0, totalFixed = 0, totalStale = 0;
      for (const r of allResults.values()) {
        if (r.stale) totalStale++;
        else if (r.exists) totalExists++;
        else totalFixed++;
      }
      debug('Batch check complete', { 
        parsed: allResults.size, 
        expected: issues.length,
        batches: batches.length,
        stillExists: totalExists,
        alreadyFixed: totalFixed,
        stale: totalStale,
        unparsed: issues.length - allResults.size,
      });
    }

    return {
      issues: allResults,
      recommendedModels: recommendedModels?.length ? recommendedModels : undefined,
      modelRecommendationReasoning,
    };
  }

  /**
   * Run model recommendation as a single call after all verification batches.
   * Use when verification used includeModelRecommendation: false to save tokens.
   * @param summary - Short summary of verification results (e.g. "issue_1: YES I3 D2, issue_2: NO, ...")
   * @param modelContext - Available models, model history, attempt history
   */
  async getModelRecommendationOnly(
    summary: string,
    modelContext: ModelRecommendationContext
  ): Promise<{ recommendedModels?: string[]; reasoning?: string }> {
    if (!modelContext.availableModels?.length) {
      return {};
    }
    const MODEL_HISTORY_MAX = 1500;
    const ATTEMPT_HISTORY_MAX = 2500;
    const parts = [
      '## Verification results',
      '',
      summary,
      '',
      '---',
      '',
      'Recommend which AI models should attempt to fix the issues above.',
      `Available models (in order): ${modelContext.availableModels.join(', ')}`,
      '',
      'Consider: issue complexity, count/diversity, and previous attempts.',
      '',
    ];
    if (modelContext.estimatedFixPromptChars != null && modelContext.estimatedFixPromptChars > 0) {
      parts.push(`Estimated fix prompt size for this batch: ~${Math.round(modelContext.estimatedFixPromptChars / 1000)}k chars. Consider model throughput and gateway timeout limits (e.g. 90s).`);
      parts.push('');
    }
    if (modelContext.modelHistory) {
      const m = modelContext.modelHistory;
      parts.push('## Model performance on this codebase');
      parts.push(m.length <= MODEL_HISTORY_MAX ? m : m.slice(0, MODEL_HISTORY_MAX) + '\n...(truncated)');
      parts.push('');
    }
    if (modelContext.attemptHistory) {
      const a = modelContext.attemptHistory;
      parts.push('## Previous attempts on these issues');
      parts.push(a.length <= ATTEMPT_HISTORY_MAX ? a : a.slice(0, ATTEMPT_HISTORY_MAX) + '\n...(truncated)');
      parts.push('');
    }
    parts.push('Weight overall success rate heavily — a model with 50% success is much better than one with 10%, even if the lower-rate model had one prior success on a similar issue.');
    parts.push('');
    parts.push('End your response with: MODEL_RECOMMENDATION: model1, model2, model3 | <your reasoning>');
    parts.push('Give at least one full sentence of issue-specific reasoning (e.g. which model for D3 multi-file vs D1 single-file). Do not echo this instruction; provide actual reasoning.');

    const systemPrompt = 'You recommend which AI models should fix the issues below. Consider complexity, count, and previous attempts. Weight overall success rate heavily. Respond with exactly: MODEL_RECOMMENDATION: model1, model2, model3 | <issue-specific reasoning>. Do not echo the instruction; provide actual reasoning.';
    const promptText = parts.join('\n');
    const RECOMMENDATION_RETRY_DELAY_MS = 8_000;
    let response: { content: string };
    try {
      response = await this.complete(promptText, systemPrompt);
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const isTransient = /500|502|504|timeout|gateway|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (isTransient) {
        debug('Model recommendation call failed (transient), retrying once', { message: msg.slice(0, 80) });
        await new Promise(r => setTimeout(r, RECOMMENDATION_RETRY_DELAY_MS));
        response = await this.complete(promptText, systemPrompt);
      } else {
        throw firstErr;
      }
    }

    const modelMatch = response.content.match(/MODEL_RECOMMENDATION:\s*([^|\n]+)\|?\s*(.*)?$/im);
    if (!modelMatch) return {};

    const modelList = modelMatch[1];
    const reasoning = modelMatch[2]?.trim();
    const availableSet = new Set(modelContext.availableModels.map(m => m.toLowerCase()));
    const recommendedModels = modelList
      .split(',')
      .map(m => m.trim())
      .filter(m => {
        const lower = m.toLowerCase();
        if (availableSet.has(lower)) return true;
        for (const avail of modelContext.availableModels!) {
          const availLower = avail.toLowerCase();
          if (availLower.startsWith(lower + '-') || availLower.startsWith(lower + '/')) return true;
        }
        return false;
      })
      .map(m => {
        const lower = m.toLowerCase();
        for (const avail of modelContext.availableModels!) {
          // Note: checks for model names starting with lower or lower/ to match flexible identifiers
          const availLower = avail.toLowerCase();
          if (availLower === lower) return avail;
          if (availLower.startsWith(lower + '-') || availLower.startsWith(lower + '/')) return avail;
        }
        return m;
      });

    // Don't store or log echoed instruction as reasoning (e.g. qwen-3-14b echoes "explain why these models in this order").
    const normalizedReasoning =
      reasoning && reasoning.length > 50 && !/explain why these models in this order/i.test(reasoning)
        ? reasoning
        : undefined;
    if (recommendedModels.length > 0) {
      debug('LLM model recommendation (separate call)', { recommendedModels, reasoning: normalizedReasoning ?? '(none)' });
    }
    return {
      recommendedModels: recommendedModels.length > 0 ? recommendedModels : undefined,
      reasoning: normalizedReasoning,
    };
  }

  /**
   * Final audit: Re-verify ALL issues with an adversarial, stricter prompt.
   * 
   * WHY THIS EXISTS:
   * Regular verification can have false positives - the LLM says "looks fixed"
   * when it isn't. These get cached and persist forever. The final audit:
   * 
   * 1. Runs AFTER all issues appear resolved (cache says everything is fixed)
   * 2. Cache is cleared before audit - audit results are authoritative
   * 3. Uses adversarial prompt: "Find issues NOT properly fixed"
   * 4. Requires citing specific code evidence, not just "looks good"
   * 5. Any failures get unmarked and re-enter the fix loop
   * 
   * WHY ADVERSARIAL:
   * Regular prompts ask "is this fixed?" - LLMs tend toward yes.
   * Adversarial prompts ask "what's wrong?" - catches more issues.
   * 
   * WHY DYNAMIC BATCHING:
   * 36 issues × 3KB = 108KB prompt. Too big for some models.
   * We batch based on actual content size, not fixed counts.
   * 
   * @param maxContextChars - Maximum characters per batch (default 400k, ~100k tokens)
   */
  async finalAudit(
    issues: Array<{
      id: string;
      comment: string;
      filePath: string;
      line: number | null;
      codeSnippet: string;
    }>,
    maxContextChars: number = 400_000
  ): Promise<Map<string, { stillExists: boolean; explanation: string }>> {
    if (issues.length === 0) {
      return new Map();
    }

    debug('Running final audit on all issues', { count: issues.length, maxContextChars });

    // Build the static prompt header (used for each batch)
    const headerParts = [
      'FINAL AUDIT: You are performing a thorough final review before marking this PR as complete.',
      '',
      'YOUR TASK: Find any issues that were NOT properly fixed. Be adversarial - assume fixes might be incomplete.',
      '',
      'AUDIT RULES (be strict):',
      '1. Read each review comment carefully - understand the EXACT issue being raised',
      '2. Check if the SPECIFIC problem was addressed, not just "something changed"',
      '3. Partial fixes do NOT count - the full issue must be resolved',
      '4. If you cannot find CLEAR EVIDENCE the issue is fixed, mark it as UNFIXED',
      '',
      'RESPONSE FORMAT (use exactly this format for each issue):',
      '[1] FIXED: The code now includes X',
      '[2] UNFIXED: The validation is still missing',
      '',
      '---',
      '',
    ];
    const headerSize = headerParts.join('\n').length;
    const footerSize = 100; // Reserve space for closing instructions
    const availableForIssues = maxContextChars - headerSize - footerSize;

    // Group by file so we send each file's content once per batch (saves context when many issues share a file)
    const byFile = new Map<string, typeof issues>();
    for (const issue of issues) {
      const list = byFile.get(issue.filePath) ?? [];
      list.push(issue);
      byFile.set(issue.filePath, list);
    }

    const ISSUE_HEADER_APPROX = 180; // "[N] path:line — comment preview" without code
    const batches: Array<{ groups: Array<{ filePath: string; snippets: Map<string, string>; issues: typeof issues }> }> = [];
    let currentGroups: Array<{ filePath: string; snippets: Map<string, string>; issues: typeof issues }> = [];
    let currentSize = 0;

    for (const [filePath, fileIssues] of byFile) {
      // Collect all unique snippets for this file (each issue may point to a different region)
      const snippets = new Map<string, string>();
      let totalSnippetSize = 0;
      for (const issue of fileIssues) {
        if (!snippets.has(issue.id)) {
          snippets.set(issue.id, issue.codeSnippet);
          totalSnippetSize += issue.codeSnippet.length;
        }
      }
      // Review: calculates group size by including total snippet size and header for each issue
      const groupSize = totalSnippetSize + fileIssues.length * ISSUE_HEADER_APPROX;

      if (currentSize + groupSize > availableForIssues && currentGroups.length > 0) {
        batches.push({ groups: currentGroups });
        currentGroups = [];
        currentSize = 0;
      }
      currentGroups.push({ filePath, snippets, issues: fileIssues });
      currentSize += groupSize;
    }
    if (currentGroups.length > 0) {
      batches.push({ groups: currentGroups });
    }

    const totalIssuesInBatches = batches.reduce((sum, b) => sum + b.groups.reduce((s, g) => s + g.issues.length, 0), 0);
    debug('Final audit batches (by file)', {
      batches: batches.length,
      issues: totalIssuesInBatches,
      groups: batches.map(b => b.groups.length),
    });

    const allResults = new Map<string, { stillExists: boolean; explanation: string }>();

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const { groups } = batches[batchIdx];
      const batchIssues = groups.flatMap(g => g.issues);

      const promptParts: string[] = [...headerParts];
      let issueNum = 0;
      for (const group of groups) {
        promptParts.push(`## File: ${group.filePath}`);
        const commentMax = 500;
        for (const issue of group.issues) {
          issueNum++;
          // Include each issue's specific code snippet so audit has full context
          const snippet = group.snippets.get(issue.id) ?? '';
          promptParts.push(`### [${issueNum}] ${issue.filePath}${issue.line != null ? `:${issue.line}` : ''}`);
          promptParts.push('```');
          promptParts.push(snippet);
          promptParts.push('```');
          const preview = sanitizeCommentForPrompt(issue.comment);
          const short = preview.length > commentMax ? preview.substring(0, commentMax) + '...' : preview;
          promptParts.push(`Comment: ${short}`);
          promptParts.push('');
        }
      }
      promptParts.push('---');
      promptParts.push(`Respond with exactly ${batchIssues.length} lines, one per issue [1] through [${batchIssues.length}]:`);

      const response = await this.complete(promptParts.join('\n'));

      // Parse responses - match [N] FIXED/UNFIXED pattern
      const lines = response.content.split('\n');
      for (const line of lines) {
        const match = line.match(/^\[(\d+)\]\s*(FIXED|UNFIXED):\s*(.*)$/i);
        if (match) {
          const [, numStr, status, explanation] = match;
          const idx = parseInt(numStr, 10) - 1;
          if (idx >= 0 && idx < batchIssues.length) {
            const issue = batchIssues[idx];
            allResults.set(issue.id, {
              stillExists: status.toUpperCase() === 'UNFIXED',
              explanation: explanation.trim(),
            });
          }
        }
      }
    }

    const parsed = allResults.size;
    const unfixed = Array.from(allResults.values()).filter(r => r.stillExists).length;
    
    debug('Final audit results', { 
      total: issues.length,
      parsed,
      unfixed
    });

    // Fail-safe: mark any unparsed issue as still existing (regardless of parse rate)
    // WHY: Individual unparsed issues should be treated as needing review, not silently passed
    for (const issue of issues) {
      if (!allResults.has(issue.id)) {
        allResults.set(issue.id, {
          stillExists: true,
          explanation: 'Audit response could not be parsed - needs manual review',
        });
      }
    }
    if (parsed < issues.length) {
      debug('WARNING: Some audit responses could not be parsed - marked as needing review', {
        unparsed: issues.length - parsed,
      });
    }

    return allResults;
  }

  /**
   * Build the text representation of an issue for the audit prompt
   */
  private buildIssueText(
    index: number,
    issue: { filePath: string; line: number | null; comment: string; codeSnippet: string }
  ): string {
    // Sanitize first, then truncate — removes HTML/JWT noise that wastes budget
    const maxCommentLen = 2000;
    const maxCodeLen = 2000;
    
    const cleanComment = sanitizeCommentForPrompt(issue.comment);
    const truncatedComment = cleanComment.length > maxCommentLen
      ? cleanComment.substring(0, maxCommentLen) + '...'
      : cleanComment;
    const truncatedCode = issue.codeSnippet.length > maxCodeLen
      ? issue.codeSnippet.substring(0, maxCodeLen) + '\n... (truncated — snippet was cut for prompt size)'
      : issue.codeSnippet;

    return [
      `[${index}] File: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}`,
      `Comment: ${truncatedComment}`,
      'Code:',
      '```',
      truncatedCode,
      '```',
      '',
    ].join('\n');
  }

  async verifyFix(
    comment: string,
    filePath: string,
    diff: string
  ): Promise<{ fixed: boolean; explanation: string }> {
    const cleanComment = sanitizeCommentForPrompt(comment);
    const prompt = `Given this code review comment:
---
Comment: ${cleanComment}
File: ${filePath}
---

And this code change (diff):
---
${diff}
---

Does this change adequately address the concern raised in the comment?

Respond with exactly one of these formats:
YES: <brief explanation of how the change addresses the issue>
NO: <brief explanation of what's still missing or wrong>`;

    const response = await this.complete(prompt);
    const content = response.content.trim();
    
    // Check if the response starts with a clear YES/NO verdict
    if (/^YES\b/i.test(content)) {
      return { fixed: true, explanation: content.replace(/^YES:\s*/i, '').trim() };
    }
    if (/^NO\b/i.test(content)) {
      return { fixed: false, explanation: content.replace(/^NO:\s*/i, '').trim() };
    }
    
    // LLM "thought aloud" before reaching a verdict. Scan for the LAST YES:/NO: line.
    // WHY last, not first: Models often deliberate ("the change uses X... however Y...
    // actually, the core issue IS fixed: YES: ..."). The final verdict after deliberation
    // is the most considered. Without this, a correct fix gets rejected because the
    // parser only saw the non-YES/NO preamble.
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (/^YES\b/i.test(line)) {
        return { fixed: true, explanation: line.replace(/^YES:\s*/i, '').trim() };
      }
      if (/^NO\b/i.test(line)) {
        return { fixed: false, explanation: line.replace(/^NO:\s*/i, '').trim() };
      }
    }

    // No clear verdict found — check for inline YES/NO pattern (e.g., "so actually: YES: ...")
    const inlineMatch = content.match(/\b(YES|NO):\s*(.+)$/im);
    if (inlineMatch) {
      return {
        fixed: inlineMatch[1].toUpperCase() === 'YES',
        explanation: inlineMatch[2].trim(),
      };
    }

    // Truly ambiguous — default to not fixed (conservative)
    debug('Verify fix: ambiguous response, no YES/NO verdict found', {
      filePath: filePath,
      responsePreview: content.substring(0, 300),
      lineCount: lines.length,
    });
    return { fixed: false, explanation: content };
  }

  /**
   * Analyze a failed fix attempt to generate an actionable lesson
   * WHY: Simple "rejected: [reason]" lessons don't help the next attempt.
   * This extracts specific guidance like "don't just X, also need to Y"
   */
  async analyzeFailedFix(
    issue: {
      comment: string;
      filePath: string;
      line: number | null;
    },
    diff: string,
    rejectionReason: string
  ): Promise<string> {
    const diffPreview = diff.length > 1500 ? `${diff.substring(0, 1500)}\n... (truncated)` : diff;
    const cleanComment = sanitizeCommentForPrompt(issue.comment);
    const prompt = `A fix attempt for a code review issue was rejected. You need to extract what was LEARNED from this failure so the next attempt makes progress instead of repeating the same mistake.
// Review: truncation preserves crucial context while managing prompt size for LLM processing.

FILE: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}
REVIEW COMMENT: ${cleanComment}

// Review: truncation indicates content length; ensures important context is retained.
ATTEMPTED FIX (diff):
${diffPreview}

WHY IT WAS REJECTED:
${rejectionReason}

Write ONE lesson learned — a specific insight from this failure that the next attempt needs to account for. Focus on WHY this approach failed and what must be different.

GOOD lessons (specific, learned from the failure):
- "cache.set() returns void not boolean — checking its return value always evaluates to falsy"
- "Test files must go in __tests__/ subdirectory, not next to route.ts — previous attempt put them in wrong location"
- "The review asks for DB transactions but services layer doesn't accept tx params — need compensating cleanup pattern instead"
- "Comment requires BOTH nonce and verify endpoints to be fixed — fixing only verify was rejected"

BAD lessons (vague, not learned from failure):
- "The diff only adds X but doesn't do Y" (just restates the rejection)
// Note: designed to omit unparsed fixes to reduce clutter in results, avoiding false positives.
- "Fix was incomplete" (no insight about why)
- "tool modified wrong files" (meta about tooling, not the problem)

Respond with ONLY the lesson text, nothing else. Keep it under 150 characters.`;

    try {
      const response = await this.complete(prompt);
      let lesson = response.content.trim();
      
      // Ensure it's not too long and is actually useful
      if (lesson.length > 200) {
        lesson = lesson.substring(0, 197) + '...';
      }
      if (lesson.length < 10) {
        return `Fix rejected: ${rejectionReason}`;
      }
      // Cycle 14 L3: Reject generic/vague lessons that add no insight (prompt lists these as BAD examples).
      // Only reject when the lesson IS the generic phrase — not when it contains useful context after it.
      if (/^(the )?fix( was| is)? incomplete\.?$/i.test(lesson) || /^no insight about why\.?$/i.test(lesson)) {
        return `Fix rejected: ${rejectionReason}`;
      }
      return lesson;
    } catch (error) {
      // If analysis fails, return basic lesson
      debug('Failed to analyze fix failure', { error });
      return `Fix rejected: ${rejectionReason}`;
    }
  }

  /** Max fixes per request to avoid 500 on large verification prompts (e.g. 26 fixes → 124k chars). */
  private static readonly MAX_VERIFY_FIXES_PER_BATCH = 6;
  /** Per-fix truncation so batches stay under gateway limits. WHY 8k/1500: Audit showed 2k code + 800 comment
   * caused false negatives (verifier couldn't see relevant section); larger limits match anchored snippet size. */
  private static readonly MAX_VERIFY_CURRENT_CODE_CHARS = 8000;
  private static readonly MAX_VERIFY_DIFF_CHARS = 2500;
  private static readonly MAX_VERIFY_COMMENT_CHARS = 1500;

  async batchVerifyFixes(
    fixes: Array<{
      id: string;
      comment: string;
      filePath: string;
      line?: number | null;
      diff: string;
      currentCode?: string;
    }>,
    options?: { model?: string }
  ): Promise<Map<string, { fixed: boolean; explanation: string; lesson?: string }>> {
    if (fixes.length === 0) {
      return new Map();
    }

    const results = new Map<string, { fixed: boolean; explanation: string; lesson?: string }>();
    const batchSize = LLMClient.MAX_VERIFY_FIXES_PER_BATCH;
    const batches = Array.from(
      { length: Math.ceil(fixes.length / batchSize) },
      (_, i) => fixes.slice(i * batchSize, (i + 1) * batchSize)
    );

    // WHY verifierModel/options.model: Verification accuracy drives fix-loop decisions. Audit showed false negatives
    // with a weak default model. Prefer PRR_VERIFIER_MODEL (or caller override) over default llmModel for verification.
    const MAX_VERIFY_RETRIES = 1;
    for (let b = 0; b < batches.length; b++) {
      const batchFixes = batches[b];
      const batchPrompt = this.buildBatchVerifyPrompt(batchFixes);
      debug('Batch verifying fixes', { batch: b + 1, totalBatches: batches.length, count: batchFixes.length, modelOverride: !!options?.model });
      let batchResults: Map<string, { fixed: boolean; explanation: string; lesson?: string }> | null = null;
      for (let attempt = 0; attempt <= MAX_VERIFY_RETRIES; attempt++) {
        try {
          const verifyModel = options?.model ?? this.verifierModel ?? this.model;
          const response = await this.complete(batchPrompt, undefined, { model: verifyModel });
          batchResults = this.parseBatchVerifyResponse(batchFixes, response.content);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isTransient = /500|502|504|timeout|gateway|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
          if (isTransient && attempt < MAX_VERIFY_RETRIES) {
            debug('Batch verify failed (transient), retrying', { batch: b + 1, attempt: attempt + 1, error: msg.slice(0, 80) });
            continue;
          }
          // Record failed so caller gets partial results; fix-verification treats missing as failed anyway
          batchResults = new Map();
          for (const f of batchFixes) {
            batchResults.set(f.id, {
              fixed: false,
              explanation: `Verification request failed: ${msg.slice(0, 120)}`,
            });
          }
          debug('Batch verify failed after retries, marking batch as failed', { batch: b + 1, count: batchFixes.length });
          break;
        }
      }
      if (batchResults) {
        for (const [id, value] of batchResults) {
          results.set(id, value);
        }
      }
    }
    return results;
  }

  /**
   * Extract the "before" (removed) side of a unified diff so the verifier can compare before vs after.
   * WHY: Verifier was only seeing "Current Code (AFTER)"; with before snippet it can judge whether
   * the issue was actually fixed instead of pattern-matching on current code alone (audit: one
   * correct fix took 17 iterations because the verifier rejected it without before context).
   */
  /** Min removed-line length below which we add context lines so verifier has enough to judge (audit: "Code before fix" was just `/**`). */
  private static readonly MIN_BEFORE_SNIPPET_LINES = 3;
  private static readonly MIN_BEFORE_SNIPPET_CHARS = 150;

  private static extractBeforeFromUnifiedDiff(diff: string, maxChars: number): string | undefined {
    const lines = diff.split('\n');
    const removed: string[] = [];
    let firstRemovedIdx = -1;
    let lastRemovedIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line!.startsWith('-')) {
        if (
          line!.startsWith('--- a/') ||
          line!.startsWith('--- b/') ||
          line!.startsWith('--- /dev/null')
        ) {
          continue;
        }
        if (firstRemovedIdx < 0) firstRemovedIdx = i;
        lastRemovedIdx = i;
        removed.push(line!.slice(1));
      }
    }
    if (removed.length === 0) return undefined;
    let joined = removed.join('\n');
    const needExpand =
      removed.length < LLMClient.MIN_BEFORE_SNIPPET_LINES ||
      joined.length < LLMClient.MIN_BEFORE_SNIPPET_CHARS;
    if (needExpand && firstRemovedIdx >= 0 && lastRemovedIdx >= 0) {
      const contextBefore: string[] = [];
      for (let j = firstRemovedIdx - 1; j >= 0 && lines[j]!.startsWith(' '); j--) {
        contextBefore.unshift(lines[j]!.slice(1));
      }
      const contextAfter: string[] = [];
      for (let j = lastRemovedIdx + 1; j < lines.length && lines[j]!.startsWith(' '); j++) {
        contextAfter.push(lines[j]!.slice(1));
      }
      const extra = [
        ...contextBefore.slice(-5),
        ...removed,
        ...contextAfter.slice(0, 5),
      ].join('\n');
      if (extra.length <= maxChars) joined = extra;
    }
    return joined.length > maxChars ? joined.substring(0, maxChars) + '\n... (truncated)' : joined;
  }

  private buildBatchVerifyPrompt(
    fixes: Array<{
      id: string;
      comment: string;
      filePath: string;
      line?: number | null;
      diff: string;
      currentCode?: string;
    }>
  ): string {
    // Build batch prompt — verification + failure analysis in a single LLM call.
    const parts: string[] = [
      'You are a STRICT code reviewer. For each fix below, verify whether the code change adequately addresses the review comment.',
      'IMPORTANT: Compare "Code before fix" with "Current Code (AFTER)". If the problematic pattern described in the review comment is still present in the current code, the fix is NOT adequate — answer NO regardless of what the diff shows.',
      'Evaluate whether the UNDERLYING CONCERN is addressed, not whether the exact suggested code from the review was applied. If the code was restructured (e.g. different loop pattern) but the concern (e.g. correct rank, no duplicate numbers) is satisfied, answer YES and cite the relevant code.',
      'CRITICAL: Base your verdict on the ACTUAL CODE shown in "Current Code (AFTER)", not on the review comment\'s description of what the code looked like. If the review describes a bug pattern (e.g. "rank += 1 inside enumerate") but that pattern does not exist in the current code, the bug was fixed — answer YES.',
      'If multiple fixes apply to the same file, "Code before fix" may show removed lines from any part of that file. Judge whether the REVIEW COMMENT\'s specific concern is addressed in Current Code (or in the diff), not whether the "Code before fix" snippet matches the comment.',
      'If "Code before fix" is empty or shows only formatting/line-number artifacts (e.g. backticks and "N | " lines), base your verdict on Current Code and the diff only.',
      'If the concern is fully addressed in another file or by a different function (e.g. this code now delegates to a function that implements the fix), answer YES and cite where the fix is implemented.',
      'For lifecycle/cache/leak issues (Map/Set/cache cleanup, pruning, TTL, stale entries), answer YES only if the code shown demonstrates safe cleanup across the relevant creation/replacement/cleanup paths. A declaration-only tweak is not enough if stale entries can still survive on early returns or thrown errors.',
      '',
      'For "duplicate" / "extract to shared utility" issues: The fix is usually to remove the duplicate from THIS file and import from the shared module (often lib/utils/...). The review may mention another file as where the duplicate already exists — that is a reference only; the canonical shared source is typically a dedicated util (e.g. lib/utils/db-errors.ts), not that reference file. In LESSON lines, do not suggest "use from [reference file]" as the shared source when a lib/utils/... module is the intended canonical location.',
      '',
      'For EACH fix, respond with EXACTLY this format:',
      'FIX_ID: YES|NO: brief explanation of what was/wasn\'t fixed',
      'LESSON: <actionable guidance> (REQUIRED for every NO only — do not include LESSON for YES)',
      '',
      'When you answer NO, your explanation is used as the source of truth for the next fix attempt. Be specific: cite the exact code, method name, or line that is still wrong or missing.',
      '',
      'The LESSON line is critical for NO responses. Focus on WHY this approach failed and what must be different next time. Do not include a LESSON line for YES responses.',
      '',
      'GOOD lessons: specific, learned from the failure. BAD lessons: vague, just restating the rejection.',
      '',
      'Example: 1: YES: The null check on line 45 matches what the comment requested',
      '2: NO: Added try/catch but the comment asks for input validation before the call',
      'LESSON: Review asks for pre-call validation (line 32), not post-call error handling',
      '',
      '---',
      '',
    ];

    const maxCode = LLMClient.MAX_VERIFY_CURRENT_CODE_CHARS;
    const maxDiff = LLMClient.MAX_VERIFY_DIFF_CHARS;
    const maxComment = LLMClient.MAX_VERIFY_COMMENT_CHARS;
    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i];
      const idx = i + 1;
      // WHY rawCurrent/currentCode: getCurrentCodeAtLine can return undefined (no workdir) or empty string in edge
      // cases. Emitting an empty ``` block gives the verifier no context and forces guessing. We treat empty/whitespace
      // as missing and emit "Current Code: (unavailable — verify from diff only)" so the model knows to rely on diff.
      const rawCurrent = fix.currentCode?.trim();
      const currentCode = rawCurrent && rawCurrent.length > 0
        ? (rawCurrent.length > maxCode ? rawCurrent.substring(0, maxCode) + '\n... (truncated — snippet was cut for prompt size)' : rawCurrent)
        : undefined;
      const diff =
        fix.diff.length > maxDiff ? fix.diff.substring(0, maxDiff) + '\n... (truncated)' : fix.diff;
      const rawComment = sanitizeCommentForPrompt(fix.comment);
      const comment = rawComment.length > maxComment ? rawComment.substring(0, maxComment) + '...' : rawComment;
      parts.push(`## Fix ${idx}`);
      parts.push(`File: ${fix.filePath}${fix.line ? `:${fix.line}` : ''}`);
      parts.push(`Review Comment: ${comment}`);
      parts.push('');
      const beforeSnippet = fix.diff
        ? LLMClient.extractBeforeFromUnifiedDiff(fix.diff, maxCode)
        : undefined;
      // WHY before section: Verifier can compare before vs after and answer "was the problematic pattern removed?" instead of guessing from current code only.
      if (beforeSnippet) {
        parts.push('Code before fix (removed lines from diff — compare with Current Code below):');
        parts.push('```');
        parts.push(beforeSnippet);
        parts.push('```');
        parts.push('');
      }
      if (currentCode) {
        parts.push('Current Code (AFTER the fix attempt — check if the issue pattern still exists here):');
        parts.push('```');
        parts.push(currentCode);
        parts.push('```');
        parts.push('');
      } else {
        parts.push('Current Code: (unavailable — verify from diff only)');
        parts.push('');
      }
      parts.push('Code Change (diff):');
      parts.push('```diff');
      parts.push(diff);
      parts.push('```');
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Now verify each fix. Use the fix number (e.g. "1: YES: ..." or "2: NO: ..."). For every NO, include a LESSON line immediately after. Do not include LESSON for YES responses.');
    return parts.join('\n');
  }

  private parseBatchVerifyResponse(
    batchFixes: Array<{ id: string }>,
    content: string
  ): Map<string, { fixed: boolean; explanation: string; lesson?: string }> {
    const indexToId = new Map<number, string>();
    for (let i = 0; i < batchFixes.length; i++) {
      indexToId.set(i + 1, batchFixes[i].id);
    }
    const results = new Map<string, { fixed: boolean; explanation: string; lesson?: string }>();

    // Parse responses - now including lessons
    // Matches: "1: YES: ...", "fix 2: NO: ...", "FIX_ID: 1: NO: ...", "FIX_ID 1: YES: ..." (no colon after FIX_ID), or "FIX_ID: 1" then "NO: ..." on next line
    const lines = content.split('\n');
    let currentOriginalId: string | null = null;

    for (const line of lines) {
      // Match "1: YES: ..." or "fix_2: NO: ..." or "FIX_ID: 1: NO: ..." or "FIX_ID 1: YES: ..." (output.log audit: model used "FIX_ID 1:" with space, no colon)
      const verifyMatch = line.match(/^(?:fix[_\s]*|FIX_ID\s*:\s*|FIX_ID\s+)?(\d+)\s*:\s*(YES|NO)\s*:\s*(.*)$/i);
      if (verifyMatch) {
        const [, numStr, yesNo, explanation] = verifyMatch;
        const idx = parseInt(numStr, 10);
        const originalId = indexToId.get(idx);
        if (originalId) {
          currentOriginalId = originalId;
          results.set(originalId, {
            fixed: yesNo.toUpperCase() === 'YES',
            explanation: explanation.trim(),
          });
        }
        continue;
      }

      // "FIX_ID: 1" or "FIX_ID 1" only (YES/NO on next line) — set currentOriginalId so next line can supply result
      const fixIdOnlyMatch = line.match(/^FIX_ID\s*[:\s]\s*(\d+)\s*$/i);
      if (fixIdOnlyMatch) {
        const idx = parseInt(fixIdOnlyMatch[1], 10);
        const originalId = indexToId.get(idx);
        if (originalId) currentOriginalId = originalId;
        continue;
      }

      // Standalone "YES: ..." or "NO: ..." after "FIX_ID: n" (two-line format from model)
      const standaloneYesNo = line.match(/^(YES|NO)\s*:\s*(.*)$/i);
      if (standaloneYesNo && currentOriginalId && !results.has(currentOriginalId)) {
        const [, yesNo, explanation] = standaloneYesNo;
        results.set(currentOriginalId, {
          fixed: yesNo!.toUpperCase() === 'YES',
          explanation: explanation!.trim(),
        });
        continue;
      }

      // Match lesson line: "LESSON: actionable guidance"
      const lessonMatch = line.match(/^LESSON:\s*(.+)$/i);
      if (lessonMatch && currentOriginalId) {
        const lesson = lessonMatch[1].trim();
        const existing = results.get(currentOriginalId);
        if (existing && !existing.fixed && lesson.length >= 10) {
          // Only attach lesson to NO responses; skip trivially short ones
          existing.lesson = lesson.length > 200 ? lesson.substring(0, 197) + '...' : lesson;
        }
      }
    }

    debug('Batch verify results', { parsed: results.size, expected: batchFixes.length });

    // When parsing falls short, log enough to diagnose and ensure every fix has an entry
    if (results.size < batchFixes.length) {
      const unparsed = batchFixes.filter(f => !results.has(f.id));
      const unparsedIds = unparsed.map(f => f.id.substring(0, 20));
      for (const f of unparsed) {
        results.set(f.id, { fixed: false, explanation: '' });
      }
      // Show the raw response lines that didn't match any pattern
      const unmatchedLines = lines
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !l.match(/^(?:fix[_\s]*|FIX_ID\s*:\s*|FIX_ID\s+)?(\d+)\s*:\s*(YES|NO)\s*:/i))
        // Review: ensures unmatched lines are filtered out for cleaner output without silent omissions
        .filter(l => !l.match(/^FIX_ID\s*[:\s]\s*\d+\s*$/i))
        .filter(l => !l.match(/^(YES|NO)\s*:/i))
        .filter(l => !l.match(/^LESSON:/i))
        .slice(0, 10);
      
      debug('Batch verify parse shortfall', {
        missing: unparsed.length,
        unparsedIds,
        sampleUnmatchedLines: unmatchedLines,
        responsePreview: content.substring(0, 500),
      });
    // Review: design choice to log unparsed issues aids debugging without altering results integrity
    }

    return results;
  }

  async resolveConflict(
    filePath: string,
    conflictedContent: string,
    baseBranch: string,
    options?: { model?: string }
  ): Promise<{ resolved: boolean; content: string; explanation: string }> {
    // Check if file is too large for reliable conflict resolution
    // WHY: Files >50KB cause token limit issues and response truncation
    const MAX_SAFE_SIZE = 50000; // 50KB
    if (conflictedContent.length > MAX_SAFE_SIZE) {
      debug('File too large for automatic conflict resolution', { 
        filePath, 
        size: conflictedContent.length,
        maxSize: MAX_SAFE_SIZE 
      });
      return {
        resolved: false,
        content: conflictedContent,
        explanation: `File too large (${Math.round(conflictedContent.length / 1024)}KB) for automatic resolution. Please resolve manually.`,
      };
    }
    const prompt = `You are resolving a Git merge conflict.

FILE: ${filePath}
MERGING: ${baseBranch} into current branch

The file contains conflict markers (<<<<<<<, =======, >>>>>>>).
Your job is to resolve the conflict intelligently by merging both sides.

CONFLICTED FILE CONTENT:
\`\`\`
${conflictedContent}
\`\`\`

INSTRUCTIONS:
1. Analyze what each side (HEAD and ${baseBranch}) is trying to accomplish
2. Merge the changes intelligently - combine both when possible, don't just pick one side
3. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)
4. Ensure the result is valid, working code
5. CRITICAL: Output the COMPLETE file - do not truncate or omit any sections
${getConflictFileTypeRules(filePath)}

Respond in this EXACT format (no other text before or after):

EXPLANATION: One to three short bullet points, under 200 characters total.

RESOLVED:
\`\`\`
<the complete resolved file content with no conflict markers>
\`\`\``;

    debug('Resolving conflict via LLM API', { filePath, contentLength: conflictedContent.length, model: options?.model });
    // Use caller-provided model when given (e.g. same as attempt 1) so fallback doesn't use weak default (qwen-3-14b) that may 504.
    const response = await this.complete(prompt, undefined, {
      model: options?.model,
      max504Retries: 0,
    });
    const content = response.content;
    
    // Parse the response with better error reporting
    const explanationMatch = content.match(/EXPLANATION:\s*(.+?)(?=\n\nRESOLVED:|$)/s);
    const resolvedMatch = content.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
    
    if (!resolvedMatch) {
      debug('Failed to parse LLM conflict resolution response', {
        responseLength: content.length,
        hasExplanation: !!explanationMatch,
        responsePreview: content.substring(0, 500),
      });
      
      // Check if response was truncated
      const seemsTruncated = !content.trim().endsWith('```') && content.length > 10000;
      const reason = seemsTruncated 
        ? 'LLM response appears truncated (file may be too large)'
        : 'LLM response did not follow expected format';
      
      return {
        resolved: false,
        content: conflictedContent,
        explanation: reason,
      };
    }

    const resolvedContent = resolvedMatch[1];
    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Resolved';

    // Verify no conflict markers remain (use line-anchored regex to avoid false positives from === in comments)
    if (hasConflictMarkers(resolvedContent)) {
      debug('LLM response still contains conflict markers');
      return {
        resolved: false,
        content: conflictedContent,
        explanation: 'Response still contains conflict markers',
      };
    }

    return {
      resolved: true,
      content: resolvedContent,
      explanation,
    };
  }

  /**
   * Generate a clean, meaningful commit message from fixed issues.
   * 
   * WHY LLM-generated: Early versions concatenated review comments verbatim,
   * producing garbage like "fix: address review comments - <details>...".
   * Commit messages are permanent history - they must describe WHAT changed.
   * 
   * WHY forbidden phrases: LLMs default to "address review comments" because
   * that's the most likely completion. We explicitly forbid these and fall back
   * to file-specific messages if detected.
   * 
   * WHY 72 char limit: Git convention. First line should fit in git log --oneline.
   * 
   * WHY truncate issues: 10 issues max, 200 chars each. Keeps prompt focused.
   */
  async generateCommitMessage(
    fixedIssues: Array<{
      filePath: string;
      comment: string;
    }>
  ): Promise<string> {
    if (fixedIssues.length === 0) {
      return 'chore: minor code improvements';
    }

    // Extract file names and key themes from issues
    const files = [...new Set(fixedIssues.map(i => i.filePath.split('/').pop()))];
    const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? ` (+${files.length - 3})` : '');

    const parts: string[] = [
      'Generate a git commit message for code changes. This is PERMANENT HISTORY.',
      '',
      'ABSOLUTE REQUIREMENTS:',
      '1. First line: type(scope): specific description (max 72 chars)',
      '2. Type: fix/feat/refactor/chore/docs',
      '3. Describe the ACTUAL CHANGE, not "review comments" or "feedback"',
      '',
      '🚫 FORBIDDEN PHRASES (never use these):',
      '- "address review comments"',
      '- "address feedback"',
      '- "fix issues"',
      '- "update code"',
      '- "apply changes"',
      '- "based on review"',
      '- "remove duplicate code" / "remove duplicate" (too generic — name the actual change)',
      '- Any mention of "review", "comments", "feedback", "requested"',
      '',
      'Read the feedback below, understand WHAT was changed (e.g. which validation, which import, which type), and describe THAT specifically.',
      '',
      `Files changed: ${fileList}`,
      '',
      '---',
      '',
    ];

    // Show feedback with emphasis on extracting the actual change
    for (const issue of fixedIssues.slice(0, 10)) { // Limit to avoid huge prompts
      const fileName = issue.filePath.split('/').pop();
      // Extract just the key issue, truncate long comments
      const cleanComment = sanitizeCommentForPrompt(issue.comment);
      const shortComment = cleanComment.length > 400
        ? cleanComment.substring(0, 400) + '...'
        : cleanComment;
      parts.push(`[${fileName}] ${shortComment}`);
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Based on the above, what SPECIFIC CODE CHANGES were made? Write the commit message:');

    // Use a cheap model — commit messages are simple text, not code-fixing
    const cheapModel = CHEAP_MODELS[this.provider];
    const response = await this.complete(parts.join('\n'), undefined, cheapModel ? { model: cheapModel } : undefined);
    let message = response.content.trim();
    
    // Remove any markdown code fences if the LLM wrapped it
    message = message.replace(/^```[\w]*\n?/g, '').replace(/\n?```$/g, '');
    message = message.trim();
    
    // Check for forbidden phrases and regenerate if found
    const forbiddenPatterns = [
      /address(ed|ing)?\s+(review\s+)?comments?/i,
      /address(ed|ing)?\s+feedback/i,
      /based on\s+(review|feedback)/i,
      /review(er)?\s+(comments?|feedback)/i,
      /requested\s+changes?/i,
      /apply\s+(the\s+)?changes/i,
      /remove\s+duplicate\s+code/i,
    ];
    
    const hasForbidden = forbiddenPatterns.some(p => p.test(message));
    
    if (hasForbidden) {
      debug('Commit message contained forbidden phrase, generating fallback', { message });
      // Use same pattern-based first line as buildCommitMessage for consistent quality
      const { buildCommitMessage } = await import('../../../shared/git/git-commit-message.js');
      const fallbackFull = buildCommitMessage(fixedIssues, []);
      const fallbackFirstLine = fallbackFull.split('\n')[0]?.trim() || 'fix: address feedback';
      return fallbackFirstLine.length <= 72 ? fallbackFirstLine : fallbackFirstLine.substring(0, 69) + '...';
    }

    // Normalize the conventional commit prefix (lowercase, proper colon)
    const prefixMatch = message.match(/^(fix|feat|chore|refactor|docs|style|test|perf)(\([^)]+\))?(?=$|[:\s])/i);
    if (prefixMatch) {
      const type = prefixMatch[1].toLowerCase();
      const scope = prefixMatch[2] ?? '';
      const rest = message.slice(prefixMatch[0].length).replace(/^[:\s]+/, '').trimStart();
      message = rest ? `${type}${scope}: ${rest}` : `${type}${scope}: update`;
    } else {
      // No valid prefix, add one
      message = `fix: ${message}`;
    }
    
    // Truncate first line if too long (72 char limit for commit messages)
    const lines = message.split('\n');
    if (lines[0].length > 72) {
      lines[0] = lines[0].substring(0, 69) + '...';
      message = lines.join('\n');
    }

    return message;
  }

  /**
   * Generate a dismissal comment for a review issue.
   * 
   * Returns ONLY the comment text (a string), never modified code.
   * The caller is responsible for inserting it programmatically.
   */
  async generateDismissalComment(params: {
    filePath: string;
    line: number;
    surroundingCode: string;   // ~15 lines with line numbers
    reviewComment: string;     // original bot comment
    dismissalReason: string;   // from DismissedIssue.reason
    category: string;          // 'already-fixed' | 'stale' | etc.
  }): Promise<{ needed: boolean; commentText?: string }> {
    // Truncate dismissalReason to avoid overly long comments
    const reason = params.dismissalReason.length > 150 
      ? params.dismissalReason.substring(0, 147) + '...'
      : params.dismissalReason;

    const prompt = `You are a developer writing a brief code comment that explains WHY the code is the way it is.

A reviewer flagged a concern about this code. The concern was dismissed. Your job: if a comment would help future readers understand the design intent, write one.

File: ${params.filePath}
Target line: ${params.line}

Surrounding code:
---
${params.surroundingCode}
---

Reviewer's concern:
"${sanitizeCommentForPrompt(params.reviewComment)}"

Why it was dismissed (${params.category}):
${reason}

TASK:
1. If there is ALREADY a comment near line ${params.line} that addresses the concern, respond: EXISTING
2. If the code is self-explanatory and no comment adds value, respond: SKIP
3. Otherwise, write a ONE-LINE comment (max 100 chars) explaining the design intent — the WHY behind the current code.

RULES:
- Write as a developer, not a review tool. Explain the design decision, not what changed in a diff.
- Do NOT narrate history ("was relocated", "was changed to", "was updated"). Describe the current state.
- Do NOT include comment syntax (// or # or /* */). Just the words.
- Do NOT use: TODO, FIXME, HACK, XXX, BUG, WARN
- Start with "Note:" prefix (avoids review-bot feedback loops; do not use "Review:")
- Max 100 characters. Be terse.
- No line numbers, commit hashes, PR references, or tool names.

Response format (exactly one line, nothing else):
- EXISTING
- SKIP
- COMMENT: Note: <your comment>

GOOD examples (explain WHY, present tense):
COMMENT: Note: uses local prompts module — the re-export was redundant
COMMENT: Note: Math.floor already handles this; trunc would be a no-op
COMMENT: Note: intentional — error boundary catches this downstream

BAD examples (narrate history, describe diffs):
COMMENT: Note: Templates were relocated and dependency is now obsolete
COMMENT: Note: This was changed from X to Y in a recent refactor
COMMENT: Note: The import path was updated to use relative imports`;

    // Use a cheap model — dismissal comments are simple text, not code-fixing
    const cheapModel = CHEAP_MODELS[this.provider];
    const response = await this.complete(prompt, undefined, cheapModel ? { model: cheapModel } : undefined);
    const content = response.content.trim();

    // Parse response
    if (/^EXISTING\b/i.test(content)) {
      debug('Dismissal comment already exists', { filePath: params.filePath, line: params.line });
      return { needed: false };
    }

    if (/^SKIP\b/i.test(content)) {
      debug('Dismissal comment not needed (self-explanatory)', { filePath: params.filePath, line: params.line });
      return { needed: false };
    }

    const commentMatch = content.match(/^COMMENT:\s*(.+)$/im);
    if (commentMatch) {
      let commentText = commentMatch[1].trim();
      // WHY Note: prefix: CodeRabbit and similar bots flag "Review:" as review artifacts and create feedback loops.
      // "Note:" reads as a neutral developer comment; we normalize so all dismissal comments use it.
      if (!/^Note:\s*/i.test(commentText)) {
        commentText = commentText ? `Note: ${commentText}` : 'Note: (see context)';
      }
      // Take only first line if LLM returned multiple
      commentText = commentText.split('\n')[0];

      // Post-filter: skip comments that only narrate what the code does.
      // WHY: Prompts.log audit showed gpt-4o-mini producing "extracts relevant metrics", "Adds section header" — they restate the code rather than explain design intent; treating obvious restatements as SKIP avoids inserting noise.
      const codeNorm = params.surroundingCode.replace(/\s+/g, ' ').toLowerCase();
      const words = commentText.replace(/^Note:\s*/i, '').split(/\s+/).filter(w => w.length >= 4);
      const matchesCode = words.filter(w => codeNorm.includes(w.toLowerCase())).length;
      if (words.length >= 2 && words.length <= 8 && matchesCode >= Math.min(2, words.length)) {
        debug('Dismissal comment too generic (mostly restates code), skipping', { filePath: params.filePath, line: params.line });
        return { needed: false };
      }

      // Enforce max length
      if (commentText.length > 100) {
        commentText = commentText.substring(0, 97) + '...';
      }

      debug('Generated dismissal comment', { 
        filePath: params.filePath, 
        line: params.line,
        length: commentText.length 
      });

      return { needed: true, commentText };
    }

    // Fallback: LLM didn't follow format — skip rather than insert a generic comment
    debug('LLM response did not match expected format, skipping', { content });
    return { needed: false };
  }
}
