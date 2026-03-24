/**
 * Per-model context limits for fix prompts (ElizaCloud and others).
 *
 * WHY ElizaCloud table: The gateway routes to many backends; each model has a different
 * context window. We store **maxContextTokens** per known model ID and derive char caps
 * conservatively. Unknown models use a safe default until someone adds an entry.
 *
 * When you hit "maximum context length" for a new ElizaCloud model, add it to
 * `ELIZACLOUD_MODEL_CONTEXT` (and optional `ELIZACLOUD_MODEL_ID_ALIASES` if the gateway
 * uses another string).
 */
import { MAX_FIX_PROMPT_CHARS } from '../constants.js';

// ─── ElizaCloud: canonical model limits (fill in as we learn) ─────────────────

export type ElizaCloudModelContextSpec = {
  /** Total context window in tokens (provider docs or API error text). */
  maxContextTokens: number;
  /**
   * Optional hard ceiling on fix-prompt chars when the derived formula is still too
   * loose (e.g. gateway timeouts on gpt-4o-mini despite 128k context).
   */
  maxFixPromptCharsCap?: number;
  /** Maintainer note only (not read at runtime). */
  notes?: string;
};

/**
 * Canonical ElizaCloud model IDs → context metadata.
 * Keys should match API model strings (e.g. `alibaba/qwen-3-14b`).
 */
export const ELIZACLOUD_MODEL_CONTEXT: Record<string, ElizaCloudModelContextSpec> = {
  'alibaba/qwen-3-14b': {
    maxContextTokens: 24_576,
    notes: 'DeepInfra Qwen3-14B; code-heavy prompts tokenize ~0.62 tok/char (2026-03).',
  },
  'openai/gpt-4o-mini': {
    maxContextTokens: 128_000,
    maxFixPromptCharsCap: 80_000,
    notes: 'M4 audit: cap avoids 174k-char prompts / gateway timeouts.',
  },
  'openai/gpt-4o': {
    maxContextTokens: 128_000,
  },
  'anthropic/claude-3.5-sonnet': {
    maxContextTokens: 200_000,
  },
  'anthropic/claude-3.7-sonnet': {
    maxContextTokens: 200_000,
  },
  'anthropic/claude-sonnet-4-5-20250929': {
    maxContextTokens: 200_000,
  },
  'anthropic/claude-opus-4-5': {
    maxContextTokens: 200_000,
  },
};

/** Exact alternate IDs that map to a canonical `ELIZACLOUD_MODEL_CONTEXT` key. */
export const ELIZACLOUD_MODEL_ID_ALIASES: Record<string, string> = {
  'Qwen/Qwen3-14B': 'alibaba/qwen-3-14b',
};

/**
 * When the API model string is not an exact key, match here → canonical key.
 * WHY: Gateways may resolve to provider-specific slugs; we still want one spec row.
 */
const ELIZACLOUD_MODEL_PATTERN_ALIASES: Array<{
  canonical: string;
  test: (modelLower: string) => boolean;
}> = [
  {
    canonical: 'alibaba/qwen-3-14b',
    test: (m) =>
      m.includes('qwen-3-14b') || m.includes('qwen3-14b') || m.includes('qwen/qwen3-14b'),
  },
];

/** Until a model is listed above, assume this context (conservative for small gateways). */
const ELIZACLOUD_UNKNOWN_MODEL_SPEC: ElizaCloudModelContextSpec = {
  maxContextTokens: 32_768,
  notes: 'Default for unknown ElizaCloud models — add to ELIZACLOUD_MODEL_CONTEXT when known.',
};

const modelMaxCharsOverride = new Map<string, number>();

/** Resolve ElizaCloud API model string to a canonical key present in `ELIZACLOUD_MODEL_CONTEXT`, or null. */
export function resolveElizaCloudCanonicalModelId(model: string): string | null {
  if (ELIZACLOUD_MODEL_CONTEXT[model]) return model;
  const viaAlias = ELIZACLOUD_MODEL_ID_ALIASES[model];
  if (viaAlias && ELIZACLOUD_MODEL_CONTEXT[viaAlias]) return viaAlias;
  const lower = model.toLowerCase();
  for (const { canonical, test } of ELIZACLOUD_MODEL_PATTERN_ALIASES) {
    if (test(lower) && ELIZACLOUD_MODEL_CONTEXT[canonical]) return canonical;
  }
  return null;
}

/**
 * Spec used for budgeting (known model or unknown default).
 * Export for logging / tests.
 */
export function getElizaCloudModelContextSpec(model: string): ElizaCloudModelContextSpec {
  const key = resolveElizaCloudCanonicalModelId(model);
  if (key) return ELIZACLOUD_MODEL_CONTEXT[key]!;
  return ELIZACLOUD_UNKNOWN_MODEL_SPEC;
}

/**
 * Derive max fix-prompt characters from context tokens.
 * Small windows (≤32k): assume dense code tokenization (~0.62 tok/char) and large completion reserve.
 * Large windows: match legacy (input 80% of context × 4 chars/token).
 */
export function deriveMaxFixPromptCharsFromContext(spec: ElizaCloudModelContextSpec): number {
  const { maxContextTokens, maxFixPromptCharsCap } = spec;
  const isSmall = maxContextTokens <= 32_000;
  const completionReserve = isSmall ? 0.28 : 0.2;
  const inputTokenBudget = Math.floor(maxContextTokens * (1 - completionReserve));
  const assumedCharsPerToken = isSmall ? 1.6 : 4;
  const derived = Math.floor(inputTokenBudget * assumedCharsPerToken);
  const capped =
    maxFixPromptCharsCap != null ? Math.min(derived, maxFixPromptCharsCap) : derived;
  return capped;
}

function isOpenAiGpt4oMiniModel(model: string): boolean {
  return model?.toLowerCase().includes('gpt-4o-mini') ?? false;
}

/**
 * Get max fix prompt chars (before file injection) for a provider/model.
 */
export function getMaxFixPromptCharsForModel(
  provider: 'elizacloud' | 'anthropic' | 'openai',
  model: string
): number {
  if ((provider === 'openai' || provider === 'elizacloud') && model && isOpenAiGpt4oMiniModel(model)) {
    const override = modelMaxCharsOverride.get(model);
    if (override !== undefined) return override;
    const spec = ELIZACLOUD_MODEL_CONTEXT['openai/gpt-4o-mini'];
    if (spec) return deriveMaxFixPromptCharsFromContext(spec);
    return 80_000;
  }

  if (provider === 'elizacloud' && model) {
    const override = modelMaxCharsOverride.get(model);
    if (override !== undefined) return override;
    const spec = getElizaCloudModelContextSpec(model);
    return deriveMaxFixPromptCharsFromContext(spec);
  }

  return MAX_FIX_PROMPT_CHARS;
}

/**
 * Lower the effective cap for this model after a 504 / timeout / context overflow.
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
