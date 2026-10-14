/**
 * Which ElizaCloud / gateway failures should **not** get 504-style exponential backoff.
 * WHY: Billing and pricing errors return HTTP 500 but retries waste minutes and obscure the real cause in logs.
 */

/** Concatenate common string fields from thrown SDK/gateway errors for pattern matching. */
function elizaCloudErrorSearchBlob(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  else parts.push(String(error));
  if (error != null && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    for (const key of ['body', 'data', 'error', 'responseBody'] as const) {
      const v = e[key];
      if (typeof v === 'string') parts.push(v);
      else if (v != null && typeof v === 'object') {
        try {
          parts.push(JSON.stringify(v));
        } catch {
          /* ignore */
        }
      }
    }
    const cause = e.cause;
    if (cause instanceof Error) parts.push(cause.message);
    else if (cause != null && typeof cause === 'object' && 'message' in cause) {
      parts.push(String((cause as { message?: unknown }).message));
    }
  }
  return parts.join('\n');
}

/**
 * True when another request is unlikely to succeed without operator action (billing, pricing, bad key).
 * Used by **`llm-api`** and **`llm-client-transport`** to skip “server error, retrying” backoff.
 */
export function isLikelyNonRetryableElizaCloudError(error: unknown): boolean {
  const hay = elizaCloudErrorSearchBlob(error).toLowerCase();
  if (!hay.trim()) return false;
  if (/pricing unavailable|insufficient credits|payment required|quota exceeded|billing disabled/i.test(hay)) {
    return true;
  }
  if (/invalid_api_key|incorrect api key|api key.*invalid/i.test(hay)) {
    return true;
  }
  return false;
}
