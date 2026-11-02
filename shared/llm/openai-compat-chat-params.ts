/**
 * OpenAI-compatible chat completion: `max_completion_tokens` vs `max_tokens`.
 *
 * WHY: Official OpenAI / ElizaCloud-style gateways often accept `max_completion_tokens`
 * (newer models require it). Many third-party OpenAI-compatible hosts (NVIDIA NIM, OpenRouter,
 * Ollama, LM Studio) still expect `max_tokens`; sending only `max_completion_tokens` can 400.
 */

export type OpenAiCompatMaxOutputStyle = 'completion_tokens' | 'max_tokens';

export function openAiCompatMaxOutputStyle(provider: string | undefined): OpenAiCompatMaxOutputStyle {
  // WHY `undefined` → completion_tokens: local/third-party compat hosts need `max_tokens`; unknown providers
  // follow the OpenAI/ElizaCloud path so new first-class ids default to the stricter API shape.
  return provider === 'nvidiacloud' ||
    provider === 'openrouter' ||
    provider === 'ollama' ||
    provider === 'lmstudio'
    ? 'max_tokens'
    : 'completion_tokens';
}

/** Spread into `chat.completions.create({ ... })` so only one max-output field is set. */
export function openAiCompatMaxOutputFields(
  maxOutput: number,
  provider: string | undefined,
): { max_tokens: number } | { max_completion_tokens: number } {
  return openAiCompatMaxOutputStyle(provider) === 'max_tokens'
    ? { max_tokens: maxOutput }
    : { max_completion_tokens: maxOutput };
}
