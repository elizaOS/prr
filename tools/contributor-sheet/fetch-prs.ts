/**
 * Paginate GitHub issue search for PRs by author in one repo.
 * WHY search API: REST pulls list has no author filter; matches GitHub web UI `is:pr author:login`.
 */

import type { Octokit } from '@octokit/rest';
import { debug, formatNumber, warn } from '../../shared/logger.js';
import type { AuthorPrRow } from './types.js';

export type { AuthorPrRow } from './types.js';

const PER_PAGE = 100;
/** GitHub returns at most 1,000 search hits regardless of total_count. */
export const SEARCH_MAX_RESULTS = 1000;

function mapItem(item: {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  draft?: boolean;
  pull_request?: { merged_at?: string | null } | null;
}): AuthorPrRow {
  const mergedAt = item.pull_request?.merged_at;
  const merged = mergedAt != null && mergedAt !== '';
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    htmlUrl: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    closedAt: item.closed_at,
    merged,
    draft: item.draft,
  };
}

export interface FetchAuthorPrsResult {
  rows: AuthorPrRow[];
  totalReported: number;
  truncated: boolean;
}

export async function fetchAuthorPrs(
  octokit: Octokit,
  owner: string,
  repo: string,
  author: string
): Promise<FetchAuthorPrsResult> {
  const q = `repo:${owner}/${repo} is:pr author:${author}`;
  const rows: AuthorPrRow[] = [];
  let totalReported = 0;
  let page = 1;

  while (rows.length < SEARCH_MAX_RESULTS) {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q,
      per_page: PER_PAGE,
      page,
      sort: 'created',
      order: 'desc',
    });
    totalReported = data.total_count;
    for (const item of data.items) {
      rows.push(mapItem(item));
    }
    debug('contributor-sheet search page', {
      page,
      got: formatNumber(data.items.length),
      totalSoFar: formatNumber(rows.length),
      totalCount: formatNumber(data.total_count),
    });
    if (data.items.length < PER_PAGE) break;
    page += 1;
  }

  const truncated = totalReported > rows.length;
  if (truncated) {
    warn(
      `Search reports ${formatNumber(totalReported)} PRs; GitHub only returns the first ${formatNumber(SEARCH_MAX_RESULTS)}. Sheet is based on those.`
    );
  }

  return { rows, totalReported, truncated };
}
