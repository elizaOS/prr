/**
 * OpenAI / Anthropic / ElizaCloud model listing and API key validation.
 * Extracted from client.ts for structure.
 */
import OpenAI from 'openai';
import { debug } from '../../../shared/logger.js';
import { ELIZACLOUD_API_BASE_URL } from '../../../shared/constants.js';
import { createElizaCloudOpenAIClient } from '../../../shared/llm/elizacloud.js';
import { getElizaCloudErrorContext, maskApiKey } from './error-helpers.js';

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

/** Return the fast/cheap model for the provider (for split-plan, dedup, etc.). WHY exported: split-plan uses it when SPLIT_PLAN_LLM_MODEL is unset to avoid 504 timeouts. */
export function getCheapModelForProvider(provider: string): string | undefined {
  return CHEAP_MODELS[provider];
}
