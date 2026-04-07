/**
 * Low-level LLM transport: Anthropic / OpenAI-compatible completion, retries, prompts.log.
 * WHY split: `client.ts` mixed network I/O with batch analysis, verification, and conflict prompts;
 * isolating transport makes retries and provider quirks easier to review and test.
 */
import type Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import OpenAI from 'openai';
import type { LLMProvider } from '../../../shared/config.js';
import { debug, warn, trackTokens, debugPrompt, debugResponse, debugPromptError, formatNumber } from '../../../shared/logger.js';
import {
  ELIZACLOUD_API_BASE_URL,
  getElizacloudGatewayFallbackModels,
  getElizacloudServerErrorMaxRetries,
} from '../../../shared/constants.js';
import { acquireElizacloud, releaseElizacloud, notifyRateLimitHit } from '../../../shared/llm/rate-limit.js';
import { openAiChatCompletionContentToString } from '../../../shared/llm/openai-chat-content.js';
import {
  ELIZACLOUD_COMPLETION_CONTEXT_RESERVE_TOKENS,
  ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS,
  estimateElizacloudInputTokensFromCharLength,
  getElizaCloudModelContextSpec,
  getMaxElizacloudHardInputCeiling,
  getMaxElizacloudLlmCompleteInputChars,
  lowerModelMaxPromptChars,
} from '../../../shared/llm/model-context-limits.js';
import {
  elizaCloudServerErrorExpectationDebug,
  getElizaCloudErrorContext,
  isElizaCloudServerClassError,
  isLikelyContextLengthExceededError,
  maskApiKey,
  sanitizeForJson,
} from './error-helpers.js';
import type { CompleteOptions, LLMResponse } from './llm-client-types.js';

export interface LlmTransportDeps {
  provider: LLMProvider;
  model: string;
  thinkingBudget?: number;
  anthropic?: Anthropic;
  openai?: OpenAI;
  elizacloudKeyHint?: string;
  runAbortSignal: AbortSignal | null;
}

