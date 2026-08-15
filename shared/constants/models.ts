// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEFAULT MODELS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Default LLM model for Anthropic provider.
 *
 * WHY claude-sonnet-4-5: Best speed/intelligence combo per Anthropic docs.
 * claude-3-5-sonnet-20241022 was deprecated and returns 404.
 * See: https://platform.claude.com/docs/en/about-claude/models/overview
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Default LLM model for OpenAI provider.
 *
 * WHY gpt-4o: Optimized GPT-4 model with improved context handling.
 * Current standard for general-purpose OpenAI API usage.
 * See: https://developers.openai.com/api/docs/models
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/**
 * Default LLM model for ElizaCloud provider.
 * ElizaCloud is an OpenAI-compatible gateway that routes to multiple providers.
 * Eliza Cloud uses owner/model IDs (e.g. anthropic/claude-sonnet-4-5-20250929).
 */
export const DEFAULT_ELIZACLOUD_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

/**
 * Fallback model when DEFAULT_ELIZACLOUD_MODEL is unavailable (e.g. timeout/skip list).
 * Single source of truth for the default fallback; index.ts and rotation use this when needed.
 * WHY not claude-3.5-sonnet: that ID is in ELIZACLOUD_SKIP_MODEL_IDS (low fix rate in audits); fallback must be non-skipped.
 */
export const ELIZACLOUD_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

/**
 * ElizaCloud API base URL (OpenAI-compatible).
 */
// Note: API base URL aligns with Eliza Cloud's design for consistency in requests.
export const ELIZACLOUD_API_BASE_URL = 'https://elizacloud.ai/api/v1';

/** Skip reason per model: timeout/504 (transient possible) vs zero-fix-rate (audit). Pill #2: separate so timeout-skipped can be retried. */
export type ElizaCloudSkipReason = 'timeout' | 'zero-fix-rate';

/**
 * Model IDs to skip when using ElizaCloud, with reason. WHY: Audits showed these models
 * 500/timeout repeatedly or had 0% fix rate. Timeout-only models may be retried after cooldown
 * (transient gateway issues); zero-fix-rate are skipped for audit (pill-output #2).
 *
 * **Maintainer refresh:** When **RESULTS SUMMARY → Model Performance** shows a model at **0%** verified
 * fixes across meaningful attempts, add it here with **`ELIZACLOUD_SKIP_REASON`** **`zero-fix-rate`** and a
 * short evidence comment. **Last reviewed:** 2026-04-08 — no new static entries from recent CI conflict
 * runs (client **90s** timeouts on bulk **llm-api** are operator/config, not automatic skip-list adds).
 */
export const ELIZACLOUD_SKIP_MODEL_IDS: readonly string[] = [
  'openai/gpt-5.2-codex',
  'anthropic/claude-3-opus',
  'openai/gpt-4.1',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.1-codex-max',
  'anthropic/claude-3.7-sonnet',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  /** Pill audits: ~25% fix success vs stronger models; wastes rotation slots. Re-enable with PRR_ELIZACLOUD_INCLUDE_MODELS. */
  'anthropic/claude-3.5-sonnet',
  /**
   * Small-context (24k) + opaque gateway 500s on modest prompts; weak verifier vs shown code (AGENTS final-audit note).
   * Pill-output / eliza runs used this as default — burns rotation and mis-verifies. Re-enable: PRR_ELIZACLOUD_INCLUDE_MODELS=alibaba/qwen-3-14b
   */
  'alibaba/qwen-3-14b',
  'Qwen/Qwen3-14B',
];

/** Per-model skip reason. Default 'timeout' for models known to 504/timeout; 'zero-fix-rate' for 0% fix rate in audits. */
export const ELIZACLOUD_SKIP_REASON: Record<string, ElizaCloudSkipReason> = {
  'anthropic/claude-3.7-sonnet': 'timeout',
  'openai/gpt-4o': 'timeout',
  'openai/gpt-4o-mini': 'zero-fix-rate',
  'anthropic/claude-3.5-sonnet': 'zero-fix-rate',
  'alibaba/qwen-3-14b': 'zero-fix-rate',
  'Qwen/Qwen3-14B': 'zero-fix-rate',
};

