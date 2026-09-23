/**
 * LM Studio local server OpenAI-compatible client (`/v1/chat/completions`, `models.list`).
 *
 * WHY first-class provider: **`PRR_LLM_PROVIDER=lmstudio`** matches how operators think about the stack;
 * **`LMSTUDIO_BASE_URL`** defaults to LM Studio’s local server; **`PRR_LLM_MODEL`** is required (no universal
 * default id — the loaded model is user-defined in the LM Studio UI).
 *
 * Env: optional **`LMSTUDIO_BASE_URL`**, **`LMSTUDIO_API_KEY`** (placeholder for SDK; default **`lm-studio`**).
 */
import type { Fetch } from 'openai/core';
import OpenAI from 'openai';
import { LMSTUDIO_OPENAI_COMPAT_BASE_URL } from '../constants.js';

/** Create an OpenAI SDK client pointed at LM Studio’s OpenAI-compatible `/v1` API. */
export function createLmStudioOpenAIClient(apiKey: string): OpenAI {
  const key = apiKey.trim() || 'lm-studio';
  const base =
    (process.env.LMSTUDIO_BASE_URL?.trim() || LMSTUDIO_OPENAI_COMPAT_BASE_URL).replace(/\/$/, '') ||
    LMSTUDIO_OPENAI_COMPAT_BASE_URL.replace(/\/$/, '');
  return new OpenAI({
    apiKey: key,
    baseURL: base,
    fetch: fetch as unknown as Fetch,
  });
}
