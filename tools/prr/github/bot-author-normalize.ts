/**
 * Normalize GitHub review-bot author strings for display and dedup bucketing.
 * WHY: Issue comments use raw logins (`claude[bot]`, `cursor[bot]`); we also emit
 * short labels (`Claude`, `Cursor`). Same physical bot must share one bucket in
 * `deduplicateSameBotAcrossComments` (docs/ROADMAP bot dedup follow-up).
 */

export function normalizeReviewBotAuthorLabel(loginOrDisplay: string): string {
  const s = loginOrDisplay.trim();
  if (!s) return 'unknown';
  const lower = s.toLowerCase();
  if (lower.includes('claude')) return 'Claude';
  if (lower.includes('greptile')) return 'Greptile';
  if (lower.includes('copilot')) return 'Copilot';
  if (lower.includes('cursor')) return 'Cursor';
  return s.replace(/\[bot\]$/i, '');
}
