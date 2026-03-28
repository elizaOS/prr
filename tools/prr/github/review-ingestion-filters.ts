/**
 * Filters for PR conversation (issue) comments before markdown parsing.
 * WHY: Bots sometimes paste README/setup dumps; those are not code reviews (elizaOS/cloud#417).
 */

/**
 * True when the body looks like project documentation / setup, not a review thread.
 * Conservative: requires multiple doc-style signals in the head of the comment.
 */
export function isNonReviewContent(body: string): boolean {
  const head = body.slice(0, 800).toLowerCase();

  const setupHeadings = [
    '## stack',
    '## commands',
    '## setup',
    '## project structure',
    '## architecture',
    '## database',
    '## table of contents',
    '## getting started',
    '## installation',
    '## deployment',
    'bun install',
    'npm install',
  ];
  const matchCount = setupHeadings.filter((h) => head.includes(h)).length;
  if (matchCount >= 3) return true;

  const stripped = body.replace(/\s+/g, ' ').trim();
  if (stripped.length < 30 && !/\b(?:fix|bug|issue|error|missing|should|must)\b/i.test(stripped)) {
    return true;
  }

  return false;
}
