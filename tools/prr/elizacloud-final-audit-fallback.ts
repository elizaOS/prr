/**
 * When ElizaCloud **`PRR_LLM_MODEL`** resolves to a small/cheap verifier (gateway substitution
 * or explicit env), adversarial **final audit** must not use the same id — false **UNFIXED**
 * vs full-file excerpts (Cycle 65 / 82). **`index.ts`** assigns **`config.finalAuditModel`** when unset.
 */

/**
 * Small/fast ElizaCloud ids used for batch analysis — poor adversarial final-audit behavior.
 * **Keep aligned** with **`LLMClient`** weak-verifier heuristics (**`tools/prr/llm/client.ts`**).
 */
export function isWeakElizacloudBatchVerifierModelId(id: string): boolean {
  return (
    /\b(14b|mini|qwen-3-14b|gpt-4o-mini)\b/i.test(id) ||
    /\bqwen-3-235b?\b/i.test(id)
  );
}

/** Prefer Opus-class, then dated Sonnet snapshot, for final-audit when analysis model is weak. */
export function pickStrongElizaCloudAuditFallback(
  available: Set<string>,
  skipSet: Set<string>,
): string | undefined {
  const order = [
    'anthropic/claude-opus-4.5',
    'anthropic/claude-opus-4-20250514',
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-sonnet-4-6',
  ];
  for (const m of order) {
    if (available.has(m) && !skipSet.has(m)) return m;
  }
  return undefined;
}