export async function completeAnthropicDep(
  deps: LlmTransportDeps,
  prompt: string, systemPrompt?: string, model?: string): Promise<LLMResponse> {
    if (!deps.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    const chosenModel = model ?? deps.model;

    // Build request options
    // max_tokens is required by the Anthropic API — we can't omit it.
    // Set it high so it's never the constraint; response length is controlled
    // via prompt instructions, not this parameter. You only pay for tokens
    // actually generated, not the budget ceiling.
    //
    // WHY 64K default: Sonnet/Haiku cap at 64K. Opus also caps at 64K unless
    // extended thinking is enabled — requesting 128K without thinking causes 400.
    const isHighOutputModel = chosenModel.includes('opus');
    const maxOutputTokens = (isHighOutputModel && deps.thinkingBudget) ? 128_000 : 64_000;

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
    if (deps.thinkingBudget && deps.thinkingBudget >= maxTokens) {
      throw new Error(`PRR_THINKING_BUDGET (${deps.thinkingBudget}) must be < max_tokens (${maxTokens})`);
    }

    // Add extended thinking if budget is set
    if (deps.thinkingBudget) {
      requestOptions.thinking = {
        type: 'enabled',
        budget_tokens: deps.thinkingBudget,
      };
      debug('Using extended thinking', { budget: deps.thinkingBudget });
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

    const requestOpts = deps.runAbortSignal ? { signal: deps.runAbortSignal } : undefined;
    const response = await deps.anthropic.messages.create(requestOptions, requestOpts);

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

export async function completeOpenAIDep(
  deps: LlmTransportDeps,
  prompt: string, systemPrompt?: string, model?: string): Promise<LLMResponse> {
    if (!deps.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const chosenModel = model ?? deps.model;

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

    // Cap completion so estimated input + max_output stays under model context.
    // WHY: Char preflight uses a separate budget; OpenAI-style APIs still validate **tokens**.
    // Qwen3-14B is 24,576 ctx — ~32k chars ≈ ~20k input tok + 8192 max out → opaque HTTP 500 (audit).
    const systemMessageChars = systemPrompt
      ? (systemPrompt + noThinkSuffix).length
      : noThinkSuffix
        ? noThinkSuffix.trim().length
        : 0;
    const totalInputChars = systemMessageChars + prompt.length;

    let maxCompletionTokens = ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS;
    if (deps.provider === 'elizacloud') {
      const spec = getElizaCloudModelContextSpec(chosenModel);
      const { approxTokens } = estimateElizacloudInputTokensFromCharLength(chosenModel, totalInputChars);
      const headroom = spec.maxContextTokens - approxTokens - ELIZACLOUD_COMPLETION_CONTEXT_RESERVE_TOKENS;
      const capped = Math.min(
        ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS,
        Math.max(256, headroom),
      );
      if (capped < ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS) {
        debug('ElizaCloud: capping max_completion_tokens for context window', {
          model: chosenModel,
          estimatedInputTokensApprox: approxTokens,
          maxContextTokens: spec.maxContextTokens,
          maxCompletionTokens: capped,
        });
      }
      maxCompletionTokens = capped;
    }

    const requestOpts = deps.runAbortSignal ? { signal: deps.runAbortSignal } : undefined;
    const response = await deps.openai.chat.completions.create(
      { model: chosenModel, messages, max_completion_tokens: maxCompletionTokens },
      requestOpts
    );

    let content = openAiChatCompletionContentToString(response.choices[0]?.message?.content);

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

export async function llmComplete(
  deps: LlmTransportDeps,
  prompt: string, systemPrompt?: string, options?: CompleteOptions): Promise<LLMResponse> {
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
    const chosenModel = options?.model ?? deps.model;

    const baseDebug: Record<string, unknown> = {
      promptLength: prompt.length,
      hasSystemPrompt: !!systemPrompt,
    };
    if (deps.provider === 'elizacloud') {
      const sysLen = systemPrompt?.length ?? 0;
      const totalChars = prompt.length + sysLen;
      const { approxTokens, assumedCharsPerToken } = estimateElizacloudInputTokensFromCharLength(
        chosenModel,
        totalChars,
      );
      const spec = getElizaCloudModelContextSpec(chosenModel);
      const worstOut = approxTokens + ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS;
      baseDebug.requestTotalChars = totalChars;
      baseDebug.estimatedInputTokensApprox = approxTokens;
      baseDebug.tokenizerAssumptionCharsPerToken = assumedCharsPerToken;
      baseDebug.maxCompletionTokensDefault = ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS;
      baseDebug.estimatedInputPlusDefaultMaxOutputApprox = worstOut;
      baseDebug.estimatedExceedsContextWithDefaultMaxOut = worstOut > spec.maxContextTokens;
    }
    debug(`LLM request to ${deps.provider}/${chosenModel}`, baseDebug);

    // ElizaCloud: fail fast when total input exceeds the model's **context-derived** hard
    // ceiling. WHY hard ceiling vs budget: `lowerModelMaxPromptChars` adaptively shrinks the
    // budget after timeouts (which may be gateway lag, not context overflow). A 40k prompt on
    // a 200k-context model should never be rejected just because a prior timeout lowered the
    // cap. Only reject when the prompt genuinely can't fit the model's context window.
    if (deps.provider === 'elizacloud') {
      const total = prompt.length + (systemPrompt?.length ?? 0);
      const hardCeiling = getMaxElizacloudHardInputCeiling(chosenModel);
      const softBudget = getMaxElizacloudLlmCompleteInputChars(chosenModel);
      if (total > hardCeiling) {
        const detail = elizaCloudServerErrorExpectationDebug(chosenModel, prompt, systemPrompt);
        debug('ElizaCloud input exceeds context-derived hard ceiling', detail);
        throw new Error(
          `ElizaCloud request too large for ${chosenModel}: ${formatNumber(total)} chars (context ceiling ${formatNumber(hardCeiling)}).`,
        );
      }
      if (total > softBudget) {
        debug(
          `ElizaCloud prompt exceeds adaptive budget (${formatNumber(total)} chars > ${formatNumber(softBudget)}) but within context ceiling (${formatNumber(hardCeiling)}); proceeding`,
        );
      }
    }

    // Log full prompt to debug file
    const fullPrompt = systemPrompt ? `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${prompt}` : prompt;
    const promptMeta: Record<string, unknown> = { model: chosenModel };
    if (options?.phase != null) promptMeta.phase = options.phase;
    const promptSlug = debugPrompt(`llm-${deps.provider}`, fullPrompt, promptMeta);
    
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
      if (deps.provider === 'elizacloud') {
        await acquireElizacloud().then(() => elizaAcquired = true); // uses exported fn so same global limit as llm-api runner
        elizaAcquired = true;
      }
      const max429Retries = deps.provider === 'elizacloud' ? 3 : 0;
      const max504Retries =
        options?.max504Retries ??
        (deps.provider === 'elizacloud' ? getElizacloudServerErrorMaxRetries() : 0);
      const backoffMs = deps.provider === 'elizacloud' ? [60_000, 60_000, 60_000] : [2000, 4000, 8000];
      const backoff504Ms = deps.provider === 'elizacloud' ? [10_000, 20_000] : [10_000];
      // ElizaCloud STRICT = 10 req/min; short backoff (2s/4s/8s) sends 4 requests in ~14s → 429. Use 60s so retries stay under limit.
      for (let attempt = 0; attempt <= max429Retries; attempt++) {
        try {
          let response: LLMResponse | undefined;
          let requestModel = chosenModel;
          let consecutiveElizacloudGatewayErrors = 0;
          let elizacloudFallbackIdx = 0;
          const elizacloudGatewayFallbackChain =
            deps.provider === 'elizacloud' ? getElizacloudGatewayFallbackModels(chosenModel) : [];

          for (let attempt504 = 0; attempt504 <= max504Retries; attempt504++) {
            try {
              response = deps.provider === 'anthropic'
                ? await completeAnthropicDep(deps, prompt, systemPrompt, chosenModel)
                : await completeOpenAIDep(deps, prompt, systemPrompt, requestModel);
              break;
            } catch (e504) {
              if (deps.provider === 'elizacloud') {
                const base504 = getElizaCloudErrorContext(e504);
                const payload504 =
                  isElizaCloudServerClassError(e504)
                    ? { ...base504, ...elizaCloudServerErrorExpectationDebug(requestModel, prompt, systemPrompt) }
                    : base504;
                debug('ElizaCloud error (response context)', payload504);
              }
              const timeoutMsg = e504 instanceof Error && /timeout/i.test(e504.message);
              const contextOverflow = isLikelyContextLengthExceededError(e504);
              const totalChars = prompt.length + (systemPrompt?.length ?? 0);
              const overHardCeiling =
                deps.provider === 'elizacloud' &&
                totalChars > getMaxElizacloudHardInputCeiling(requestModel);
              if (contextOverflow && deps.provider === 'elizacloud') {
                lowerModelMaxPromptChars('elizacloud', requestModel, prompt.length);
                debug('ElizaCloud context length exceeded — lowered prompt cap for this model', {
                  model: requestModel,
                  promptLength: formatNumber(prompt.length),
                  ...elizaCloudServerErrorExpectationDebug(requestModel, prompt, systemPrompt),
                });
              }

              const gatewayClassRetry =
                deps.provider === 'elizacloud' && (isServerError(e504) || timeoutMsg);
              if (gatewayClassRetry) {
                consecutiveElizacloudGatewayErrors++;
              } else {
                consecutiveElizacloudGatewayErrors = 0;
              }

              if (
                deps.provider === 'elizacloud' &&
                consecutiveElizacloudGatewayErrors >= 2 &&
                elizacloudFallbackIdx < elizacloudGatewayFallbackChain.length
              ) {
                const nextModel = elizacloudGatewayFallbackChain[elizacloudFallbackIdx]!;
                elizacloudFallbackIdx++;
                console.warn(
                  chalk.yellow(
                    `ElizaCloud: ${formatNumber(2)} consecutive gateway/server errors on ${requestModel} — trying fallback model ${nextModel} (override chain: PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS; disable: off).`,
                  ),
                );
                requestModel = nextModel;
                consecutiveElizacloudGatewayErrors = 0;
                attempt504--;
                continue;
              }

              if (
                attempt504 < max504Retries &&
                (isServerError(e504) || timeoutMsg) &&
                !contextOverflow &&
                !overHardCeiling
              ) {
                const delayMs = Array.isArray(backoff504Ms) ? backoff504Ms[attempt504] ?? backoff504Ms[backoff504Ms.length - 1] : backoff504Ms;
                debug('Server error or request timeout, retrying', {
                  attempt: attempt504 + 1,
                  maxRetries: max504Retries,
                  delayMs,
                  model: deps.provider === 'elizacloud' ? requestModel : chosenModel,
                  ...(deps.provider === 'elizacloud'
                    ? elizaCloudServerErrorExpectationDebug(requestModel, prompt, systemPrompt)
                    : {}),
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

          // Pill #1, #4: Ensure we pass the accumulated response content, not empty string.
          // The OpenAI/Anthropic SDKs should return full content, but add safeguard.
          const responseContent = response.content || '';
          if (!responseContent && response.usage?.outputTokens && response.usage.outputTokens > 0) {
            debug('WARNING: LLM response has usage tokens but empty content — possible streaming accumulation bug', {
              provider: deps.provider,
              model: requestModel,
              outputTokens: response.usage.outputTokens,
            });
          }

          if (response.usage) {
            trackTokens(response.usage.inputTokens, response.usage.outputTokens);
          }

          // WHY: writeToPromptLog refuses empty RESPONSE — audits would see orphan PROMPT slugs with no ERROR.
          if (!responseContent.trim()) {
            debugPromptError(
              promptSlug,
              `llm-${deps.provider}`,
              'Empty or whitespace-only response body (HTTP success but no text; prompts.log would not record a RESPONSE).',
              {
                model: requestModel,
                usage: response.usage,
                ...(options?.phase != null ? { phase: options.phase } : {}),
                emptyBody: true,
              }
            );
            // WHY: Operators and CI often skip prompts.log; one stderr line ties empty LLM output to the ERROR slug.
            console.warn(
              chalk.yellow(
                `${deps.provider}: empty response body from ${requestModel} (prompts.log has ERROR for this request).`,
              ),
            );
          } else {
            const responseMeta: Record<string, unknown> = { model: requestModel, usage: response.usage };
            if (options?.phase != null) responseMeta.phase = options.phase;
            debugResponse(promptSlug, `llm-${deps.provider}`, responseContent, responseMeta);
          }

          return response;
        } catch (err) {
          if (deps.provider === 'elizacloud') {
            const status = (err as { status?: number })?.status;
            const msg = err instanceof Error ? err.message : String(err);
            if (status === 401 || /401|Unauthorized|Authentication required/i.test(msg)) {
              const url = ELIZACLOUD_API_BASE_URL;
              const keyHint = deps.elizacloudKeyHint ?? maskApiKey(undefined);
              debug('ElizaCloud 401', { requestURL: `${url}/chat/completions`, apiKey: keyHint, ...getElizaCloudErrorContext(err) });
              debugPromptError(promptSlug, `llm-${deps.provider}`, msg, {
                model: chosenModel,
                status: 401,
                ...(options?.phase != null ? { phase: options.phase } : {}),
              });
              throw new Error(
                `ElizaCloud API key was rejected (401 Unauthorized). ` +
                `Request URL: ${url}/chat/completions. API key: ${keyHint}. ` +
                `Check that ELIZACLOUD_API_KEY in .env is correct for this URL, has no extra spaces/newlines, and has not been revoked.`
              );
            }
            if (is429(err)) {
              notifyRateLimitHit();
              if (attempt < max429Retries) {
                const wait = backoffMs[attempt] ?? 8000;
                debug(`ElizaCloud 429, retry ${attempt + 1}/${max429Retries} in ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                continue;
              }
            }
          }
          if (deps.provider === 'elizacloud') {
            const baseErr = getElizaCloudErrorContext(err);
            const payloadErr =
              isElizaCloudServerClassError(err)
                ? { ...baseErr, ...elizaCloudServerErrorExpectationDebug(chosenModel, prompt, systemPrompt) }
                : baseErr;
            debug('ElizaCloud error (response context)', payloadErr);
          }
          // WHY: Connection errors / exhausted retries throw here — without ERROR, prompts.log shows orphan PROMPT only (audit: #0022).
          const terminalMsg = err instanceof Error ? err.message : String(err);
          debugPromptError(promptSlug, `llm-${deps.provider}`, terminalMsg.slice(0, 12_000), {
            model: chosenModel,
            status: (err as { status?: number })?.status,
            is504: isServerError(err),
            isTimeout: /timeout|connection error/i.test(terminalMsg),
            ...(options?.phase != null ? { phase: options.phase } : {}),
          });
          throw err;
        }
      }
      // TypeScript: each iteration returns from `try` or throws from `catch` (429 uses `continue` inside `catch`).
      throw new Error('LLM complete: unexpected end of retry loop');
    } finally {
      if (deps.provider === 'elizacloud' && elizaAcquired) {
        releaseElizacloud();
      }
    // Review: ensures slot release only if acquisition is successful to maintain accurate in-flight count.
    }
  }
