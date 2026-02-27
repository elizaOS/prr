/**
 * Per-model context limits for fix prompts (ElizaCloud and others).
 *
 * WHY: Gateways route to backends with different context caps (e.g. 40k for Qwen,
 * 200k for Claude). Sending a 200k-char prompt to a 40k-token model causes 400/504.
 * We cap prompt size per model and lower the cap on timeout so the next attempt
 * uses a smaller batch.
 */

import { MAX_FIX_PROMPT_CHARS } from '../constants.js';

/** ~4 chars per token; leave headroom for completion. */
const CHARS_PER_TOKEN = 4;

/**
 * ElizaCloud model ID -> max input context tokens (from provider/observed errors).
 * When a model times out or returns 400 "context length", add or lower its entry.
 */
const ELIZACLOUD_MODEL_MAX_INPUT_TOKENS: Record<string, number> = {
  // 40k total context; ~16k reserved for completion → ~24k input budget
  'alibaba/qwen-3-14b': 24_000,
  'Qwen/Qwen3-14B': 24_000,
  // Add other small-context models as we hit limits
  'openai/gpt-4o-mini': 128_000,
  'openai/gpt-4o': 128_000,
  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.7-sonnet': 200_000,
  'anthropic/claude-sonnet-4-5-20250929': 200_000,
  'anthropic/claude-opus-4-5': 200_000,
};

/** Session override: after a 504/timeout we set a lower cap for that model (chars). */
const modelMaxCharsOverride = new Map<string, number>();

/**
 * Get max fix prompt chars (before file injection) for a provider/model.
 * For ElizaCloud uses per-model table and optional session override (lowered on timeout).
 */
export function getMaxFixPromptCharsForModel(
  provider: 'elizacloud' | 'anthropic' | 'openai',
  model: string
): number {
  if (provider === 'elizacloud' && model) {
    const override = modelMaxCharsOverride.get(model);
    if (override !== undefined) return override;
    const tokens = ELIZACLOUD_MODEL_MAX_INPUT_TOKENS[model];
    if (tokens !== undefined) {
      // Leave ~20% for completion and safety
      return Math.floor((tokens * 0.8) * CHARS_PER_TOKEN);
    }
    // Unknown ElizaCloud model: conservative default (32k tokens ≈ 128k chars)
    return 128_000;
  }
  return MAX_FIX_PROMPT_CHARS;
}

/**
 * Lower the effective cap for this model after a 504/timeout so the next
 * attempt uses a smaller prompt. Called from the runner on timeout.
 */
export function lowerModelMaxPromptChars(model: string, sentPromptChars: number): void {
  if (!model) return;
  const current = modelMaxCharsOverride.get(model);
  const suggested = Math.max(20_000, Math.floor(sentPromptChars * 0.75));
  const next = current !== undefined ? Math.min(current, suggested) : suggested;
  modelMaxCharsOverride.set(model, next);
}
