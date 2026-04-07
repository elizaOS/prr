/**
 * ElizaCloud error parsing, JSON sanitization, conflict prompt rules, and ID normalization
 * for LLMClient. Extracted from client.ts for structure.
 */
import { formatNumber } from '../../../shared/logger.js';
import {
  ELIZACLOUD_COMPLETION_CONTEXT_RESERVE_TOKENS,
  ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS,
  estimateElizacloudInputTokensFromCharLength,
  getElizaCloudModelContextSpec,
  getMaxElizacloudLlmCompleteInputChars,
  getMaxFixPromptCharsForModel,
  resolveElizaCloudCanonicalModelId,
} from '../../../shared/llm/model-context-limits.js';

/** Extract response status, headers, and body from OpenAI-style or nested errors for ElizaCloud debugging. */
export function getElizaCloudErrorContext(error: unknown): { status?: number; statusText?: string; headers?: Record<string, string>; body?: unknown; message?: string; cause?: unknown } {
  const out: { status?: number; statusText?: string; headers?: Record<string, string>; body?: unknown; message?: string; cause?: unknown } = {};
  if (error == null || typeof error !== 'object') return out;
  const e = error as Record<string, unknown>;
  out.message = e.message != null ? String(e.message) : undefined;
  out.cause = e.cause;
  if (typeof e.status === 'number') out.status = e.status as number;
  const headers = e.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const h = headers as Record<string, unknown> & { forEach?: (cb: (v: string, k: string) => void) => void };
    if (typeof h.forEach === 'function') {
      out.headers = {};
      h.forEach((v: string, k: string) => { out.headers![k] = v; });
    } else {
      out.headers = {};
      for (const [k, v] of Object.entries(h)) {
        if (typeof v === 'string') out.headers[k] = v;
        else if (Array.isArray(v) && v.length) out.headers[k] = String(v[0]);
      }
    }
  }
  if ('error' in e && e.error !== undefined) out.body = e.error;
  if (out.body === undefined && 'data' in e && e.data !== undefined) out.body = e.data;
  const cause = e.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === 'object' && out.body === undefined && 'responseBody' in cause) out.body = cause.responseBody;
  if (cause && typeof cause === 'object' && out.body === undefined && 'error' in cause) out.body = cause.error;
  return out;
}

/** True when error looks like ElizaCloud/gateway 5xx (status or message heuristics). */
export function isElizaCloudServerClassError(e: unknown): boolean {
  const ctx = getElizaCloudErrorContext(e);
  if (ctx.status === 500 || ctx.status === 502 || ctx.status === 504) return true;
  const msg = `${ctx.message ?? ''} ${e instanceof Error ? e.message : String(e)}`;
  return /500|504|502|gateway.*timeout|deployment.*timeout|internal_server_error/i.test(msg);
}

/**
 * For debug when ElizaCloud returns 5xx: configured max context vs this request size.
 * WHY: Gateway often wraps upstream 400 (context) as 500 — operators need expected limits from model-context-limits.
 */
