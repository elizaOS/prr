/**
 * Per-PR REST fetches: description, issue timeline comments, inline review comments, submitted reviews.
 * WHY REST not GraphQL: matches existing Octokit usage; sufficient for author "convos" at scale with caps.
 */

import type { Octokit } from '@octokit/rest';
import { debug, formatNumber, warn } from '../../shared/logger.js';
import { runWithConcurrency } from '../../shared/run-with-concurrency.js';
import type { AuthorPrRow, PrDeepDetails, ThreadComment } from './types.js';

export type { PrDeepDetails, ThreadComment } from './types.js';

export interface DetailFetchCaps {
  maxIssueCommentsPerPr: number;
  maxReviewInlinePerPr: number;
  maxReviewSummariesPerPr: number;
  maxBodyChars: number;
  maxCommentChars: number;
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n… (truncated)';
}

function normalizeBody(raw: string | null | undefined, maxBodyChars: number): string {
  return truncate(raw ?? '', maxBodyChars);
}

async function listIssueCommentsCapped(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  max: number,
  maxCommentChars: number
): Promise<ThreadComment[]> {
  const out: ThreadComment[] = [];
  let page = 1;
  const perPage = 100;
  while (out.length < max) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: perPage,
      page,
    });
    for (const c of data) {
      const author = c.user?.login ?? '(unknown)';
      const body = truncate(c.body ?? '', maxCommentChars);
      if (body.length === 0) continue;
      out.push({
        kind: 'issue',
        author,
        createdAt: c.created_at,
        body,
      });
      if (out.length >= max) return out;
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

async function listReviewInlineCapped(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  max: number,
  maxCommentChars: number
): Promise<ThreadComment[]> {
  const out: ThreadComment[] = [];
  let page = 1;
  const perPage = 100;
  while (out.length < max) {
    const { data } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
      page,
    });
    for (const c of data) {
      const author = c.user?.login ?? '(unknown)';
      const body = truncate(c.body ?? '', maxCommentChars);
      if (body.length === 0) continue;
      out.push({
        kind: 'review_inline',
        author,
        createdAt: c.created_at,
        body,
        path: c.path ?? undefined,
        line: c.line ?? c.original_line ?? null,
      });
      if (out.length >= max) return out;
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

async function listReviewSummariesCapped(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  max: number,
  maxCommentChars: number
): Promise<ThreadComment[]> {
  const out: ThreadComment[] = [];
  let page = 1;
  const perPage = 30;
  while (out.length < max) {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
      page,
    });
    for (const r of data) {
      const raw = (r.body ?? '').trim();
      if (!raw) continue;
      const author = r.user?.login ?? '(unknown)';
      out.push({
        kind: 'review_submitted',
        author,
        createdAt: r.submitted_at ?? '',
        body: truncate(raw, maxCommentChars),
      });
      if (out.length >= max) return out;
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

async function fetchOnePrDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  caps: DetailFetchCaps,
  includeIssueComments: boolean,
  includeReviewInline: boolean,
  includeReviewSummaries: boolean
): Promise<PrDeepDetails> {
  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const [issueComments, reviewInline, reviewSubmitted] = await Promise.all([
    includeIssueComments
      ? listIssueCommentsCapped(octokit, owner, repo, prNumber, caps.maxIssueCommentsPerPr, caps.maxCommentChars)
      : Promise.resolve([] as ThreadComment[]),
    includeReviewInline
      ? listReviewInlineCapped(octokit, owner, repo, prNumber, caps.maxReviewInlinePerPr, caps.maxCommentChars)
      : Promise.resolve([] as ThreadComment[]),
    includeReviewSummaries
      ? listReviewSummariesCapped(octokit, owner, repo, prNumber, caps.maxReviewSummariesPerPr, caps.maxCommentChars)
      : Promise.resolve([] as ThreadComment[]),
  ]);

  return {
    body: normalizeBody(pull.body, caps.maxBodyChars),
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? 0,
    issueComments,
    reviewInline,
    reviewSubmitted,
  };
}

export interface EnrichOptions extends DetailFetchCaps {
  maxDetailPrs: number;
  detailConcurrency: number;
  includeIssueComments: boolean;
  includeReviewInline: boolean;
  includeReviewSummaries: boolean;
}

/**
 * Mutates rows: sets `details` on the `maxDetailPrs` rows with newest `updatedAt`.
 */
export async function enrichPrRowsWithConversations(
  octokit: Octokit,
  owner: string,
  repo: string,
  rows: AuthorPrRow[],
  opts: EnrichOptions
): Promise<void> {
  if (opts.maxDetailPrs <= 0) return;

  const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pick = sorted.slice(0, Math.min(opts.maxDetailPrs, sorted.length));
  const pickSet = new Set(pick.map(r => r.number));

  debug('contributor-sheet detail fetch', {
    prCount: formatNumber(pick.length),
    concurrency: formatNumber(opts.detailConcurrency),
  });

  const tasks = pick.map(r => async () => {
    try {
      const details = await fetchOnePrDetails(
        octokit,
        owner,
        repo,
        r.number,
        opts,
        opts.includeIssueComments,
        opts.includeReviewInline,
        opts.includeReviewSummaries
      );
      return { number: r.number, details, ok: true as const };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`PR #${formatNumber(r.number)} detail fetch failed: ${msg}`);
      return { number: r.number, details: undefined, ok: false as const };
    }
  });

  const settled = await runWithConcurrency(tasks, Math.max(1, opts.detailConcurrency));
  const byNum = new Map<number, PrDeepDetails>();
  for (const s of settled) {
    if (s.ok && s.details) byNum.set(s.number, s.details);
  }

  for (const row of rows) {
    if (pickSet.has(row.number)) {
      const d = byNum.get(row.number);
      if (d) row.details = d;
    }
  }
}
