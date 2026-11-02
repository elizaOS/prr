/**
 * Deterministic signals from PR titles/metadata (no LLM).
 */

import { formatNumber } from '../../shared/logger.js';
import type { AuthorPrRow } from './types.js';

const CONV = /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?!?:\s*/i;

const STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'for',
  'of',
  'in',
  'on',
  'with',
  'from',
  'into',
  'by',
  'at',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'use',
  'using',
  'add',
  'fix',
  'update',
  'remove',
]);

function stripConventionalTitle(title: string): string {
  return title.replace(CONV, '').trim() || title;
}

function tokenize(title: string): string[] {
  const t = stripConventionalTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!t) return [];
  return t.split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

function normalizeTitleKey(title: string): string {
  const s = stripConventionalTitle(title).toLowerCase().replace(/\s+/g, ' ').trim();
  return s.slice(0, 80);
}

export interface HeuristicSheet {
  markdown: string;
  /** Title keys that appeared more than once (merged/closed duplicates). */
  repeatedTitleClusters: Array<{ key: string; count: number; examples: number[] }>;
}

function tokenizeLoose(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!t) return [];
  return t.split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
}

export function buildHeuristicSheet(
  owner: string,
  repo: string,
  author: string,
  rows: AuthorPrRow[]
): HeuristicSheet {
  const n = rows.length;
  const withDetails = rows.filter(r => r.details);
  const merged = rows.filter(r => r.merged).length;
  const open = rows.filter(r => r.state === 'open').length;
  const closedNotMerged = rows.filter(r => r.state === 'closed' && !r.merged).length;
  const drafts = rows.filter(r => r.draft).length;

  const prefixCounts = new Map<string, number>();
  for (const r of rows) {
    const m = r.title.match(CONV);
    const p = m ? m[1].toLowerCase() : '(no conventional prefix)';
    prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }

  const wordCounts = new Map<string, number>();
  for (const r of rows) {
    for (const w of tokenize(r.title)) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }
  for (const r of withDetails) {
    const d = r.details;
    if (!d) continue;
    for (const w of tokenizeLoose(d.body)) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
    for (const c of [...d.issueComments, ...d.reviewInline, ...d.reviewSubmitted]) {
      for (const w of tokenizeLoose(c.body)) {
        wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
      }
    }
  }
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([w, c]) => `- **${w}** — ${formatNumber(c)}× in titles`);

  const titleKeyToNumbers = new Map<string, number[]>();
  for (const r of rows) {
    const k = normalizeTitleKey(r.title);
    if (!k) continue;
    const arr = titleKeyToNumbers.get(k) ?? [];
    arr.push(r.number);
    titleKeyToNumbers.set(k, arr);
  }
  const repeatedTitleClusters = [...titleKeyToNumbers.entries()]
    .filter(([, nums]) => nums.length > 1)
    .map(([key, examples]) => ({ key, count: examples.length, examples }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const recent = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15);
  const recentLines = recent.map(
    r =>
      `- #${formatNumber(r.number)} ${r.merged ? 'merged' : r.state === 'open' ? 'open' : 'closed'} — ${r.title}`
  );

  let md = `# Contributor sheet (heuristics)\n\n`;
  md += `**Repository:** \`${owner}/${repo}\`  \n`;
  md += `**Author:** \`${author}\`  \n`;
  md += `**PRs in sample:** ${formatNumber(n)} (merged: ${formatNumber(merged)}, open: ${formatNumber(open)}, closed without merge: ${formatNumber(closedNotMerged)}${drafts ? `, drafts in sample: ${formatNumber(drafts)}` : ''})\n`;
  if (withDetails.length > 0) {
    const ic = withDetails.reduce((s, r) => s + (r.details?.issueComments.length ?? 0), 0);
    const ri = withDetails.reduce((s, r) => s + (r.details?.reviewInline.length ?? 0), 0);
    const rs = withDetails.reduce((s, r) => s + (r.details?.reviewSubmitted.length ?? 0), 0);
    md += `**Deep fetch:** ${formatNumber(withDetails.length)} PR(s) include description + threads (${formatNumber(ic)} issue comments, ${formatNumber(ri)} inline review, ${formatNumber(rs)} submitted review snippets).\n`;
  }
  md += '\n';

  md += `## What they seemingly work on\n\n`;
  md += `Conventional-commit style prefixes (from titles):\n\n`;
  const prefLines = [...prefixCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, c]) => `- **${p}** — ${formatNumber(c)}`);
  md += prefLines.join('\n') + '\n\n';
  md += `Recurring words in titles, descriptions, and fetched comments (weak statistical signal):\n\n`;
  md += (topWords.length ? topWords.join('\n') : '_(none)_') + '\n\n';

  md += `## Repeated / similar work\n\n`;
  if (repeatedTitleClusters.length === 0) {
    md += `_No duplicate normalized titles in this sample._\n\n`;
  } else {
    md += `_Same theme retried or duplicate PRs (normalized title):_\n\n`;
    for (const c of repeatedTitleClusters) {
      const nums = c.examples.slice(0, 5).map(n => `#${formatNumber(n)}`).join(', ');
      md += `- **${c.count}×** — “${c.key}” (e.g. ${nums}${c.examples.length > 5 ? ', …' : ''})\n`;
    }
    md += '\n';
  }

  md += `## Recent PRs (newest first in sample)\n\n`;
  md += recentLines.join('\n') + '\n\n';

  md += `## Limits\n\n`;
  md +=
    `- GitHub search caps at **${formatNumber(1000)}** results; older PRs may be missing.\n` +
    `- Thread data is capped per PR and only fetched for the newest-updated subset (see CLI). Inline **review threads** (nested replies) are approximated by inline comments + submitted reviews, not full GraphQL thread layout.\n` +
    `- Use \`--llm\` for a narrative synthesis; evidence still skews toward what GitHub returned.\n`;

  return { markdown: md, repeatedTitleClusters };
}

export function buildPrListForLlm(owner: string, repo: string, rows: AuthorPrRow[], maxLines: number): string {
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lines = sorted.map(r => {
    const status = r.merged ? 'merged' : r.state === 'open' ? 'open' : 'closed_unmerged';
    return `#${r.number}\t${r.createdAt.slice(0, 10)}\t${status}\t${r.title.replace(/\s+/g, ' ').trim()}`;
  });
  const head = lines.slice(0, maxLines);
  const omitted = lines.length - head.length;
  const header = `repo\t${owner}/${repo}\tPRs\t${formatNumber(sorted.length)}`;
  let body = [header, ...head].join('\n');
  if (omitted > 0) {
    body += `\n… ${formatNumber(omitted)} more lines omitted for context size …`;
  }
  return body;
}
