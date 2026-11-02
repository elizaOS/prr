/**
 * Ollama OpenAI-compatible client (`/v1/chat/completions`, `models.list`).
 *
 * WHY first-class provider: **`PRR_LLM_PROVIDER=ollama`** + **`OLLAMA_BASE_URL`** avoids overloading
 * **`PRR_LLM_PROVIDER=openai`** + **`OPENAI_BASE_URL`** for local runs — clearer logs, **`max_tokens`**
 * compat via **`openAiCompatMaxOutputFields`**, and **`llm-api`** can mirror the same backend.
 *
 * Env: optional **`OLLAMA_BASE_URL`** (default localhost OpenAI bridge), **`OLLAMA_API_KEY`** (often ignored by Ollama; default **`ollama`** for the SDK).
 */
import type { Fetch } from 'openai/core';
import OpenAI from 'openai';
import { OLLAMA_OPENAI_COMPAT_BASE_URL } from '../constants.js';

/** Create an OpenAI SDK client pointed at Ollama’s OpenAI-compatible `/v1` API. */
export function createOllamaOpenAIClient(apiKey: string): OpenAI {
  const key = apiKey.trim() || 'ollama';
  const base =
    (process.env.OLLAMA_BASE_URL?.trim() || OLLAMA_OPENAI_COMPAT_BASE_URL).replace(/\/$/, '') ||
    OLLAMA_OPENAI_COMPAT_BASE_URL.replace(/\/$/, '');
  return new OpenAI({
    apiKey: key,
    baseURL: base,
    fetch: fetch as unknown as Fetch,
  });
}