export function elizaCloudServerErrorExpectationDebug(
  model: string,
  prompt: string,
  systemPrompt?: string
): Record<string, string | boolean> {
  const spec = getElizaCloudModelContextSpec(model);
  const canonical = resolveElizaCloudCanonicalModelId(model);
  const sysLen = systemPrompt?.length ?? 0;
  const total = prompt.length + sysLen;
  const { approxTokens: estIn, assumedCharsPerToken } = estimateElizacloudInputTokensFromCharLength(model, total);
  const headroom = spec.maxContextTokens - estIn - ELIZACLOUD_COMPLETION_CONTEXT_RESERVE_TOKENS;
  const cappedCompletion = Math.min(
    ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS,
    Math.max(256, headroom),
  );
  const worstDefault = estIn + ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS;
  return {
    expectedMaxContextTokens: formatNumber(spec.maxContextTokens),
    expectedMaxFixPromptChars: formatNumber(getMaxFixPromptCharsForModel('elizacloud', model)),
    expectedMaxTotalInputChars: formatNumber(getMaxElizacloudLlmCompleteInputChars(model)),
    requestUserChars: formatNumber(prompt.length),
    requestSystemChars: formatNumber(sysLen),
    requestTotalChars: formatNumber(total),
    estimatedInputTokensApprox: formatNumber(estIn),
    tokenizerAssumptionCharsPerToken: String(assumedCharsPerToken),
    maxCompletionTokensDefault: formatNumber(ELIZACLOUD_DEFAULT_MAX_COMPLETION_TOKENS),
    estimatedInputPlusDefaultMaxOutputApprox: formatNumber(worstDefault),
    estimatedExceedsContextWithDefaultMaxOut: worstDefault > spec.maxContextTokens,
    effectiveMaxCompletionAfterContextCap: formatNumber(cappedCompletion),
    usingUnknownModelContextDefault: canonical === null,
    ...(canonical != null ? { canonicalModelId: canonical } : {}),
  };
}

/**
 * Gateway may return HTTP 500 while embedding a 400 "maximum context length" from the upstream.
 * Retrying is pointless; lowering the fix prompt cap helps the next batch.
 */
export function isLikelyContextLengthExceededError(e: unknown): boolean {
  const parts: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (depth > 6 || x == null) return;
    if (x instanceof Error) {
      parts.push(x.message);
      walk(x.cause, depth + 1);
      return;
    }
    if (typeof x === 'string') {
      parts.push(x);
      return;
    }
    if (typeof x === 'object') {
      try {
        parts.push(JSON.stringify(x));
      } catch {
        parts.push(String(x));
      }
    }
  };
  walk(e, 0);
  const t = parts.join('\n');
  return /maximum context length|maximum context length is \d+ tokens|input tokens\. please reduce|reduce the length of the input messages|context window.*exceeded/i.test(
    t
  );
}

/** Safe description of an API key for debug/error messages (never log the full key). */
export function maskApiKey(key: string | undefined): string {
  if (key === undefined || key === null) return 'not set';
  const k = key.trim();
  if (!k.length) return 'empty after trim';
  const prefix = k.length <= 8 ? k.slice(0, 2) + '***' : k.slice(0, 6) + '...';
  return `length=${k.length}, prefix=${prefix}`;
}

/** File-type-specific rules for conflict resolution prompt (reduces invalid JSON/TS output). */
export function getConflictFileTypeRules(filePath: string): string {
  if (filePath.endsWith('.json')) {
    const base = '\n6. Output must be strict JSON (no comments, no trailing commas).';
    if (/package\.json$/i.test(filePath)) {
      return base +
        '\n7. CRITICAL: No duplicate keys allowed in JSON objects. When both sides add entries to "scripts", "dependencies", or "devDependencies", merge ALL entries from BOTH sides into a single object — do NOT repeat any key name.' +
        '\n8. When both sides define the same script key (e.g. "dev") with different values, keep the HEAD version unless the base version adds a clearly new feature.';
    }
    return base;
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) {
    return '\n6. Preserve all imports and ensure the result compiles.';
  }
  return '';
}

/** Normalize issue/comment IDs: strip markdown (headings, bold) and standardize to issue_<n> for matching. */
export function normalizeIssueId(raw: string): string {
  const normalized = raw.trim()
    .replace(/^#+\s*/, '')
    .replace(/^\*{1,2}/, '')
    .replace(/\*{1,2}$/, '')
    .toLowerCase()
    .replace(/^issue[_\s]*/i, '')
    .replace(/^#/, '');
  return normalized.length > 0 ? `issue_${normalized}` : normalized;
}

/**
 * Strip unpaired UTF-16 surrogates from a string.
 * Lone surrogates (U+D800–U+DFFF without a valid pair) are invalid in JSON
 * and cause API errors like "no low surrogate in string". Replaces them with U+FFFD.
 */
export function sanitizeForJson(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}
