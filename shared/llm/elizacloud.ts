/**
 * ElizaCloud OpenAI-compatible client factory.
 * Eliza Cloud uses X-API-Key header for chat/models.
 */
import type { Fetch } from 'openai/core';
import OpenAI from 'openai';
import { ELIZACLOUD_API_BASE_URL } from '../constants.js';

/** Create an OpenAI client configured for ElizaCloud (base URL + X-API-Key). Exported for runners and LLM client. */
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
