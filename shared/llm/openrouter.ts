/**
 * OpenRouter OpenAI-compatible client (Bearer + optional attribution headers).
 * WHY first-class provider: **`PRR_LLM_PROVIDER=openrouter`** + **`OPENROUTER_API_KEY`** avoids pretending the
 * key is **`OPENAI_API_KEY`** while pointing **`OPENAI_BASE_URL`** at OpenRouter — same HTTP surface, less
 * operator confusion and better **`llm-api`** / rotation discovery.
 * WHY optional headers: OpenRouter documents **`HTTP-Referer`** / **`X-Title`** for attribution/rankings; they
 * are optional envs so CI and headless runs stay minimal.
 * Env: **`OPENROUTER_API_KEY`**, optional **`OPENROUTER_BASE_URL`**, **`OPENROUTER_HTTP_REFERER`**, **`OPENROUTER_APP_TITLE`**.
 */
import type { Fetch } from 'openai/core';
import OpenAI from 'openai';
import { OPENROUTER_API_BASE_URL } from '../constants.js';

/** Create an OpenAI SDK client pointed at OpenRouter’s `/v1`. */
export function createOpenRouterOpenAIClient(apiKey: string): OpenAI {
  const key = apiKey.trim();
  const base =
    (process.env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_API_BASE_URL).replace(/\/$/, '') ||
    OPENROUTER_API_BASE_URL.replace(/\/$/, '');
  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
  const title = process.env.OPENROUTER_APP_TITLE?.trim();
  const defaultHeaders: Record<string, string> = {};
  if (referer) defaultHeaders['HTTP-Referer'] = referer;
  if (title) defaultHeaders['X-Title'] = title;
  return new OpenAI({
    apiKey: key,
    baseURL: base,
    defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    fetch: fetch as unknown as Fetch,
  });
}
