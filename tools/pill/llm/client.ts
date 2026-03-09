/**
 * LLM client for audit and verify. Supports Anthropic, OpenAI, ElizaCloud.
 * ElizaCloud uses X-API-Key and OpenAI-compatible base URL.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { PillConfig } from '../types.js';
import { debugPrompt, debugResponse } from '../logger.js';

const ELIZACLOUD_API_BASE_URL = 'https://elizacloud.ai/api/v1';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** Build a short, safe summary of the request body for error messages.
 * WHY: On 500/timeout, logging full prompt would be huge and might contain PII; length + model + short preview is enough to debug. */
function roughBodySummary(prompt: string, model: string, maxPreview = 200): string {
  const len = prompt.length;
  let preview = len <= maxPreview ? prompt : prompt.slice(0, maxPreview) + '...';
  preview = preview.replace(/\s+/g, ' ').trim();
  return `length: ${len} chars, model: ${model}. Preview: ${preview}`;
}

/** Append response headers to error message; when requestContext is provided, include URL and rough POST body.
 * WHY URL + body on 500: debugging provider failures (e.g. gateway 500) without a proxy; knowing which URL and
 * what we sent (length, model, preview) makes it easier to correlate with provider logs or retry safely. */
function formatErrorWithHeaders(
  err: unknown,
  requestContext?: { url: string; method: string; bodySummary?: string }
): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const parts: string[] = [msg];
  if (requestContext) {
    parts.push(`\nRequest URL: ${requestContext.url}`);
    parts.push(`Request method: ${requestContext.method}`);
    if (requestContext.bodySummary) {
      parts.push(`Request body (rough): ${requestContext.bodySummary}`);
    }
  }
  const withHeaders = err as { headers?: { forEach?(cb: (v: string, k: string) => void): void } | Record<string, string> };
  const raw = withHeaders?.headers;
  if (raw) {
    const lines: string[] = [];
    try {
      if (typeof (raw as { forEach?: (cb: (v: string, k: string) => void) => void }).forEach === 'function') {
        (raw as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => lines.push(`${k}: ${v}`));
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) lines.push(`${k}: ${v}`);
      }
    } catch {
      // ignore
    }
    if (lines.length) parts.push('\nResponse headers:\n' + lines.join('\n'));
  }
  const out = parts.join('\n');
  return new Error(out);
}

function sanitizeForJson(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

/** ElizaCloud: OpenAI-compatible API with X-API-Key header. */
function createElizaCloudOpenAIClient(apiKey: string): OpenAI {
  const key = apiKey.trim();
  const elizaFetch = (input: string | URL | Request, init?: RequestInit) => {
    const opts = init ?? {};
    const headers = new Headers(opts.headers ?? {});
    headers.delete('Authorization');
    headers.set('X-API-Key', key);
    return fetch(input, { ...opts, headers });
  };
  return new OpenAI({
    apiKey: key,
    baseURL: ELIZACLOUD_API_BASE_URL,
    fetch: elizaFetch as any,
  });
}

export interface LLMResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export class LLMClient {
  private provider: PillConfig['llmProvider'];
  private model: string;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(config: PillConfig) {
    this.provider = config.llmProvider;
    this.model = config.auditModel;
    if (config.llmProvider === 'anthropic') {
      if (!config.anthropicApiKey) throw new Error('Anthropic API key required but not set');
      this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    } else if (config.llmProvider === 'elizacloud') {
      if (!config.elizacloudApiKey) throw new Error('ElizaCloud API key required but not set');
      this.openai = createElizaCloudOpenAIClient(config.elizacloudApiKey);
    } else if (config.llmProvider === 'openai') {
      if (!config.openaiApiKey) throw new Error('OpenAI API key required but not set');
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }

  async complete(
    prompt: string,
    systemPrompt?: string,
    options?: { model?: string }
  ): Promise<LLMResponse> {
    prompt = sanitizeForJson(prompt);
    if (systemPrompt) systemPrompt = sanitizeForJson(systemPrompt);
    const chosenModel = options?.model ?? this.model;

    const fullPrompt = systemPrompt ? `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${prompt}` : prompt;
    debugPrompt(`pill-${this.provider}`, fullPrompt, { model: chosenModel });

    const is429 = (e: unknown) => (e as { status?: number })?.status === 429;
    const is5xx = (e: unknown) => {
      const s = (e as { status?: number })?.status;
      return s && s >= 500 && s < 600;
    };

    const requestUrl =
      this.provider === 'anthropic'
        ? ANTHROPIC_MESSAGES_URL
        : this.provider === 'elizacloud'
          ? `${ELIZACLOUD_API_BASE_URL}/chat/completions`
          : OPENAI_CHAT_URL;
    const requestContext = {
      url: requestUrl,
      method: 'POST',
      bodySummary: roughBodySummary(fullPrompt, chosenModel),
    };

    const max429Retries = this.provider === 'elizacloud' ? 3 : 2;
    const backoffMs = this.provider === 'elizacloud' ? [60_000, 60_000, 60_000] : [2000, 4000, 8000];
    let lastErr: unknown;

    for (let attempt = 0; attempt <= max429Retries; attempt++) {
      try {
        let response: LLMResponse | undefined;
        for (let retry5xx = 0; retry5xx <= 1; retry5xx++) {
          try {
            response =
              this.provider === 'anthropic'
                ? await this.completeAnthropic(prompt, systemPrompt, chosenModel)
                : await this.completeOpenAI(prompt, systemPrompt, chosenModel);
            break;
          } catch (e) {
            if (retry5xx < 1 && is5xx(e)) {
              await new Promise((r) => setTimeout(r, 10_000));
              continue;
            }
            throw formatErrorWithHeaders(e, requestContext);
          }
        }
        if (!response) throw new Error('LLM request failed');

        debugResponse(`pill-${this.provider}`, response.content, {
          model: chosenModel,
          usage: response.usage,
        });
        return response;
      } catch (err) {
        lastErr = err;
        if (is429(err) && attempt < max429Retries) {
          const wait = backoffMs[attempt] ?? 8000;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw formatErrorWithHeaders(err, requestContext);
      }
    }
    throw formatErrorWithHeaders(lastErr, requestContext);
  }

  private async completeAnthropic(
    prompt: string,
    systemPrompt?: string,
    model?: string
  ): Promise<LLMResponse> {
    if (!this.anthropic) throw new Error('Anthropic client not initialized');
    const chosenModel = model ?? this.model;
    const response = await this.anthropic.messages.create({
      model: chosenModel,
      max_tokens: 16384,
      system: systemPrompt ?? 'You are a helpful assistant.',
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private async completeOpenAI(
    prompt: string,
    systemPrompt?: string,
    model?: string
  ): Promise<LLMResponse> {
    if (!this.openai) throw new Error('OpenAI client not initialized');
    const chosenModel = model ?? this.model;
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const response = await this.openai.chat.completions.create({
      model: chosenModel,
      messages,
      max_completion_tokens: 16384,
    });
    const content = response.choices[0]?.message?.content ?? '';
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
}
