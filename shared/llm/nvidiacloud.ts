/**
 * NVIDIA Build / NIM OpenAI-compatible client (Bearer auth, custom base URL).
 * WHY first-class provider: Lets **`PRR_LLM_PROVIDER=nvidiacloud`** use **`NVIDIA_*`** keys and defaults without
 * overloading **`PRR_LLM_PROVIDER=openai`** + **`OPENAI_BASE_URL`** — clearer diagnostics and child-process env
 * mirroring in **`tools/prr/index.ts`**.
 * WHY Bearer + this module: Same **`chat.completions`** / **`models.list`** transport as OpenAI; distinct from
 * ElizaCloud (**`X-API-Key`**) and **`api.openai.com`** default base.
 * Env: **`NVIDIA_API_KEY`** or **`NVIDIA_CLOUD_API_KEY`**, optional **`NVIDIA_BASE_URL`** (default {@link NVIDIA_API_BASE_URL}).
 * WHY **`fetch` passed through:** Matches **`elizacloud.ts`** so Node’s **`fetch`** is explicit for testability and edge runtimes.
 */
import type { Fetch } from 'openai/core';
import OpenAI from 'openai';
import { NVIDIA_API_BASE_URL } from '../constants.js';

/** Create an OpenAI SDK client pointed at NVIDIA’s `/v1` with the user’s API key. */
export function createNvidiaCloudOpenAIClient(apiKey: string): OpenAI {
  const key = apiKey.trim();
  const base =
    (process.env.NVIDIA_BASE_URL?.trim() || NVIDIA_API_BASE_URL).replace(/\/$/, '') || NVIDIA_API_BASE_URL.replace(/\/$/, '');
  return new OpenAI({
    apiKey: key,
    baseURL: base,
    fetch: fetch as unknown as Fetch,
  });
}
