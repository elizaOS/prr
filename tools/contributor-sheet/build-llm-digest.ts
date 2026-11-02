/**
 * Build a large plain-text digest for the LLM: full PR catalog + threaded excerpts where available.
 */

import { formatNumber } from '../../shared/logger.js';
import type { AuthorPrRow } from './types.js';

export interface DigestOptions {
  /** Max lines at start of chronological catalog when truncating. */
  maxCatalogHead: number;
  /** Max lines at end of chronological catalog when truncating. */
  maxCatalogTail: number;
  /** Hard cap on total digest characters (UTF-16 length). */
  maxTotalChars: number;
}

function prStatusLine(r: AuthorPrRow): string {
  const status = r.merged ? 'merged' : r.state === 'open' ? 'open' : 'closed_unmerged';
  return `#${r.number}\t${r.createdAt.slice(0, 10)}\t${r.updatedAt.slice(0, 10)}\t${status}\t${r.title.replace(/\s+/g, ' ').trim()}`;
}

function formatCommentBlock(prefix: string, comments: Array<{ author: string; createdAt: string; body: string; path?: string }>): string {
  if (comments.length === 0) return '';
  const lines = comments.map(c => {
    const loc = c.path ? ` ${c.path}` : '';
    const one = c.body.replace(/\s+/g, ' ').trim();
    return `  - ${c.author} @ ${c.createdAt.slice(0, 19)}${loc}: ${one}`;
  });
  return `${prefix} (${formatNumber(comments.length)}):\n${lines.join('\n')}\n`;
}

function prThreadBlock(r: AuthorPrRow): string {
  const d = r.details;
  if (!d) return '';
  const status = r.merged ? 'merged' : r.state === 'open' ? 'open' : 'closed_unmerged';
  let s = `\n==== PR #${formatNumber(r.number)} | ${status} | +${formatNumber(d.additions)}/-${formatNumber(d.deletions)} | ${formatNumber(d.changedFiles)} files ====\n`;
  s += `Title: ${r.title}\n`;
  s += `Created: ${r.createdAt}  Updated: ${r.updatedAt}\n`;
  if (d.body) {
    s += `Description:\n${d.body}\n`;
  } else {
    s += `Description: _(empty)_\n`;
  }
  s += formatCommentBlock('Issue / timeline comments', d.issueComments);
  s += formatCommentBlock('Inline review comments', d.reviewInline);
  s += formatCommentBlock('Submitted review bodies', d.reviewSubmitted);
  return s;
}

/**
 * Chronological catalog (all PRs) plus full thread text for PRs that have `details`.
 */
export function buildRichLlmDigest(
  owner: string,
  repo: string,
  author: string,
  rows: AuthorPrRow[],
  opts: DigestOptions
): { text: string; catalogTruncated: boolean; threadTruncated: boolean } {
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const catalogLines = sorted.map(prStatusLine);

  let catalogTruncated = false;
  let catalogText: string;
  const { maxCatalogHead, maxCatalogTail, maxTotalChars } = opts;
  if (catalogLines.length <= maxCatalogHead + maxCatalogTail) {
    catalogText = catalogLines.join('\n');
  } else {
    catalogTruncated = true;
    const head = catalogLines.slice(0, maxCatalogHead);
    const tail = catalogLines.slice(-maxCatalogTail);
    const omitted = catalogLines.length - head.length - tail.length;
    catalogText = [
      ...head,
      `… (${formatNumber(omitted)} PRs omitted from middle of catalog — see GitHub for full list) …`,
      ...tail,
    ].join('\n');
  }

  const header = `Repository: ${owner}/${repo}
PR author login: ${author}
Total PRs in sample: ${formatNumber(sorted.length)}

--- PART 1: Chronological PR catalog (one line each: #, created, last updated, outcome, title) ---
${catalogText}
`;

  let body = header;
  let threadTruncated = false;

  const withDetails = sorted.filter(r => r.details);
  body += `\n--- PART 2: PR descriptions and conversations (REST: issue comments, inline reviews, submitted review bodies) ---\n`;
  body += `_Thread excerpts are only present for PRs selected for deep fetch (newest \`updated_at\` first)._\n`;

  for (const r of withDetails) {
    const block = prThreadBlock(r);
    if (body.length + block.length > maxTotalChars) {
      threadTruncated = true;
      body += `\n… (${formatNumber(withDetails.length)} PRs had thread data; further blocks omitted to stay under ${formatNumber(maxTotalChars)} characters) …\n`;
      break;
    }
    body += block;
  }

  if (withDetails.length === 0) {
    body += `\n_(No per-PR body/comment fetch for this run — use default depth or increase --max-detail-prs.)_\n`;
  }

  if (body.length > maxTotalChars) {
    body = body.slice(0, maxTotalChars) + `\n… (hard truncate at ${formatNumber(maxTotalChars)} chars) …\n`;
    threadTruncated = true;
  }

  return { text: body, catalogTruncated, threadTruncated };
}