export function getElizaCloudSkipReason(modelId: string): ElizaCloudSkipReason {
  return ELIZACLOUD_SKIP_REASON[modelId] ?? 'timeout';
}

/**
 * Effective skip list for ElizaCloud: ELIZACLOUD_SKIP_MODEL_IDS minus any model in
 * PRR_ELIZACLOUD_INCLUDE_MODELS (comma-separated). WHY: Lets operators re-enable a skipped
 * model when timeouts were transient or environment-specific (see output.log audit §9).
 */
let loggedElizacloudIncludeModels = false;

let loggedElizacloudExtraSkip = false;
let loggedElizacloudExtraSkipInvalid = false;

/** Skip-list ids must be sane strings (no `//`, bounded length) — avoids junk env breaking merges. */
function isPlausibleSkipListModelId(id: string): boolean {
  if (!id || id.length > 200 || id.includes('//')) return false;
  return /^[A-Za-z0-9._\/-]+$/.test(id);
}

export function getEffectiveElizacloudSkipModelIds(): string[] {
  const extraRaw = process.env.PRR_ELIZACLOUD_EXTRA_SKIP_MODELS?.trim();
  const extraParsed = extraRaw
    ? extraRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const extraDropped = extraParsed.filter((id) => !isPlausibleSkipListModelId(id));
  const extraIds = extraParsed.filter((id) => isPlausibleSkipListModelId(id));
  if (extraDropped.length > 0 && !loggedElizacloudExtraSkipInvalid) {
    loggedElizacloudExtraSkipInvalid = true;
    console.warn(
      `PRR_ELIZACLOUD_EXTRA_SKIP_MODELS: ignored ${extraDropped.length.toLocaleString()} malformed id(s) (empty, //, or invalid chars).`,
    );
  }
  const mergedBase = [...new Set([...ELIZACLOUD_SKIP_MODEL_IDS, ...extraIds])];
  if (extraIds.length > 0 && !loggedElizacloudExtraSkip) {
    loggedElizacloudExtraSkip = true;
    console.log(
      `PRR_ELIZACLOUD_EXTRA_SKIP_MODELS: added ${extraIds.length.toLocaleString()} extra id(s) to ElizaCloud skip list (see shared/constants.ts for built-in list).`,
    );
  }

  const raw = process.env.PRR_ELIZACLOUD_INCLUDE_MODELS?.trim();
  if (!raw) return mergedBase;
  const include = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && isPlausibleSkipListModelId(s)),
  );
  const match = (id: string) => include.has(id) || include.has(id.replace(/^(openai|anthropic|google)\//, ''));
  const filtered = mergedBase.filter(id => !match(id));
  if (!loggedElizacloudIncludeModels) {
    loggedElizacloudIncludeModels = true;
    const before = mergedBase.length;
    console.log(
      `PRR_ELIZACLOUD_INCLUDE_MODELS: skip list narrowed from ${before.toLocaleString()} to ${filtered.length.toLocaleString()} model id(s).`,
    );
  }
  return filtered;
}

/**
 * Ordered models to try when ElizaCloud returns repeated gateway/server-class errors (5xx, 502)
 * on the same model within one `LLMClient.complete()` retry loop.
 *
 * - **`PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS`:** comma-separated order; **`off`** / **`0`** / **`none`** disables.
 * - Default chain prefers fast/cheap then capable ids; entries on {@link getEffectiveElizacloudSkipModelIds} are dropped.
 */
export function getElizacloudGatewayFallbackModels(primaryModel: string): string[] {
  const raw = process.env.PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS?.trim();
  if (raw && /^(0|off|none|false)$/i.test(raw)) return [];

  const defaults = [
    'openai/gpt-4o-mini',
    'anthropic/claude-3-5-haiku-20241022',
    ELIZACLOUD_FALLBACK_MODEL,
    'openai/gpt-4o',
  ];
  const candidates = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : defaults;

  const skip = new Set(getEffectiveElizacloudSkipModelIds().map((s) => s.toLowerCase()));
  const primaryLower = primaryModel.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of candidates) {
    const ml = m.toLowerCase();
    if (ml === primaryLower) continue;
    if (skip.has(ml)) continue;
    if (seen.has(ml)) continue;
    seen.add(ml);
    out.push(m);
  }
  return out;
}

