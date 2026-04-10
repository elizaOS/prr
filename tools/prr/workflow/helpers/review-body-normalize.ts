/**
 * Normalize review comment bodies for deduplication and similarity.
 * WHY: Bots frame the same issue with different severity labels, emojis, and headings;
 * stripping that noise makes symbol extraction and Jaccard overlap stable (PR #417 audit).
 */

/** Strip severity / recap framing so symbol and keyword matching see substance first. */
export function stripSeverityFraming(body: string): string {
  return body
    .replace(
      /^\s*(?:\*{1,2}|#{1,4}\s*(?:\d+[\.)]\s*)?)\s*(?:Critical|High|Medium|Low|Minor|Nit|Blocking)\s*(?:Bug|Issue|Severity|Risk|Priority)?\s*(?:\*{1,2})?\s*[-—:.]\s*/gim,
      '',
    )
    .replace(/^(?:🚨|⚠️|🔴|🟡|🟢|ℹ️|❌|✅|🐛|💡|🛠️)\s*/gm, '')
    .replace(/^(?:Bug|Issue|Item|Finding)?\s*#?\d+[\.):\s—-]+/gim, '')
    .replace(/^(?:TITLE|SUMMARY|ISSUES?|BUGS?|POSITIVES?|STRENGTHS?)\s*:\s*/gim, '')
    .trim();
}

const WORD_SPLIT = /[\s,.;:!?()[\]{}'"`/]+/;

/** Jaccard similarity on word sets (length ≥ 3) after severity strip. */
export function wordSetJaccard(a: string, b: string): number {
  const toSet = (s: string) =>
    new Set(
      stripSeverityFraming(s)
        .toLowerCase()
        .split(WORD_SPLIT)
        .filter((w) => w.length >= 3),
    );
  const setA = toSet(a);
  const setB = toSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
