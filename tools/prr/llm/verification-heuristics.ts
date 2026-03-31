/**
 * Pure heuristics for existence checks, verification evidence, and final-audit snippet/excerpt detection.
 * Extracted from client.ts for structure.
 */

export function commentNeedsConservativeExistenceCheck(comment: string): boolean {
  const c = comment.toLowerCase();
  return (
    /\bmemory leak\b/.test(c) ||
    /\b(?:potential )?leak\b/.test(c) ||
    /\b(?:cleanup|clean up|prune|evict|ttl|lru)\b/.test(c) ||
    /\b(?:stale|orphaned|dangling)\s+(?:entry|entries|state|map|set|cache)\b/.test(c) ||
    /\bnever\s+(?:cleared|cleaned|pruned|deleted|removed)\b/.test(c) ||
    /\bfromend\b/.test(c) ||
    /\b(?:newest|oldest)-first\b/.test(c) ||
    /\bkeep(?:s|ing)?\s+(?:the\s+)?(?:newest|oldest)\b/.test(c) ||
    /\bslicetofitbudget\b/.test(c)
  );
}

/**
 * True when the "already correct" explanation contains concrete code evidence
 * rather than generic reassurance.
 *
 * WHY: The YES->NO override is useful for obvious false positives, but vague
 * phrases like "already correct" are too risky for lifecycle/order-sensitive
 * bugs. Requiring evidence keeps the override from silently hiding real issues.
 */
export function explanationHasConcreteFixEvidence(explanation: string): boolean {
  return (
    /\bline\s+\d+\b/i.test(explanation) ||
    /`[^`\n]{2,120}`/.test(explanation) ||
    /\b(?:now|uses?|returns?|deletes?|removes?|calls?|sets?|sorts?|reverses?)\b.{0,80}\b(?:if|map|set|sliceToFitBudget|fromEnd|delete|cleanup|prune|reverse)\b/i.test(explanation)
  );
}

/**
 * True when the snippet shows a UUID regex using [1-8] and an adjacent line comment documents
 * versions 1–8 (not v4-only). Used to demote false final-audit UNFIXED that parroted an
 * outdated "comment says v4 but allows 1–8" review when the code was already aligned (Cycle 65).
 */
export function snippetShowsUuidCommentAlignedWithVersionRange(codeSnippet: string): boolean {
  if (!/\[1-8\]/.test(codeSnippet)) return false;
  return /(versions?\s*1[\s–-]8|uuid format.*\(versions 1-8\)|version\s+bits.*1.?8)/i.test(codeSnippet);
}

/**
 * True when the final-audit code block is known to be a **partial** view (batch clip, huge-file excerpt, head-only fallback).
 * Used to demote UNFIXED that lacks line+code citations — **WHY:** Adversarial audit must not re-open the fix loop on
 * parroted review text when the model never saw the implementation region (pill-output final-audit cluster).
 */
export function finalAuditSnippetLooksTruncatedOrExcerpt(snippet: string): boolean {
  return (
    /truncated for model context limit — final audit/i.test(snippet) ||
    /more lines omitted — file exceeds/i.test(snippet) ||
    /excerpt only — file has/i.test(snippet) ||
    /\(\d[\d,]* more lines omitted for size\)/i.test(snippet) ||
    /truncated to char budget — final audit excerpt/i.test(snippet)
  );
}

export function explanationMentionsMissingCodeVisibility(explanation: string): boolean {
  return (
    /snippet.*(?:truncated|unavailable)/i.test(explanation) ||
    /(?:truncated|unavailable).*snippet/i.test(explanation) ||
    /truncated snippet.*(?:suggests|appears?)/i.test(explanation) ||
    /appears?\s+to\b.*\btruncated snippet/i.test(explanation) ||
    /truncated (?:snippet|excerpt).*(?:suggests|appears?)/i.test(explanation) ||
    /cannot verify.*(?:truncated|unavailable)/i.test(explanation) ||
    /not visible in the provided excerpt/i.test(explanation) ||
    /not (?:visible|found) in the provided .* excerpt/i.test(explanation) ||
    /not visible in provided .* excerpt/i.test(explanation) ||
    /are not visible in the provided/i.test(explanation) ||
    /excerpt does not (?:include|show|contain)/i.test(explanation) ||
    /can'?t (?:be )?evaluat/i.test(explanation) ||
    /cannot (?:assess|determine|verify)/i.test(explanation) ||
    /(?:code|snippet|excerpt|current code) (?:doesn'?t|does not) show/i.test(explanation) ||
    /\bonly shows\b.*\b(?:not |beginning|start|first|lines? \d)/i.test(explanation) ||
    /\bincomplete\b.*\b(?:show|visible|implementation)\b/i.test(explanation) ||
    /not (?:visible|shown|included) in the (?:current |provided )?(?:excerpt|code|snippet)/i.test(explanation)
  );
}