/**
 * Max concurrent requests to ElizaCloud API (legacy; use getEffectiveMaxConcurrentLLM()).
 * WHY: ElizaCloud returns 429 when too many in flight. 1 = one request at a time.
 */
export const ELIZACLOUD_MAX_CONCURRENT_REQUESTS = 1;

/**
 * Min ms between starting successive ElizaCloud requests (per slot).
 * WHY: 6s spacing keeps request rate under ElizaCloud limit of 10 req/min; avoids 429 bursts.
 * Overridable via PRR_LLM_MIN_DELAY_MS; use getEffectiveMinDelayMs() for runtime value.
 */
export const ELIZACLOUD_MIN_DELAY_MS = 6000;

const MIN_CONCURRENT = 1;
const MAX_CONCURRENT = 32;

let warnedInvalidMaxConcurrentLlm = false;

function parseEnvConcurrent(): number {
  const raw = process.env.PRR_MAX_CONCURRENT_LLM;
  if (raw === undefined || raw === '') return MIN_CONCURRENT;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < MIN_CONCURRENT || n > MAX_CONCURRENT) {
    if (!warnedInvalidMaxConcurrentLlm) {
      warnedInvalidMaxConcurrentLlm = true;
      console.warn(
        `PRR_MAX_CONCURRENT_LLM="${raw}" is invalid; using ${MIN_CONCURRENT.toLocaleString()} (allowed range ${MIN_CONCURRENT.toLocaleString()}–${MAX_CONCURRENT.toLocaleString()}, integers only).`,
      );
    }
    return MIN_CONCURRENT;
  }
  return n;
}

function parseEnvMinDelayMs(): number | null {
  const raw = process.env.PRR_LLM_MIN_DELAY_MS;
  if (raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

let effectiveMaxConcurrentLLM: number | undefined;
let effectiveMinDelayMs: number | undefined;

/**
 * Effective max concurrent LLM requests (single source of truth for all parallelism caps).
 * WHY: PRR_MAX_CONCURRENT_LLM lets operators tune without code change; default 1 keeps deployments safe.
 * Range [1, 32]; invalid or unset => 1.
 */
export function getEffectiveMaxConcurrentLLM(): number {
  if (effectiveMaxConcurrentLLM === undefined) {
    effectiveMaxConcurrentLLM = parseEnvConcurrent();
  }
  return effectiveMaxConcurrentLLM;
}

/**
 * Effective min delay (ms) between starting successive requests per slot.
 * Uses PRR_LLM_MIN_DELAY_MS if set and non-negative; else ELIZACLOUD_MIN_DELAY_MS.
 * WHY override: Operators can tune for a specific gateway without code change.
 */
export function getEffectiveMinDelayMs(): number {
  if (effectiveMinDelayMs === undefined) {
    const env = parseEnvMinDelayMs();
    effectiveMinDelayMs = env !== null ? env : ELIZACLOUD_MIN_DELAY_MS;
  }
  return effectiveMinDelayMs;
}

/**
 * Max concurrent LLM dedup calls (per-file).
 * WHY: Running file-level dedup in parallel cuts phase time (e.g. 38 files in ~1 batch
 * instead of 38 sequential). ElizaCloud still serializes via acquireElizacloud(); direct
 * Anthropic/OpenAI get real parallelism. Cap at 5 to avoid 429 on strict gateways.
 */
export const LLM_DEDUP_MAX_CONCURRENT = 5;
