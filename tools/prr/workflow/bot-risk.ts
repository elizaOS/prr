/**
 * Bot risk map: per-file counts of review comments by bot author.
 * Used to (a) focus the LLM predictor on high-activity files and
 * (b) improve the fix prompt ("Bots have commented often in this file").
 */
import type { ReviewComment } from '../github/types.js';

export interface BotRiskEntry {
  byBot: Record<string, number>;
  total: number;
}

/**
 * Summarize comment counts per file (and per author within each file).
 * If `paths` is provided, return only entries for those paths (e.g. changed files or issue set).
 */
export function summarizeBotRiskByFile(
  comments: ReviewComment[],
  paths?: string[]
): Map<string, BotRiskEntry> {
  const byPath = new Map<string, Record<string, number>>();

  for (const c of comments) {
    const path = c.path;
    if (paths && paths.length > 0 && !paths.includes(path)) continue;

    if (!byPath.has(path)) {
      byPath.set(path, {});
    }
    const counts = byPath.get(path)!;
    const author = c.author || 'unknown';
    counts[author] = (counts[author] ?? 0) + 1;
  }

  const result = new Map<string, BotRiskEntry>();
  for (const [path, byBot] of byPath) {
    const total = Object.values(byBot).reduce((s, n) => s + n, 0);
    result.set(path, { byBot, total });
  }
  return result;
}
