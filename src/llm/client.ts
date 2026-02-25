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
import type { Config, LLMProvider } from '../config.js';
import { debug, warn, trackTokens, debugPrompt, debugResponse } from '../logger.js';
import { ELIZACLOUD_API_BASE_URL, ELIZACLOUD_MAX_CONCURRENT_REQUESTS, ELIZACLOUD_MIN_DELAY_MS } from '../constants.js';
import { sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';

/** Safe description of an API key for debug/error messages (never log the full key). */
function maskApiKey(key: string | undefined): string {
  if (key === undefined || key === null) return 'not set';
  const k = key.trim();
  if (!k.length) return 'empty after trim';
  const prefix = k.length <= 8 ? k.slice(0, 2) + '***' : k.slice(0, 6) + '...';
  return `length=${k.length}, prefix=${prefix}`;
}

/** Eliza Cloud production accepts X-API-Key for chat/models, not Bearer. Exported for runners. */
export function createElizaCloudOpenAIClient(apiKey: string): OpenAI {
  const key = apiKey.trim();
  const elizaFetch: (url: unknown, init?: unknown) => Promise<Response> = (input, init) => {
    const opts = init as Record<string, unknown> | undefined;
    const headers = new Headers((opts?.headers ?? {}) as Record<string, string>);
    headers.delete('Authorization');
    headers.set('X-API-Key', key);
    return fetch(input as URL | Request, { ...opts, headers } as RequestInit);
  };
  return new OpenAI({
    apiKey: key,
    baseURL: ELIZACLOUD_API_BASE_URL,
    fetch: elizaFetch as unknown as Fetch,
  });
}

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
      
      const response = await fetch(url.toString(), {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      
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
 * Concurrency limiter for ElizaCloud API.
 * WHY: ElizaCloud returns 429 when too many requests are in flight (e.g. 24
 * parallel LLM dedup calls). We cap in-flight requests and space out starts.
 */
let elizacloudInFlight = 0;
let elizacloudLastStartTime = 0;
const elizacloudQueue: Array<() => void> = [];

/** Acquire ElizaCloud rate-limit slot (exported for llm-api runner). */
export async function acquireElizacloud(): Promise<void> {
  if (elizacloudInFlight < ELIZACLOUD_MAX_CONCURRENT_REQUESTS) {
    elizacloudInFlight++;
    const now = Date.now();
    const sinceLast = now - elizacloudLastStartTime;
    if (sinceLast < ELIZACLOUD_MIN_DELAY_MS) {
      await new Promise(r => setTimeout(r, ELIZACLOUD_MIN_DELAY_MS - sinceLast));
    }
    elizacloudLastStartTime = Date.now();
    return;
  }
  await new Promise<void>(resolve => {
    elizacloudQueue.push(() => {
      elizacloudInFlight++;
      const now = Date.now();
      const sinceLast = now - elizacloudLastStartTime;
      if (sinceLast < ELIZACLOUD_MIN_DELAY_MS) {
        setTimeout(() => {
          elizacloudLastStartTime = Date.now();
          resolve();
        }, ELIZACLOUD_MIN_DELAY_MS - sinceLast);
      } else {
        elizacloudLastStartTime = Date.now();
        resolve();
      }
    });
  });
}

/** Release ElizaCloud rate-limit slot (exported for llm-api runner). */
export function releaseElizacloud(): void {
  elizacloudInFlight--;
  const next = elizacloudQueue.shift();
  if (next) next();
}

export class LLMClient {
  private provider: LLMProvider;
  private model: string;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private thinkingBudget?: number;
  /** Masked API key hint for ElizaCloud 401 error messages (never the actual key). */
  private elizacloudKeyHint?: string;

  constructor(config: Config) {
    this.provider = config.llmProvider;
    this.model = config.llmModel;
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
      this.openai = createElizaCloudOpenAIClient(config.elizacloudApiKey!);
    } else {
      this.openai = new OpenAI({
        apiKey: config.openaiApiKey,
      });
    }
  }

  async complete(prompt: string, systemPrompt?: string, options?: { model?: string }): Promise<LLMResponse> {
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

    try {
      if (this.provider === 'elizacloud') {
        await acquireElizacloud(); // uses exported fn so same global limit as llm-api runner
      }
      const max429Retries = this.provider === 'elizacloud' ? 3 : 0;
      const max504Retries = this.provider === 'elizacloud' ? 1 : 0;
      const backoffMs = this.provider === 'elizacloud' ? [60_000, 60_000, 60_000] : [2000, 4000, 8000];
      const backoff504Ms = 10_000;
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
              const timeoutMsg = e504 instanceof Error && /timeout/i.test(e504.message);
              if (attempt504 < max504Retries && (isServerError(e504) || timeoutMsg)) {
                debug('Server error or request timeout, retrying', {
                  attempt: attempt504 + 1,
                  maxRetries: max504Retries,
                  delayMs: backoff504Ms,
                });
                await new Promise(r => setTimeout(r, backoff504Ms));
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
              debug('ElizaCloud 401', { requestURL: `${url}/chat/completions`, apiKey: keyHint });
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
          throw err;
        }
      }
      throw lastErr;
    } finally {
      if (this.provider === 'elizacloud') {
        releaseElizacloud();
      }
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

    const response = await this.anthropic.messages.create(requestOptions);

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
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });

    // WHY no max_tokens: OpenAI's max_tokens is optional — omitting it lets
    // the model use its natural context limit. Previously this was hardcoded
    // to 4096, which truncated code-fix responses mid-file (the model would
    // stop at ~3K words, missing the closing code fence, and the extraction
    // regex would fail silently). Response length is now controlled by prompt
    // instructions, not this parameter. You only pay for tokens generated.
    const response = await this.openai.chat.completions.create({
      model: chosenModel,
      messages,
    });

    const content = response.choices[0]?.message?.content || '';

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

    // Lenient parsing: check for STALE prefix variations
    const isStale = content.toUpperCase().startsWith('STALE');
    const exists = content.toUpperCase().startsWith('YES');
    const explanation = content.replace(/^(YES|NO|STALE)[:\s-]*/i, '').trim();

    return { 
      exists: !isStale && exists, 
      stale: isStale, 
      explanation 
    };
  }

  /**
   * Batch check if issues still exist, with dynamic batching for large issue sets.
   * 
   * WHY BATCHING: 100 issues × 3KB each = 300KB prompt, which exceeds model limits.
   * We split into multiple batches based on maxContextChars.
   * 
   * @param maxContextChars - Maximum characters per batch (default 150k, ~37k tokens, safe for most models)
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
    maxContextChars: number = 150_000
  ): Promise<BatchCheckResult> {
    if (issues.length === 0) {
      return { issues: new Map() };
    }

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
      '',
      'CRITICAL - Your explanations will be recorded for feedback between the issue generator and judge:',
      '- For NO (not present), you MUST cite the SPECIFIC code that resolves the issue',
      '- Your explanations help the generator learn to avoid false positives',
      '- Empty or vague explanations like "Fixed" or "Looks good" are NOT acceptable',
      '- Be specific and cite actual code/line numbers',
      '',
      'For EACH issue, respond with a line in this exact format:',
      'ISSUE_ID: YES|NO|STALE: I<1-5>: D<1-5>: cite specific code or explain',
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
    const modelRecSize = modelContext?.availableModels?.length ? 1500 : 0; // Reserve for model recommendation
    const availableForIssues = maxContextChars - headerSize - footerSize - modelRecSize;

    // Build issue text for sizing
    const buildIssueText = (issue: typeof issues[0]): string => {
      // Sanitize HTML noise (base64 JWT links, metadata comments, <picture> tags)
      // THEN truncate. Without sanitizing first, a 600-char JWT blob can consume
      // 30% of the truncation budget, leaving too little actual description.
      const maxCommentLen = 2000;
      const maxCodeLen = 2000;
      const cleanComment = sanitizeCommentForPrompt(issue.comment);
      const truncatedComment = cleanComment.length > maxCommentLen
        ? cleanComment.substring(0, maxCommentLen) + '...'
        : cleanComment;
      const truncatedCode = issue.codeSnippet.length > maxCodeLen
        ? issue.codeSnippet.substring(0, maxCodeLen) + '\n... (truncated)'
        : issue.codeSnippet;

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
        truncatedCode,
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
    // WHY smaller for ElizaCloud: Gateways often time out (504) on large requests.
    // 25 issues per batch keeps each request under typical gateway limits.
    const MAX_ISSUES_PER_BATCH = this.provider === 'elizacloud' ? 25 : 50;
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
      maxContextChars,
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

      // Only ask for model recommendation in first batch
      if (isFirstBatch && modelContext?.availableModels?.length) {
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
        
        if (modelContext.modelHistory) {
          parts.push('## Model Performance on This Codebase');
          parts.push(modelContext.modelHistory);
          parts.push('');
        }
        
        if (modelContext.attemptHistory) {
          parts.push('## Previous Attempts on These Issues');
          parts.push(modelContext.attemptHistory);
          parts.push('');
        }
        
        parts.push('End your response with this line:');
        parts.push('MODEL_RECOMMENDATION: model1, model2, model3 | brief reasoning');
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
          allResults.set(resultId, {
            exists: responseUpper === 'YES',
            stale: responseUpper === 'STALE',
            explanation: rest.trim(),
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

      // Parse model recommendation only from first batch
      if (isFirstBatch && modelContext?.availableModels?.length) {
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
      ? issue.codeSnippet.substring(0, maxCodeLen) + '\n... (truncated)'
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

FILE: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}
REVIEW COMMENT: ${cleanComment}

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
- "Fix was incomplete" (no insight about why)
- "tool modified wrong files" (meta about tooling, not the problem)

Respond with ONLY the lesson text, nothing else. Keep it under 150 characters.`;

    try {
      const response = await this.complete(prompt);
      const lesson = response.content.trim();
      
      // Ensure it's not too long and is actually useful
      if (lesson.length > 200) {
        return lesson.substring(0, 197) + '...';
      }
      if (lesson.length < 10) {
        // Too short, fall back to basic lesson
        return `Fix rejected: ${rejectionReason}`;
      }
      
      return lesson;
    } catch (error) {
      // If analysis fails, return basic lesson
      debug('Failed to analyze fix failure', { error });
      return `Fix rejected: ${rejectionReason}`;
    }
  }

  async batchVerifyFixes(
    fixes: Array<{
      id: string;
      comment: string;
      filePath: string;
      line?: number | null;
      diff: string;
      currentCode?: string;
    }>
  ): Promise<Map<string, { fixed: boolean; explanation: string; lesson?: string }>> {
    if (fixes.length === 0) {
      return new Map();
    }

    // Build batch prompt — verification + failure analysis in a single LLM call.
    //
    // WHY combined: Previously, batch verify returned YES/NO and then fix-verification.ts
    // called analyzeFailedFix() individually for each NO — turning 1 batch call into 1+N
    // calls (e.g., 12 fixes with 6 failures = 7 LLM calls). Now the LLM does both jobs
    // in one pass: verify AND produce an actionable lesson for each failure.
    //
    // The lesson prompt here matches the quality of the standalone analyzeFailedFix:
    // - Explains what the diff attempted vs what the comment actually asked for
    // - Provides 4 good + 3 bad examples to calibrate quality
    // - Explicitly tells the LLM the lesson feeds back into the next fix attempt
    const parts: string[] = [
      'You are a STRICT code reviewer. For each fix below, verify whether the code change adequately addresses the review comment.',
      'IMPORTANT: When a "Current Code" section is provided, CHECK IT CAREFULLY. If the problematic pattern described in the review comment is still present in the current code, the fix is NOT adequate — answer NO regardless of what the diff shows.',
      '',
      'For EACH fix, respond with EXACTLY this format:',
      'FIX_ID: YES|NO: brief explanation of what was/wasn\'t fixed',
      'LESSON: <actionable guidance> (REQUIRED for every NO — this feeds into the next fix attempt)',
      '',
      'When you answer NO, your explanation is used as the source of truth for the next fix attempt. Be specific: cite the exact code, method name, or line that is still wrong or missing (e.g. "getHistoricalPrices method not found in Current Code", "start() does not validate JUPITER_API_KEY before marking running"). Vague NOs (e.g. "fix incomplete") do not help the fixer.',
      '',
      'The LESSON line is critical for NO responses. It captures what was LEARNED from this failure so the next attempt makes progress instead of repeating the same mistake. Focus on WHY this approach failed and what must be different next time.',
      '',
      'GOOD lessons (specific, learned from the failure):',
      '- "cache.set() returns void not boolean — checking return value always falsy"',
      '- "Test files must go in __tests__/ subdirectory — placing next to route.ts was rejected"',
      '- "Review requires BOTH endpoints fixed — fixing only verify was insufficient"',
      '- "Services layer has no tx param — need compensating cleanup, not DB transactions"',
      '',
      'BAD lessons (vague, just restating the rejection):',
      '- "The diff only adds X but doesn\'t do Y" (restates rejection, no insight)',
      '- "Fix was incomplete" (obvious, not useful)',
      '- "The code change does not address the issue" (zero information)',
      '',
      'Example responses:',
      '',
      '1: YES: The null check on line 45 matches what the comment requested',
      '',
      '2: NO: Added try/catch but the comment asks for input validation before the call, not error handling after',
      'LESSON: Review asks for pre-call validation (line 32), not post-call error handling — need input check before the API call',
      '',
      '---',
      '',
    ];

    // Use simple 1-indexed numeric IDs in the prompt instead of actual comment IDs.
    // WHY: Comment IDs are complex GraphQL node IDs (e.g. "PRR_kwDONqB7Uc5y6UGs")
    // that the LLM often garbles when echoing back, causing parse failures (e.g. 34/38 parsed).
    // Simple "1", "2", "3" are trivial to echo correctly.
    const indexToId = new Map<number, string>();
    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i];
      const idx = i + 1;
      indexToId.set(idx, fix.id);
      parts.push(`## Fix ${idx}`);
      parts.push(`File: ${fix.filePath}${fix.line ? `:${fix.line}` : ''}`);
      parts.push(`Review Comment: ${sanitizeCommentForPrompt(fix.comment)}`);
      parts.push('');
      if (fix.currentCode) {
        parts.push('Current Code (AFTER the fix attempt — check if the issue pattern still exists here):');
        parts.push('```');
        parts.push(fix.currentCode);
        parts.push('```');
        parts.push('');
      }
      parts.push('Code Change (diff):');
      parts.push('```diff');
      parts.push(fix.diff);
      parts.push('```');
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Now verify each fix. Use the fix number (e.g. "1: YES: ..." or "2: NO: ..."). For every NO, include a LESSON line immediately after:');

    debug('Batch verifying fixes', { count: fixes.length });
    const response = await this.complete(parts.join('\n'));
    const results = new Map<string, { fixed: boolean; explanation: string; lesson?: string }>();

    // Parse responses - now including lessons
    // Matches: "1: YES: ...", "fix 2: NO: ...", "FIX_ID: 1: NO: ...", or "FIX_ID: 1" then "NO: ..." on next line
    const lines = response.content.split('\n');
    let currentOriginalId: string | null = null;

    for (const line of lines) {
      // Match "1: YES: ..." or "fix_2: NO: ..." or "FIX_ID: 1: NO: ..." (model sometimes echoes FIX_ID from prompt)
      const verifyMatch = line.match(/^(?:fix[_\s]*|FIX_ID\s*:\s*)?(\d+)\s*:\s*(YES|NO)\s*:\s*(.*)$/i);
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

      // "FIX_ID: 1" only (YES/NO on next line) — set currentOriginalId so next line can supply result
      const fixIdOnlyMatch = line.match(/^FIX_ID\s*:\s*(\d+)\s*$/i);
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

    debug('Batch verify results', { parsed: results.size, expected: fixes.length });

    // When parsing falls short, log enough to diagnose and ensure every fix has an entry
    if (results.size < fixes.length) {
      const unparsed = fixes.filter(f => !results.has(f.id));
      const unparsedIds = unparsed.map(f => f.id.substring(0, 20));
      for (const f of unparsed) {
        results.set(f.id, { fixed: false, explanation: '' });
      }
      // Show the raw response lines that didn't match any pattern
      const unmatchedLines = lines
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !l.match(/^(?:fix[_\s]*|FIX_ID\s*:\s*)?(\d+)\s*:\s*(YES|NO)\s*:/i))
        // Review: ensures unmatched lines are filtered out for cleaner output without silent omissions
        .filter(l => !l.match(/^FIX_ID\s*:\s*\d+\s*$/i))
        .filter(l => !l.match(/^(YES|NO)\s*:/i))
        .filter(l => !l.match(/^LESSON:/i))
        .slice(0, 10);
      
      debug('Batch verify parse shortfall', {
        missing: unparsed.length,
        unparsedIds,
        sampleUnmatchedLines: unmatchedLines,
        responsePreview: response.content.substring(0, 500),
      });
    }

    return results;
  }

  async resolveConflict(
    filePath: string,
    conflictedContent: string,
    baseBranch: string
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

Respond in this EXACT format (no other text before or after):

EXPLANATION: <brief explanation of how you merged the changes>

RESOLVED:
\`\`\`
<the complete resolved file content with no conflict markers>
\`\`\``;

    debug('Resolving conflict via LLM API', { filePath, contentLength: conflictedContent.length });
    
    const response = await this.complete(prompt);
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

    // Verify no conflict markers remain
    const hasConflictMarkers = resolvedContent.includes('<<<<<<<') || 
                               resolvedContent.includes('=======') || 
                               resolvedContent.includes('>>>>>>>');

    if (hasConflictMarkers) {
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
      '- Any mention of "review", "comments", "feedback", "requested"',
      '',
      'Read the feedback below, understand WHAT was changed, and describe THAT.',
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
    ];
    
    const hasForbidden = forbiddenPatterns.some(p => p.test(message));
    
    if (hasForbidden) {
      debug('Commit message contained forbidden phrase, generating fallback', { message });
      // Generate a simple but specific message from file names
      const mainFile = files[0]?.replace(/\.[^.]+$/, '') || 'code';
      return `fix(${mainFile}): improve ${mainFile} implementation`;
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
- Start with "Review:" prefix
- Max 100 characters. Be terse.
- No line numbers, commit hashes, PR references, or tool names.

Response format (exactly one line, nothing else):
- EXISTING
- SKIP
- COMMENT: Review: <your comment>

GOOD examples (explain WHY, present tense):
COMMENT: Review: uses local prompts module — the re-export was redundant
COMMENT: Review: Math.floor already handles this; trunc would be a no-op
COMMENT: Review: intentional — error boundary catches this downstream

BAD examples (narrate history, describe diffs):
COMMENT: Review: Templates were relocated and dependency is now obsolete
COMMENT: Review: This was changed from X to Y in a recent refactor
COMMENT: Review: The import path was updated to use relative imports`;

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
      // Contract: comments must start with "Review:" for consistency
      if (!/^Review:\s*/i.test(commentText)) {
        commentText = commentText ? `Review: ${commentText}` : 'Review: (see context)';
      }
      // Take only first line if LLM returned multiple
      commentText = commentText.split('\n')[0];

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
