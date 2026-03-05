/**
 * Per-model context limits for fix prompts (ElizaCloud and others).
 *
 * WHY this module exists: ElizaCloud is a gateway that routes to different LLM
 * backends. Those backends have wildly different context windows. The global
 * MAX_FIX_PROMPT_CHARS is sized for Claude; using it for smaller models causes
 * 400 "maximum context length" or 504 gateway timeouts.
 */
import { MAX_FIX_PROMPT_CHARS } from '../constants.js';

/** ~4 chars per token; leave headroom for completion. */
const CHARS_PER_TOKEN = 4;

/**
 * ElizaCloud model ID -> max input context tokens (from provider/observed errors).
 */
/** M4 (output.log audit): gpt-4o-mini gets a lower prompt cap to avoid 174k-char prompts and timeouts. */
const GPT4O_MINI_MAX_PROMPT_CHARS = 80_000;

const ELIZACLOUD_MODEL_MAX_INPUT_TOKENS: Record<string, number> = {
  'alibaba/qwen-3-14b': 24_000,
  'Qwen/Qwen3-14B': 24_000,
  'openai/gpt-4o-mini': 128_000,
  'openai/gpt-4o': 128_000,
  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.7-sonnet': 200_000,
  'anthropic/claude-sonnet-4-5-20250929': 200_000,
  'anthropic/claude-opus-4-5': 200_000,
};

const modelMaxCharsOverride = new Map<string, number>();

/**
 * Get max fix prompt chars (before file injection) for a provider/model.
 */
export function getMaxFixPromptCharsForModel(
  provider: 'elizacloud' | 'anthropic' | 'openai',
  model: string
): number {
  // M4: small-context / timeout-prone models get a lower cap (openai used for ElizaCloud routing too).
  if ((provider === 'openai' || provider === 'elizacloud') && model?.toLowerCase().includes('gpt-4o-mini')) {
    const override = modelMaxCharsOverride.get(model);
    if (override !== undefined) return override;
    return GPT4O_MINI_MAX_PROMPT_CHARS;
  }
  if (provider === 'elizacloud' && model) {
    const override = modelMaxCharsOverride.get(model);
    if (override !== undefined) return override;
    const tokens = ELIZACLOUD_MODEL_MAX_INPUT_TOKENS[model];
    if (tokens !== undefined) {
      return Math.floor((tokens * 0.8) * CHARS_PER_TOKEN);
    }
    return 128_000;
  }
  return MAX_FIX_PROMPT_CHARS;
}

/**
 * Lower the effective cap for this model after a 504/timeout.
 */
export function lowerModelMaxPromptChars(
  provider: 'elizacloud' | 'anthropic' | 'openai',
  model: string,
  sentPromptChars: number
): void {
  if (!model) return;
  const currentCap = getMaxFixPromptCharsForModel(provider, model);
  const suggested = Math.max(20_000, Math.floor(sentPromptChars * 0.75));
  const next = Math.min(currentCap, suggested);
  modelMaxCharsOverride.set(model, next);
}
