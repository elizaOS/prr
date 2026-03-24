import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import {
  type PRInfo,
  type ReviewThread,
  type ReviewComment,
  type PRStatus,
  type BotResponseTiming,
  extractFullCommitShaFromText,
} from './types.js';
import { debug } from '../../../shared/logger.js';

// Static configuration for PR status / bot detection (allocated once, not per call)
const REVIEW_BOT_CHECKS = new Set(['cursor bugbot']);
const RATE_LIMIT_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /rate.?limit/i, name: 'rate.?limit' },
  { pattern: /review.?(cancel|fail|skip|paus|throttl)/i, name: 'review.(cancel|paus|...)' },
  { pattern: /too many (requests|reviews|commits)/i, name: 'too many (requests|reviews)' },
  { pattern: /exceeded.*review/i, name: 'exceeded.*review' },
  { pattern: /review.*exceeded/i, name: 'review.*exceeded' },
  { pattern: /reviews? (are |is )?paused/i, name: 'reviews? (are|is) paused' },
  { pattern: /temporarily unavailable/i, name: 'temporarily unavailable' },
  { pattern: /will (retry|review) (later|shortly|soon)/i, name: 'will (retry|review) later' },
  { pattern: /queued for review/i, name: 'queued for review' },
];
const BOT_PATTERNS = [
  { name: 'coderabbit', pattern: /coderabbitai\[bot\]/i },
  { name: 'copilot', pattern: /copilot/i },
  { name: 'cursor', pattern: /cursor\[bot\]/i },
];

/**
 * CodeRabbit meta comments (Recent review info, Configuration used, auto-reply, "Actions performed").
 * Exclude from fixable/grouping so we don't send them to the fix loop.
 * WHY: Those blurbs are not code reviews; treating them as issues wasted 4+ iterations and produced only UNCLEAR/WRONG_LOCATION.
 */
function isCodeRabbitMetaComment(comment: { author: string; body: string }): boolean {
  if (!/coderabbitai\[bot\]/i.test(comment.author)) return false;
  const b = comment.body.trim();
  if (/^ℹ️\s*Recent review info/i.test(b)) return true;
  if (/\bConfiguration used\b/i.test(b) && /\bReview profile\b/i.test(b)) return true;
  if (/^<!--\s*This is an auto-generated reply/i.test(b)) return true;
  if (/✅\s*Actions performed/i.test(b) && b.length < 2000) return true;
  return false;
}

/**
 * Filter out bot noise comments before parsing.
 *
 * WHY needed: When we parse ALL bot comments (not just the latest), test messages,
 * trigger commands, and placeholder text would pollute the issue list. This filter
 * runs before parseMarkdownReviewIssues so junk never enters the pipeline.
 *
 * WHY 60 chars: Real review comments are always longer (structured markdown with
 * file paths, code blocks, explanations). Trigger commands ("@coderabbitai review")
 * and test messages ("test", "IGNORE THIS") are always shorter.
 *
 * WHY anchored regexes: We only match at start-of-string to avoid false positives
 * on comments that happen to contain "IGNORE THIS" in a code block mid-body.
 */
function isBotNoiseComment(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length < 60) return true;
  if (/^IGNORE\s+THIS/i.test(trimmed)) return true;
  if (/^@\w+\s+review$/i.test(trimmed)) return true;
  return false;
}

export class GitHubAPI {
  private octokit: Octokit;
  private graphqlWithAuth: typeof graphql;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
    this.graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${token}`,
      },
    });
    debug('GitHub API client initialized');
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async getPRInfo(owner: string, repo: string, prNumber: number): Promise<PRInfo> {
    debug('Fetching PR info', { owner, repo, prNumber });
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const info: PRInfo = {
      owner,
      repo,
      number: prNumber,
      title: pr.title,
      body: pr.body ?? '',
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      cloneUrl: pr.head.repo?.clone_url || `https://github.com/${owner}/${repo}.git`,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
    };
    debug('PR info fetched', info);
    return info;
  }

  /**
   * Get repository size in kilobytes (GitHub API "size" field).
   * Returns null if not a GitHub repo or the request fails (e.g. no auth for private).
   */
  async getRepoSizeKb(owner: string, repo: string): Promise<number | null> {
    try {
      const { data } = await this.octokit.repos.get({ owner, repo });
      return typeof data.size === 'number' ? data.size : null;
    } catch {
      return null;
    }
  }

  /**
   * Update a PR branch with the base branch using GitHub's API (equivalent to the "Update branch" button).
   * Returns true on success (202), false on failure. The API responds asynchronously — the merge
   * commit may not be immediately visible; callers should fetch the remote branch after.
   */
  async updatePRBranch(owner: string, repo: string, prNumber: number): Promise<boolean> {
    debug('Updating PR branch via GitHub API', { owner, repo, prNumber });
    try {
      const { data } = await this.octokit.pulls.updateBranch({
        owner,
        repo,
        pull_number: prNumber,
      });
      debug('PR branch update accepted', { message: data?.message, url: data?.url });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('PR branch update via API failed', { error: msg });
      return false;
    }
  }

  async getPRStatus(owner: string, repo: string, prNumber: number, ref: string): Promise<PRStatus> {
    debug('Fetching PR status/checks', { owner, repo, prNumber, ref });

    // Get all check runs for this ref using pagination.
    // 422/404 can occur when Checks API is unavailable (e.g. token lacks checks:read, or repo settings).
    const allCheckRuns: Array<{ status: string; name: string }> = [];
    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.checks.listForRef,
        {
          owner,
          repo,
          ref,
          per_page: 100,
        }
      )) {
        const runs = (response.data as any).check_runs || response.data;
        if (Array.isArray(runs)) {
          allCheckRuns.push(...runs);
        }
      }
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 422 || status === 404) {
        debug('Check runs API unavailable (422/404), assuming no check runs', { owner, repo, ref });
      } else {
        throw err;
      }
    }

    // Exclude review-bot check runs from inProgressChecks so we don't treat them as CI.
    const inProgressChecks: string[] = [];
    const pendingChecks: string[] = [];
    let completedChecks = 0;

    for (const check of allCheckRuns) {
      if (REVIEW_BOT_CHECKS.has(check.name.toLowerCase())) {
        continue;
      }
      if (check.status === 'in_progress') {
        inProgressChecks.push(check.name);
      } else if (check.status === 'queued' || check.status === 'pending') {
        pendingChecks.push(check.name);
      } else if (check.status === 'completed') {
        completedChecks++;
      }
    }

    // Total excludes review-bot checks so CI completion reflects real CI only.
    const totalChecks = inProgressChecks.length + pendingChecks.length + completedChecks;

    // Get combined status (commit statuses; can also 422 if token lacks scope).
    let status: { state: string };
    try {
      const res = await this.octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref,
      });
      status = res.data;
    } catch (err: unknown) {
      const code = (err as { status?: number })?.status;
      if (code === 422 || code === 404) {
        debug('Combined status API unavailable (422/404), assuming success', { owner, repo, ref });
        status = { state: 'success' };
      } else {
        throw err;
      }
    }

    // Get requested reviewers (pending review requests)
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const pendingReviewers: string[] = [
      ...pr.requested_reviewers?.map(r => r.login) || [],
      ...pr.requested_teams?.map(t => t.name) || [],
    ];

    // Get reviews to check for "in progress" bot reviews
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    // Patterns that indicate a bot is still reviewing
    const inProgressPatterns = [
      /reviewing|analyzing|processing|scanning|checking/i,
      /will (comment|review|analyze)/i,
      /in progress/i,
      /please wait/i,
      /^>/,  // CodeRabbit summary blocks often start with >
    ];

    // Track bots that might still be reviewing
    const botReviewStates = new Map<string, { hasInProgress: boolean; hasCompleted: boolean }>();
    
    for (const review of reviews) {
      const author = review.user?.login || '';
      const isBot = author.includes('[bot]') || author.toLowerCase().includes('bot');
      
      if (isBot) {
        if (!botReviewStates.has(author)) {
          botReviewStates.set(author, { hasInProgress: false, hasCompleted: false });
        }
        
        const state = botReviewStates.get(author)!;
        const body = review.body || '';
        
        // Check if this looks like an "in progress" message
        const looksInProgress = inProgressPatterns.some(p => p.test(body)) && body.length < 500;
        // Check if this looks like a completed review (has substantial content or code comments)
        const looksCompleted = body.length > 500 || review.state === 'CHANGES_REQUESTED' || review.state === 'APPROVED';
        
        if (looksInProgress && !looksCompleted) {
          state.hasInProgress = true;
        }
        if (looksCompleted) {
          state.hasCompleted = true;
        }
      }
    }

    // Bots that have in-progress markers but no completed review
    const activelyReviewingBots = Array.from(botReviewStates.entries())
      .filter(([_, state]) => state.hasInProgress && !state.hasCompleted)
      .map(([author]) => author);

    // Check for 👀 (eyes) reactions from bots on recent comments
    // This indicates "I'm looking at this / working on it"
    const botsWithEyesReaction = new Set<string>();
    
    try {
      // Get PR comments (issue comments on the PR)
      const { data: issueComments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 30,  // Recent comments only
      });

      // Check reactions on each comment
      for (const comment of issueComments) {
        if (comment.reactions && comment.reactions.eyes && comment.reactions.eyes > 0) {
          // Get who reacted with eyes
          try {
            const { data: reactions } = await this.octokit.reactions.listForIssueComment({
              owner,
              repo,
              comment_id: comment.id,
              content: 'eyes',
              per_page: 10,
            });
            
            for (const reaction of reactions) {
              const user = reaction.user?.login || '';
              if (user.includes('[bot]') || user.toLowerCase().includes('bot')) {
                botsWithEyesReaction.add(user);
              }
            }
          } catch {
            // Reactions API might fail, ignore
          }
        }
      }
    } catch (err) {
      debug('Failed to check comment reactions', err);
    }

    const prStatus: PRStatus = {
      ciState: status.state as PRStatus['ciState'],
      inProgressChecks,
      pendingChecks,
      totalChecks,
      completedChecks,
      pendingReviewers,
      activelyReviewingBots,
      botsWithEyesReaction: Array.from(botsWithEyesReaction),
    };

    debug('PR status fetched', prStatus);
    return prStatus;
  }

  async getReviewThreads(owner: string, repo: string, prNumber: number): Promise<ReviewThread[]> {
    debug('Fetching review threads via GraphQL', { owner, repo, prNumber });
    
    // GraphQL query with pagination support
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                diffSide
                comments(first: 20) {
                  nodes {
                    id
                    databaseId
                    author {
                      login
                    }
                    body
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    `;

    interface GraphQLResponse {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: boolean;
              endCursor: string | null;
            };
            nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated?: boolean;
              path: string;
              line: number | null;
              diffSide: 'LEFT' | 'RIGHT' | null;
              comments: {
                nodes: Array<{
                  id: string;
                  databaseId?: number;
                  author: { login: string } | null;
                  body: string;
                  createdAt: string;
                }>;
              };
            }>;
          };
        };
      };
    }

    // Paginate through all review threads
    const allThreads: ReviewThread[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      pageCount++;
      const response: GraphQLResponse = await this.graphqlWithAuth<GraphQLResponse>(query, {
        owner,
        repo,
        pr: prNumber,
        cursor,
      });

      const reviewThreads = response.repository.pullRequest.reviewThreads;
      const pageInfo = reviewThreads.pageInfo;
      const nodes = reviewThreads.nodes;
      debug(`Fetched page ${pageCount} with ${nodes.length} threads`, { 
        hasNextPage: pageInfo.hasNextPage,
        cursor: pageInfo.endCursor?.slice(0, 20),
      });

      // WHY path fallback: GitHub GraphQL can return path: null for some review threads (e.g. edge cases).
      // Using a sentinel string avoids null propagating to join(workdir, path) / path.replace() downstream.
      for (const thread of nodes) {
        const path = thread.path ?? '(unknown file)';
        allThreads.push({
          id: thread.id,
          path,
          line: thread.line,
          diffSide: thread.diffSide,
          isResolved: thread.isResolved,
          isOutdated: thread.isOutdated ?? false,
          comments: thread.comments.nodes.map((comment) => ({
            id: comment.id,
            threadId: thread.id,
            author: comment.author?.login || 'unknown',
            body: comment.body,
            path,
            line: thread.line,
            diffSide: thread.diffSide,
            createdAt: comment.createdAt,
            isResolved: thread.isResolved,
            databaseId: comment.databaseId ?? null,
          })),
        });
      }

      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);

    debug(`Found ${allThreads.length} review threads total (${pageCount} pages)`);
    return allThreads;
  }

  async getReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
    debug('Getting review comments', { owner, repo, prNumber });
    const threads = await this.getReviewThreads(owner, repo, prNumber);
    const reviewComments: ReviewComment[] = [];

    for (const thread of threads) {
      // Get the first comment in each thread (the original review comment)
      const firstComment = [...thread.comments]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (firstComment) {
        reviewComments.push({
          id: firstComment.id,
          threadId: thread.id,
          author: firstComment.author,
          body: firstComment.body,
          path: thread.path,
          line: thread.line,
          createdAt: firstComment.createdAt,
          outdated: thread.isOutdated === true,
          databaseId: firstComment.databaseId ?? null,
        });
      }
    }

    debug(`Extracted ${reviewComments.length} review comments from threads`);

    // Also fetch issue comments (conversation tab) from review bots like claude[bot].
    // These bots post full markdown reviews as issue comments rather than inline
    // review threads, so we need to parse them to extract individual issues.
    try {
      const botComments = await this.getReviewBotIssueComments(owner, repo, prNumber);
      if (botComments.length > 0) {
        debug(`Found ${botComments.length} issue(s) from bot review comments`);
        reviewComments.push(...botComments);
      }
    } catch (err) {
      // Non-fatal: if issue comment parsing fails, we still have the thread comments.
      // WHY: Bot parsing can throw when path is null/undefined (e.g. parser edge case); we harden path below so this is rare.
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      debug('Failed to fetch/parse bot issue comments', { error: errMsg, stack: errStack });
    }

    const filtered = reviewComments.filter((c) => !isCodeRabbitMetaComment(c));
    if (filtered.length < reviewComments.length) {
      debug('Filtered out CodeRabbit meta comments', { before: reviewComments.length, after: filtered.length });
    }
    return filtered;
  }

  /**
   * Normalize bot login names for cleaner display in prompts.
   *
   * WHY: GitHub bot logins like `claude[bot]` display as `(claude)` after
   * stripping the suffix. Capitalizing to `(Claude)` is cleaner and matches
   * how users refer to these tools. Only applied in the REVIEW_BOTS
   * (issue-comment) path — NOT in getReviewThreads(), where raw logins are
   * used as identity keys for dedup and verification tracking.
   */
  private normalizeBotName(login: string): string {
    const lower = login.toLowerCase();
    if (lower.includes('claude')) return 'Claude';
    if (lower.includes('greptile')) return 'Greptile';
    if (lower.includes('copilot')) return 'Copilot';
    if (lower.includes('cursor')) return 'Cursor';
    return login.replace(/\[bot\]$/, '');
  }

  /**
   * Fetch issue comments (conversation tab) and extract review issues from bots.
   *
   * Some review bots (notably claude[bot]) post structured markdown reviews as
   * issue comments rather than inline review comments.
   *
   * WHY parse ALL comments (not just latest): Bots may post multiple comments across
   * re-reviews. Only reading the latest missed issues from earlier reviews that were
   * never re-posted — e.g. a bot's initial review flags 15 issues, but a later re-review
   * only mentions 3 new ones. The old code saw only the 3, missing the original 15.
   * Parsing all comments ensures zero missed issues. Downstream dedup (heuristic + LLM)
   * collapses any duplicates across comments.
   *
   * WHY noise filter before parsing: When reading all comments, test messages and
   * trigger commands would pollute the issue list. isBotNoiseComment runs first.
   *
   * WHY include non-bot "other" comments: PR conversation comments from humans or
   * other bots that are not in REVIEW_BOTS_PARSE were previously never fetched,
   * causing "no issues" when the user sees feedback in the PR conversation.
   */
  private async getReviewBotIssueComments(
    owner: string, repo: string, prNumber: number
  ): Promise<ReviewComment[]> {
    // Bots that post structured reviews as issue comments (we parse markdown into multiple issues).
    // Include all known review bots so we see everything; omit coderabbitai[bot] (inline-only, meta comment filtered).
    // WHY greptile-apps[bot]: GitHub uses this login for Greptile; greptile[bot] may be legacy or alternate.
    // WHY copilot-pull-request-reviewer[bot]: GitHub PR review bot; may post summary/table as issue comment.
    // WHY cursor[bot]: Cursor Bugbot / review bot; may post summary or inline-style as issue comment.
    const REVIEW_BOTS_PARSE: Array<string> = [
      'claude[bot]',
      'greptile[bot]',
      'greptile-apps[bot]',
      'copilot-pull-request-reviewer[bot]',
      'cursor[bot]',
    ];

    const allIssueComments: Array<{
      id: number;
      user: { login: string } | null;
      body: string;
      created_at: string;
    }> = [];

    // Paginate through all issue comments
    for await (const response of this.octokit.paginate.iterator(
      this.octokit.issues.listComments,
      { owner, repo, issue_number: prNumber, per_page: 100 }
    )) {
      for (const c of response.data) {
        if (c.body) {
          allIssueComments.push({
            id: c.id,
            user: c.user,
            body: c.body,
            created_at: c.created_at,
          });
        }
      }
    }

    const results: ReviewComment[] = [];

    for (const botLogin of REVIEW_BOTS_PARSE) {
      const botComments = allIssueComments
        .filter(c => c.user?.login === botLogin);

      if (botComments.length === 0) continue;

      const authorClean = this.normalizeBotName(botLogin);
      debug(`Parsing all ${botLogin} issue comments`, {
        count: botComments.length,
      });

      for (const comment of botComments) {
        if (isBotNoiseComment(comment.body)) {
          debug(`Skipping noise comment from ${botLogin}`, { id: comment.id, len: comment.body.length });
          continue;
        }

        const parsed = parseMarkdownReviewIssues(comment.body);
        if (parsed.length > 0) {
          for (let i = 0; i < parsed.length; i++) {
            const issue = parsed[i];
            // WHY path fallback: Parser can yield undefined path when regex capture is missing; downstream expects string.
            results.push({
              id: `ic-${comment.id}-${i}`,
              threadId: `ic-${comment.id}-${i}`,
              author: authorClean,
              body: issue.body,
              path: issue.path ?? '(PR comment)',
              line: issue.line,
              createdAt: comment.created_at,
            });
          }
        } else {
          // Non-structured comment (e.g. "Critical Bug 1: ...") — try to extract a file path
          const { path, line } = this.inferPathLineFromBody(comment.body);
          results.push({
            id: `ic-${comment.id}`,
            threadId: `ic-${comment.id}`,
            author: authorClean,
            body: comment.body,
            path: path ?? '(PR comment)',
            line,
            createdAt: comment.created_at,
          });
        }
      }
    }

    // WHY include "other" comments: PR conversation comments from humans or bots not in
    // REVIEW_BOTS_PARSE would otherwise be skipped, so "no issues" when the user sees feedback.
    // Include every other issue comment so we don't miss review feedback (e.g. #issuecomment-XXXX).
    const parsedBotLogins = new Set(REVIEW_BOTS_PARSE);
    const otherComments = allIssueComments.filter(
      c => !parsedBotLogins.has(c.user?.login ?? '')
        && !isCodeRabbitMetaComment({ author: c.user?.login ?? '', body: c.body })
    );
    // Same path fallback as bot loop: issue.path / path may be undefined from parser or inferPathLineFromBody.
    for (const c of otherComments) {
      const author = c.user?.login ?? 'unknown';
      const parsed = parseMarkdownReviewIssues(c.body);
      if (parsed.length > 0) {
        for (let i = 0; i < parsed.length; i++) {
          const issue = parsed[i];
          results.push({
            id: `ic-${c.id}-${i}`,
            threadId: `ic-${c.id}-${i}`,
            author,
            body: issue.body,
            path: issue.path ?? '(PR comment)',
            line: issue.line,
            createdAt: c.created_at,
          });
        }
      } else {
        const { path, line } = this.inferPathLineFromBody(c.body);
        results.push({
          id: `ic-${c.id}`,
          threadId: `ic-${c.id}`,
          author,
          body: c.body,
          path: path ?? '(PR comment)',
          line,
          createdAt: c.created_at,
        });
      }
    }
    if (otherComments.length > 0) {
      debug(`Included ${otherComments.length} other issue comment(s) (not from parsed review bots)`);
    }

    return results;
  }

  /**
   * Infer a single file path and optional line from a comment body.
   * Used for issue comments that aren't structured markdown (so we still have a path for snippets).
   */
  private inferPathLineFromBody(body: string): { path: string; line: number | null } {
    if (looksLikeSummaryRecapBlock(body)) {
      return { path: '(PR comment)', line: null };
    }

    const fullPathMatch = body.match(new RegExp(`\\b(${FULL_FILE_PATH_RE})(?::(\\d+))?\\b`, 'i'));
    if (fullPathMatch) {
      return {
        path: fullPathMatch[1],
        line: fullPathMatch[2] ? parseInt(fullPathMatch[2], 10) : null,
      };
    }

    const bareFileMatch = extractExplicitBareFileReference(body);
    if (bareFileMatch) {
      return bareFileMatch;
    }
    return { path: '(PR comment)', line: null };
  }

  async getFileContent(owner: string, repo: string, branch: string, path: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: branch,
      });

      if ('content' in data && data.type === 'file') {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch (error) {
      // File might not exist
      return null;
    }
  }

  /**
   * Submit a formal Pull Request Review so PRR appears in the PR's "Reviews" section
   * (like CodeRabbit or a human reviewer), not just as issue comments.
   *
   * WHY: Users expect to "request PRR as a reviewer" and see a Review card; without this
   * we only post comments and push commits. event: COMMENT = summary only (no approve/request changes).
   */
  async submitPullRequestReview(
    owner: string,
    repo: string,
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string
  ): Promise<void> {
    debug('Submitting PR review', { owner, repo, prNumber, event, bodyLength: body.length });
    await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event,
      body,
    });
    debug('PR review submitted');
  }

  /**
   * Post a comment on a PR (issue comment, not review comment).
   */
  async postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    debug('Posting comment to PR', { owner, repo, prNumber, bodyLength: body.length });
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    debug('Comment posted successfully');
  }

  /**
   * Reply to an inline review comment (creates a new comment in the same thread).
   * Uses the numeric databaseId of the comment to reply to, not the GraphQL node ID.
   * WHY databaseId: REST pulls.createReplyForReviewComment expects comment_id (numeric); GraphQL returns node IDs, so we store databaseId at fetch time and use it here.
   * On 404 (comment deleted), logs and returns without throwing so callers can continue.
   * WHY swallow 404: Comment may have been deleted by user or another tool; one missing reply should not fail the whole run.
   */
  async replyToReviewThread(
    owner: string,
    repo: string,
    prNumber: number,
    commentDatabaseId: number,
    body: string
  ): Promise<void> {
    debug('Replying to review thread', { owner, repo, prNumber, commentDatabaseId, bodyLength: body.length });
    try {
      await this.octokit.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: commentDatabaseId,
        body,
      });
      debug('Review thread reply posted');
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : undefined;
      if (status === 404) {
        debug('Review comment not found (404), skipping reply', { commentDatabaseId });
        return;
      }
      throw err;
    }
  }

  /**
   * Get comment authors in a review thread (for cross-run idempotency: skip if we already replied).
   * WHY: When PRR_BOT_LOGIN is set, callers check whether this thread already has a comment from that login; if so, we skip posting to avoid duplicate replies on re-runs.
   * owner/repo/prNumber are unused (GraphQL node(id) only needs threadId) but kept for API consistency and future use.
   */
  async getThreadComments(
    _owner: string,
    _repo: string,
    _prNumber: number,
    threadId: string
  ): Promise<Array<{ author: string }>> {
    const query = `
      query($threadId: ID!) {
        node(id: $threadId) {
          ... on PullRequestReviewThread {
            comments(first: 25) {
              nodes {
                author { login }
              }
            }
          }
        }
      }
    `;
    interface Res {
      node: {
        comments?: { nodes: Array<{ author: { login: string } | null }> };
      } | null;
    }
    const res = await this.graphqlWithAuth<Res>(query, { threadId });
    const comments = res?.node?.comments?.nodes ?? [];
    return comments.map((c) => ({ author: c.author?.login ?? 'unknown' }));
  }

  /**
   * Resolve a review thread (collapse it with a checkmark).
   * threadId is the GraphQL node ID (e.g. PRRT_kwDO...). WHY GraphQL: Resolve is a mutation; REST has no direct "resolve thread" endpoint, GraphQL resolveReviewThread does.
   * owner/repo are used only for debug logging; the mutation only needs threadId.
   */
  async resolveReviewThread(owner: string, repo: string, threadId: string): Promise<void> {
    debug('Resolving review thread', { owner, repo, threadId: threadId.slice(0, 20) });
    const mutation = `
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { isResolved }
        }
      }
    `;
    await this.graphqlWithAuth<{ resolveReviewThread: { thread: { isResolved: boolean } } }>(mutation, { threadId });
    debug('Review thread resolved');
  }

  /**
   * Check if a bot has ever commented on this PR.
   * Used to detect if CodeRabbit or other review bots are configured.
   */
  async hasBotCommented(owner: string, repo: string, prNumber: number, botNamePattern: string): Promise<boolean> {
    debug('Checking if bot has commented', { owner, repo, prNumber, botNamePattern });
    
    try {
      // Check issue comments
      const { data: issueComments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });
      
      const pattern = new RegExp(this.escapeRegex(botNamePattern), 'i');
      const hasIssueComment = issueComments.some(c => pattern.test(c.user?.login || ''));
      if (hasIssueComment) return true;
      
      // Check review comments
      const reviews = await this.octokit.paginate(
        this.octokit.pulls.listReviews,
        { owner, repo, pull_number: prNumber, per_page: 100 }
      );
      
      const hasReviewComment = reviews.some(r => pattern.test(r.user?.login || ''));
      return hasReviewComment;
    } catch (error) {
      debug('Failed to check bot comments', { error });
      return false;
    }
  }

  /**
   * Check if a bot has reviewed the current commit (HEAD).
   * Returns info about the bot's review status.
   */
  async getBotReviewStatus(
    owner: string, 
    repo: string, 
    prNumber: number, 
    botNamePattern: string,
    currentHeadSha: string
  ): Promise<{
    hasReviewed: boolean;
    isCurrentCommit: boolean;
    lastReviewSha?: string;
    lastReviewDate?: string;
  }> {
    debug('Checking bot review status', { owner, repo, prNumber, botNamePattern, currentHeadSha });
    
    const pattern = new RegExp(this.escapeRegex(botNamePattern), 'i');
    
    try {
      // Get all reviews to find bot's latest
      const { data: reviews } = await this.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      
      // Find bot's reviews
      const botReviews = reviews.filter(r => pattern.test(r.user?.login || ''));
      
      if (botReviews.length === 0) {
        // Check issue comments as fallback (some bots use issue comments)
        const issueComments = await this.octokit.paginate(
          this.octokit.issues.listComments,
          { owner, repo, issue_number: prNumber, per_page: 100 }
        );
        
        const botComments = issueComments.filter(c => pattern.test(c.user?.login || ''));
        
        if (botComments.length === 0) {
          return { hasReviewed: false, isCurrentCommit: false };
        }
        
        // Get latest bot comment
        const latestComment = botComments[botComments.length - 1];
        const body = latestComment.body ?? '';
        const curLower = currentHeadSha.toLowerCase();
        const fullInBody = extractFullCommitShaFromText(body);
        if (fullInBody) {
          return {
            hasReviewed: true,
            isCurrentCommit: fullInBody === curLower,
            lastReviewSha: fullInBody,
            lastReviewDate: latestComment.created_at,
          };
        }
        // CodeRabbit often includes at least a 7-char prefix in prose
        const mentionsCurrentSha = body.toLowerCase().includes(curLower.slice(0, 7));
        return {
          hasReviewed: true,
          isCurrentCommit: mentionsCurrentSha,
          lastReviewSha: mentionsCurrentSha ? currentHeadSha : undefined,
          lastReviewDate: latestComment.created_at,
        };
      }
      
      // Get latest bot review
      const latestReview = botReviews[botReviews.length - 1];
      
      // Check if review is for current commit
      // Reviews have commit_id field
      const reviewSha = latestReview.commit_id ?? undefined;
      const isCurrentCommit = reviewSha === currentHeadSha;
      
      return {
        hasReviewed: true,
        isCurrentCommit,
        lastReviewSha: reviewSha,
        lastReviewDate: latestReview.submitted_at ?? undefined,
      };
    } catch (error) {
      debug('Failed to get bot review status', { error });
      return { hasReviewed: false, isCurrentCommit: false };
    }
  }

  /**
   * Check CodeRabbit's review mode.
   * 
   * WHY multiple detection methods:
   * 1. PR comments - Most reliable. CodeRabbit posts "Review skipped - Auto reviews 
   *    are disabled" when in manual mode.
   * 2. .coderabbit.yaml - Config file may specify auto_review: false
   * 3. Default to unknown if neither found
   * 
   * Returns: 'auto' | 'manual' | 'unknown'
   */
  async getCodeRabbitMode(owner: string, repo: string, branch: string, prNumber?: number): Promise<'auto' | 'manual' | 'unknown'> {
    debug('Checking CodeRabbit mode', { owner, repo, branch, prNumber });
    
    // Method 1: Check PR comments for "Review skipped" message
    // WHY: This is the most reliable indicator - CodeRabbit explicitly says it skipped
    if (prNumber) {
      try {
        const comments = await this.octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: prNumber,
          per_page: 100,
        });
        
        for (const comment of comments.data) {
          const isCodeRabbit = comment.user?.login?.toLowerCase().includes('coderabbit') ||
                              comment.user?.login?.toLowerCase() === 'coderabbitai';
          if (!isCodeRabbit) continue;
          
          // Check for the "Review skipped" message that indicates manual mode
          if (comment.body?.includes('Review skipped') && 
              comment.body?.includes('Auto reviews are disabled')) {
            debug('Found "Review skipped" message - manual mode confirmed');
            return 'manual';
          }
          
          // If we find an actual review (not skipped), it's likely auto mode
          if (comment.body?.includes('## Summary') || 
              comment.body?.includes('## Walkthrough')) {
            debug('Found actual review - auto mode confirmed');
            return 'auto';
          }
        }
      } catch (e) {
        debug('Failed to check PR comments for CodeRabbit mode', { error: e });
      }
    }
    
    // Method 2: Try to read .coderabbit.yaml from repo
    const configContent = await this.getFileContent(owner, repo, branch, '.coderabbit.yaml');
    
    if (configContent) {
      debug('Found .coderabbit.yaml', { length: configContent.length });
      
      // Check for explicit auto_review: false (manual mode)
      if (/auto_review:\s*false/i.test(configContent)) {
        debug('CodeRabbit is in manual mode (auto_review: false)');
        return 'manual';
      }
      
      // Check for auto_review: true (auto mode)
      if (/auto_review:\s*true/i.test(configContent)) {
        debug('CodeRabbit is in auto mode (auto_review: true)');
        return 'auto';
      }
      
      // Check for request_changes_workflow which often indicates manual mode
      if (/request_changes_workflow:\s*true/i.test(configContent)) {
        debug('CodeRabbit has request_changes_workflow - likely manual');
        return 'manual';
      }
      
      // Config exists but doesn't specify - assume auto
      debug('CodeRabbit config exists but mode not explicit - assuming auto');
      return 'auto';
    }
    
    debug('No .coderabbit.yaml found and no definitive PR comments');
    return 'unknown';
  }

  /**
   * Get PR commits with timestamps.
   * Used to analyze bot response timing.
   */
  async getPRCommits(owner: string, repo: string, prNumber: number): Promise<Array<{
    sha: string;
    message: string;
    authoredDate: Date;
    committedDate: Date;
  }>> {
    debug('Fetching PR commits', { owner, repo, prNumber });
    
    const commits = await this.octokit.paginate(
      this.octokit.pulls.listCommits,
      { owner, repo, pull_number: prNumber, per_page: 100 }
    );
    
    return commits.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      authoredDate: new Date(c.commit.author?.date || c.commit.committer?.date || 0),
      committedDate: new Date(c.commit.committer?.date || c.commit.author?.date || 0),
    }));
  }

  /**
   * Get list of files changed in a PR (filename, status, additions, deletions).
   * WHY: Story and other tools need the file list for changelog context; paginates so large PRs are fully listed.
   */
  async getPRFiles(owner: string, repo: string, prNumber: number): Promise<Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>> {
    debug('Fetching PR files', { owner, repo, prNumber });
    const files = await this.octokit.paginate(
      this.octokit.pulls.listFiles,
      { owner, repo, pull_number: prNumber, per_page: 100 }
    );
    return files.map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
  }

  /**
   * Get list of files changed in a PR including unified diff patches.
   * WHY: split-plan needs actual diff content to reason about concerns; getPRFiles omits patch and other callers don't need it. We add a new method instead of changing getPRFiles to avoid breaking story and other consumers.
   * WHY patch optional: Binary files, files exceeding GitHub's diff size limit (~1MB), and rename-only files have no patch in the API response; always treat as optional.
   * WHY warn at 3000 files: GitHub caps pulls.listFiles at 3000; user should know the list may be truncated when analyzing mega-PRs.
   */
  async getPRFilesWithPatches(owner: string, repo: string, prNumber: number): Promise<Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | undefined;
  }>> {
    debug('Fetching PR files with patches', { owner, repo, prNumber });
    const files = await this.octokit.paginate(
      this.octokit.pulls.listFiles,
      { owner, repo, pull_number: prNumber, per_page: 100 }
    );
    if (files.length >= 3000) {
      console.warn(`Warning: PR files list may be truncated (GitHub caps at 3,000; got ${files.length.toLocaleString()})`);
    }
    return files.map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: (f as { patch?: string }).patch,
    }));
  }

  /**
   * List open PRs in the repo, optionally filtered by base branch.
   * WHY: split-plan needs "buckets" (existing open PRs) to route changes to; filtering by base ensures we only show PRs in the same branch world (e.g. v2-develop vs v3-develop). Caller caps count and truncates body to avoid context overflow.
   * WHY base is branch name: GitHub API expects the branch ref name (e.g. "main"), not refs/heads/main; invalid base returns empty results instead of erroring.
   * WHY paginate: Busy repos can have 100+ open PRs; single list() would miss many. excludePRNumber is applied after fetch so the target PR is not offered as a bucket.
   */
  async getOpenPRs(
    owner: string,
    repo: string,
    baseBranch?: string,
    excludePRNumber?: number
  ): Promise<Array<{
    number: number;
    title: string;
    body: string;
    branch: string;
    baseBranch: string;
    author: string;
  }>> {
    debug('Listing open PRs', { owner, repo, baseBranch: baseBranch ?? '(all)', excludePRNumber });
    const params: { owner: string; repo: string; state: 'open'; base?: string; per_page: number } = {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    };
    if (baseBranch) params.base = baseBranch;
    const list = await this.octokit.paginate(this.octokit.pulls.list, params);
    let result = list.map(pr => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      author: pr.user?.login ?? 'unknown',
    }));
    if (excludePRNumber != null) {
      result = result.filter(pr => pr.number !== excludePRNumber);
    }
    return result;
  }

  /**
   * List titles of recently updated (merged/closed) PRs. Used by split-plan to infer repo PR title style.
   * WHY state closed: Merged and closed PRs reflect the repo's accepted style; open PRs may be WIP.
   */
  async getRecentPRTitles(owner: string, repo: string, limit: number = 30): Promise<string[]> {
    debug('Fetching recent PR titles for style', { owner, repo, limit });
    const { data } = await this.octokit.pulls.list({
      owner,
      repo,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(limit, 100),
    });
    return data.map(pr => pr.title).filter(Boolean);
  }

  /**
   * Create a pull request. head = branch with changes, base = branch to merge into.
   * WHY: split-exec creates new branches and opens PRs for each "New PR" split in the plan.
   */
  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body?: string
  ): Promise<{ number: number; url: string }> {
    debug('Creating pull request', { owner, repo, head, base, title: title.slice(0, 50) });
    const { data } = await this.octokit.pulls.create({
      owner,
      repo,
      head,
      base,
      title,
      body: body ?? '',
    });
    return { number: data.number, url: data.html_url ?? '' };
  }

  /**
   * Delay between pagination pages when fetching branch commit history.
   * WHY: Keeps us under GitHub's rate limits (5000 req/h authenticated) when fetching full history; avoids hammering the API.
   */
  private static readonly COMMIT_FETCH_PAGE_DELAY_MS = 400;

  /**
   * Get commit history for a branch (or ref). Returns commits in chronological order (oldest first).
   * WHY oldest first: Narrative and changelog are easier when the model sees "then this, then that";
   * List Commits API returns newest first so we reverse after slicing to maxCommits.
   * Pages are rate-limited (COMMIT_FETCH_PAGE_DELAY_MS between pages) to avoid hitting GitHub limits.
   * @param maxCommits - Cap on number of commits to fetch; 0 or omitted = no cap (fetch entire branch history).
   */
  async getBranchCommitHistory(
    owner: string,
    repo: string,
    branch: string,
    maxCommits: number = 0
  ): Promise<Array<{ sha: string; message: string; authoredDate: Date; committedDate: Date }>> {
    const cap = maxCommits > 0 ? maxCommits : undefined;
    debug('Fetching branch commit history', { owner, repo, branch, maxCommits: cap ?? 'no cap' });
    const commits: Array<{ sha: string; message: string; authoredDate: Date; committedDate: Date }> = [];
    let pageCount = 0;
    for await (const { data: commitsPage } of this.octokit.paginate.iterator(this.octokit.repos.listCommits, {
      owner,
      repo,
      sha: branch,
      per_page: 100,
    })) {
      if (pageCount > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, GitHubAPI.COMMIT_FETCH_PAGE_DELAY_MS)
        );
      }
      pageCount += 1;
      for (const c of commitsPage) {
        commits.push({
          sha: c.sha,
          message: c.commit.message,
          authoredDate: new Date(c.commit.author?.date ?? c.commit.committer?.date ?? 0),
          committedDate: new Date(c.commit.committer?.date ?? c.commit.author?.date ?? 0),
        });
        if (cap !== undefined && commits.length >= cap) break;
      }
      if (cap !== undefined && commits.length >= cap) break;
    }
    return commits.reverse();
  }

  /**
   * Get the repository’s default branch (e.g. main, master).
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    debug('Fetching default branch', { owner, repo });
    const { data } = await this.octokit.repos.get({ owner, repo });
    return data.default_branch;
  }

  /**
   * Compare a branch (or ref) against a base ref. Returns commits and files changed.
   * Uses GitHub compare API (BASE...HEAD). Commits are in chronological order.
   * Note: API returns up to 250 commits per page; very large branch diffs may be truncated.
   */
  async getBranchComparison(
    owner: string,
    repo: string,
    baseRef: string,
    headRef: string
  ): Promise<{
    commits: Array<{ sha: string; message: string; authoredDate: Date; committedDate: Date }>;
    files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  }> {
    debug('Comparing branch', { owner, repo, baseRef, headRef });
    const basehead = `${baseRef}...${headRef}`;
    const { data } = await this.octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
      per_page: 100,
    });
    const commits = (data.commits ?? []).map(c => ({
      sha: c.sha,
      message: c.commit.message,
      authoredDate: new Date(c.commit.author?.date ?? c.commit.committer?.date ?? 0),
      committedDate: new Date(c.commit.committer?.date ?? c.commit.author?.date ?? 0),
    }));
    const files = (data.files ?? []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
    return { commits, files };
  }

  /**
   * Compare two branches in both directions; return commits and files from older → newer (chronological).
   * Prefers the direction where primaryBranch is the "newer" ref so the story is about the primary branch.
   * WHY prefer primary: The first argument is the branch the user cares about; when branches have diverged,
   * we tell the story of that branch (commits in primary not in other), not the other way around.
   */
  async getBranchComparisonEitherDirection(
    owner: string,
    repo: string,
    primaryBranch: string,
    otherBranch: string
  ): Promise<{
    commits: Array<{ sha: string; message: string; authoredDate: Date; committedDate: Date }>;
    files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
    olderRef: string;
    newerRef: string;
  }> {
    const [primaryToOther, otherToPrimary] = await Promise.all([
      this.getBranchComparison(owner, repo, primaryBranch, otherBranch),
      this.getBranchComparison(owner, repo, otherBranch, primaryBranch),
    ]);
    const withPrimaryAsNewer = {
      ...otherToPrimary,
      olderRef: otherBranch,
      newerRef: primaryBranch,
    };
    const withPrimaryAsOlder = {
      ...primaryToOther,
      olderRef: primaryBranch,
      newerRef: otherBranch,
    };
    if (otherToPrimary.commits.length > 0 && primaryToOther.commits.length === 0) {
      return withPrimaryAsNewer;
    }
    if (primaryToOther.commits.length > 0 && otherToPrimary.commits.length === 0) {
      return withPrimaryAsOlder;
    }
    if (otherToPrimary.commits.length > 0) {
      return withPrimaryAsNewer;
    }
    return withPrimaryAsOlder;
  }

  /**
   * Compare branch to default; if 0 commits (branch equals or is behind default), try base "main" then "master".
   * WHY: Repos may use "develop" as default while the branch of interest diverged from "main"; fallback gives a non-empty diff.
   * Story's single-branch mode now uses getBranchCommitHistory instead; this remains for potential future compare-to-default use.
   */
  async getBranchComparisonWithFallback(
    owner: string,
    repo: string,
    defaultBase: string,
    headRef: string
  ): Promise<{
    commits: Array<{ sha: string; message: string; authoredDate: Date; committedDate: Date }>;
    files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
    baseRef: string;
  }> {
    const tryBase = async (base: string) => {
      const out = await this.getBranchComparison(owner, repo, base, headRef);
      return { ...out, baseRef: base };
    };
    let result = await tryBase(defaultBase);
    if (result.commits.length > 0) return result;
    for (const fallback of ['main', 'master']) {
      if (fallback === defaultBase) continue;
      try {
        const next = await tryBase(fallback);
        if (next.commits.length > 0) {
          debug('Branch compare: 0 commits vs default; using base', { base: fallback });
          return next;
        }
      } catch {
        // base ref may not exist (404)
      }
    }
    return result;
  }

  /**
   * Analyze bot response timing on a PR.
   * 
   * WHY: Understanding how long bots take to respond helps us know:
   * 1. How long to wait after pushing before checking for reviews
   * 2. Whether we should trigger manual review or wait for auto
   * 3. If a bot seems stuck/slow
   * 
   * This analyzes:
   * - Time between commits and bot comments/reviews
   * - Time between @coderabbitai mentions and bot responses
   *
   * @param commits - Optional; when provided (e.g. from startup), avoids a duplicate fetch.
   */
  async analyzeBotResponseTiming(
    owner: string,
    repo: string,
    prNumber: number,
    commits?: Array<{ sha: string; message: string; authoredDate: Date; committedDate: Date }>
  ): Promise<BotResponseTiming[]> {
    debug('Analyzing bot response timing', { owner, repo, prNumber });

    const commitList = commits ?? await this.getPRCommits(owner, repo, prNumber);
    if (commitList.length === 0) {
      debug('No commits found');
      return [];
    }
    
    // Get all issue comments (includes bot summary comments)
    const issueComments = await this.octokit.paginate(
      this.octokit.issues.listComments,
      { owner, repo, issue_number: prNumber, per_page: 100 }
    );
    
    // Get reviews (includes bot reviews)
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    
    // Identify bot comments/reviews and their timestamps
    const botActivity: Array<{
      botName: string;
      timestamp: Date;
      type: 'comment' | 'review';
      commitSha?: string;  // For reviews that reference a specific commit
    }> = [];
    
    // Collect bot issue comments
    for (const comment of issueComments) {
      const author = comment.user?.login || '';
      const isBot = author.includes('[bot]') || author.toLowerCase().includes('bot');
      if (isBot && comment.created_at) {
        botActivity.push({
          botName: author,
          timestamp: new Date(comment.created_at),
          type: 'comment',
        });
      }
    }
    
    // Collect bot reviews (these have commit_id!)
    for (const review of reviews) {
      const author = review.user?.login || '';
      const isBot = author.includes('[bot]') || author.toLowerCase().includes('bot');
      if (isBot && review.submitted_at) {
        botActivity.push({
          botName: author,
          timestamp: new Date(review.submitted_at),
          type: 'review',
          commitSha: review.commit_id || undefined,
        });
      }
    }
    
    if (botActivity.length === 0) {
      debug('No bot activity found');
      return [];
    }

    // Group by bot
    const botGroups = new Map<string, typeof botActivity>();
    for (const activity of botActivity) {
      const group = botGroups.get(activity.botName) || [];
      group.push(activity);
      botGroups.set(activity.botName, group);
    }

    // Calculate response times for each bot (use commitList)
    const results: BotResponseTiming[] = [];

    for (const [botName, activities] of botGroups) {
      const responseTimes: BotResponseTiming['responseTimes'] = [];

      for (const activity of activities) {
        // Find which commit this activity is responding to
        let targetCommit: (typeof commitList)[0] | undefined;

        if (activity.commitSha) {
          // Review references a specific commit
          targetCommit = commitList.find(c => c.sha === activity.commitSha);
        } else {
          // Comment - find the most recent commit before this comment
          // that doesn't already have a response from this bot
          const activityTime = activity.timestamp.getTime();
          const respondedShas = new Set(responseTimes.map(rt => rt.commitSha));

          targetCommit = commitList
            .filter(c => c.committedDate.getTime() < activityTime && !respondedShas.has(c.sha))
            .sort((a, b) => b.committedDate.getTime() - a.committedDate.getTime())[0];
        }
        
        if (targetCommit) {
          const delayMs = activity.timestamp.getTime() - targetCommit.committedDate.getTime();
          // Only count positive delays (bot responded after commit) and reasonable times (< 1 hour)
          if (delayMs > 0 && delayMs < 60 * 60 * 1000) {
            responseTimes.push({
              commitSha: targetCommit.sha,
              commitTime: targetCommit.committedDate,
              responseTime: activity.timestamp,
              delayMs,
            });
          }
        }
      }
      
      if (responseTimes.length > 0) {
        const delays = responseTimes.map(rt => rt.delayMs);
        results.push({
          botName,
          responseCount: responseTimes.length,
          minResponseMs: Math.min(...delays),
          avgResponseMs: Math.round(delays.reduce((a, b) => a + b, 0) / delays.length),
          maxResponseMs: Math.max(...delays),
          responseTimes,
        });
      }
    }
    
    debug('Bot response timing analyzed', results.map(r => ({
      bot: r.botName,
      count: r.responseCount,
      min: r.minResponseMs,
      avg: r.avgResponseMs,
      max: r.maxResponseMs,
    })));
    
    return results;
  }

  /**
   * Trigger CodeRabbit review if needed.
   * - Detects if CodeRabbit is configured for this repo
   * - Checks if it has already reviewed the current commit
   * - Checks if it's in manual mode (needs trigger) vs auto mode
   * - Only triggers if needed
   * 
   * Returns: { triggered: boolean, mode: string, reason: string, reviewStatus: ... }
   */
  async triggerCodeRabbitIfNeeded(
    owner: string, 
    repo: string, 
    prNumber: number,
    branch: string,
    currentHeadSha: string,
    /** Reuse mode from earlier check to avoid re-detection (e.g. manual → unknown) and redundant trigger messaging. */
    cachedMode?: string
  ): Promise<{ 
    triggered: boolean; 
    mode: string; 
    reason: string;
    reviewedCurrentCommit: boolean;
    /** Latest CodeRabbit review `commit_id` (or undefined if only inferred from issue comments). */
    botReviewCommitSha?: string;
  }> {
    debug('Checking if CodeRabbit trigger needed', { owner, repo, prNumber, currentHeadSha, cachedMode });
    
    // Check CodeRabbit's current review status
    const reviewStatus = await this.getBotReviewStatus(owner, repo, prNumber, 'coderabbit', currentHeadSha);
    
    if (!reviewStatus.hasReviewed) {
      return { 
        triggered: false, 
        mode: 'none', 
        reason: 'CodeRabbit not detected on this PR',
        reviewedCurrentCommit: false,
      };
    }
    
    // If CodeRabbit has already reviewed the current commit, no need to trigger
    if (reviewStatus.isCurrentCommit) {
      return {
        triggered: false,
        mode: 'up-to-date',
        reason: `CodeRabbit already reviewed current commit (${currentHeadSha.substring(0, 7)})`,
        reviewedCurrentCommit: true,
        botReviewCommitSha: reviewStatus.lastReviewSha ?? currentHeadSha,
      };
    }
    
    // CodeRabbit exists but hasn't reviewed current commit. Use cached mode from setup when available.
    const mode = cachedMode ?? await this.getCodeRabbitMode(owner, repo, branch, prNumber);
    const staleSha = reviewStatus.lastReviewSha;
    
    if (mode === 'auto') {
      // Auto mode - CodeRabbit should pick up changes automatically
      // But we can still check if it's been a while
      return { 
        triggered: false, 
        mode: 'auto', 
        reason: `CodeRabbit (auto mode) reviewing older commit (${staleSha?.substring(0, 7) || '?'}) - should auto-update`,
        reviewedCurrentCommit: false,
        botReviewCommitSha: staleSha,
      };
    }
    
    // Manual mode or unknown - trigger it for the new commit
    debug('Triggering CodeRabbit review for new commit', { mode, currentHeadSha });
    await this.postComment(owner, repo, prNumber, '@coderabbitai review');
    
    return { 
      triggered: true, 
      mode: mode === 'manual' ? 'manual' : 'unknown',
      reason: mode === 'manual' 
        ? `CodeRabbit (manual mode) - triggered review for new commit (${currentHeadSha.substring(0, 7)})`
        : `CodeRabbit needs trigger for new commit (${currentHeadSha.substring(0, 7)})`,
      reviewedCurrentCommit: false,
      botReviewCommitSha: staleSha,
    };
  }

  /**
   * Check if review bots are rate-limited by scanning recent issue comments
   * for rate-limit / review-cancelled / review-paused signals.
   *
   * CodeRabbit (and other bots) post issue comments when they can't review
   * due to rate limits. When prr pushes many commits in rapid succession the
   * bot may throttle reviews, leaving a notice that disappears once it
   * catches up. Detecting this lets prr back off and wait longer.
   *
   * Returns per-bot rate-limit status with the message found (if any).
   */
  async checkBotRateLimits(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ bot: string; rateLimited: boolean; message?: string }>> {
    const results: Array<{ bot: string; rateLimited: boolean; message?: string }> = [];

    try {
      // Single-issue list endpoint supports since, per_page (max 100), and pagination.
      // Fetch all comments in the rate-limit window so we don't miss recent ones on large threads.
      const windowMs = 30 * 60 * 1000;
      const since = new Date(Date.now() - windowMs).toISOString();
      const cutoff = new Date(Date.now() - windowMs);
      const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
        since,
      // Review: paginate retrieves all comments, ensuring we process the latest ones correctly.
      });
      const commentsNewestFirst = [...comments].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      for (const bot of BOT_PATTERNS) {
        const botComments = commentsNewestFirst.filter(
          c => bot.pattern.test(c.user?.login || '') &&
               new Date(c.created_at) > cutoff
        );

        let rateLimited = false;
        let message: string | undefined;

        for (const comment of botComments) {
          const body = comment.body || '';
          for (const { pattern, name: patternName } of RATE_LIMIT_PATTERNS) {
            if (pattern.test(body)) {
              rateLimited = true;
              const match = body.match(pattern);
              // Extract a readable snippet: prefer sentence boundary, else wider window (80 before/after) so we don't cut mid-word.
              if (match) {
                const start = match.index ?? 0;
                const end = start + (match[0]?.length ?? 0);
                const before = Math.max(0, start - 80);
                const after = Math.min(body.length, end + 80);
                const snippet = body.substring(before, after).trim();
                const sentenceStart = snippet.lastIndexOf('.', start - before) + 1;
                const sentenceEnd = snippet.indexOf('.', end - before);
                message = sentenceEnd > sentenceStart
                  ? snippet.substring(sentenceStart, sentenceEnd > 0 ? sentenceEnd + 1 : undefined).trim()
                  : snippet;
              }
              debug('Bot rate-limit detected', {
                bot: bot.name,
                commentId: comment.id,
                pattern: patternName,
                bodySnippet: (comment.body || '').slice(0, 350),
              });
              break;
            }
          }
          if (rateLimited) break;
        }

        results.push({ bot: bot.name, rateLimited, message });
      }
    } catch (error) {
      debug('Failed to check bot rate limits', { error });
    }

    return results;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Markdown review comment parser
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface ParsedIssue {
  body: string;
  path: string;
  line: number | null;
}

/**
 * File path + optional line pattern.  Matches patterns like:
 *   `lib/cache/client.ts:470`
 *   `app/api/auth/siwe/verify/route.ts:155`
 *   verify/route.ts:304-376
 *   nonce/route.ts:49
 *   (lib/cache/consume.ts:15-20)
 *
 * Uses [\w./-]+ for path chars to avoid capturing leading punctuation like `(`.
 * Requires at least one `/` to avoid matching bare words like `client.ts`.
 */
const FILE_EXTENSIONS = '(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml)';
const FULL_FILE_PATH_RE = `[\\w.-]+(?:/[\\w./-]+)+\\.${FILE_EXTENSIONS}`;
const BARE_FILE_RE = `[\\w.-]+\\.${FILE_EXTENSIONS}`;
const FILE_LINE_RE = new RegExp(
  `(?:[\`(])?(?:\\./)?(${FULL_FILE_PATH_RE})(?::(\\d+))?(?:[:-]\\d+)?(?:[\`)])?`
);
// Review: full-path parser requires a `/` to avoid treating summary prose like `banner.ts`
// as a repo-root file. Bare filenames are handled separately with stronger context checks.
// WHY split the parsers: Recap tables often mention `reply.ts`/`logger.ts` as labels, not
// actionable file references. Treating full paths and bare filenames the same produced many
// fake "file no longer exists" issues from summary comments.

/** Detect reviewer recap/status tables before path inference. WHY: filtering summary prose here is cheaper and safer than turning it into fake issues and cleaning it up later. */
function looksLikeSummaryRecapBlock(text: string): boolean {
  const head = text.slice(0, 1000);
  if (/\|\s*(?:Location|File(?:\(s\))?|Cohort\s*\/\s*File\(s\)|Summary|Status|Suggestion)\s*\|/i.test(head)) {
    return true;
  }
  return /(?:^|\n)\s*#{1,3}\s*Summary\b/i.test(head) && /\b(?:fixed|addressed|still missing|warning|inconclusive)\b/i.test(head);
}

/** Bare filenames are only accepted in stronger contexts. WHY: a lone `banner.ts` inside recap prose is weak evidence, but "add tests for `banner.ts`" is actionable. */
function extractExplicitBareFileReference(text: string): { path: string; line: number | null } | null {
  const explicit = text.match(
    new RegExp(`(?:\\b(?:in|for|to|on|within|tests?\\s+for|file)\\b\\s*[\`"]?)(${BARE_FILE_RE})(?::(\\d+))?`, 'i')
  );
  if (explicit) {
    return {
      path: explicit[1],
      line: explicit[2] ? parseInt(explicit[2], 10) : null,
    };
  }
  const backtick = text.match(new RegExp('`(' + BARE_FILE_RE + ')(?::(\\d+))?`', 'i'));
  if (!backtick) return null;
  return {
    path: backtick[1],
    line: backtick[2] ? parseInt(backtick[2], 10) : null,
  };
}

/**
 * Section headers to SKIP entirely — these never contain issues.
 * Everything else gets processed (we rely on items having file:line refs to filter).
 */
const SKIP_SECTION_KEYWORDS = [
  'overview', 'summary', 'verdict', 'approve', 'overall assessment',
];

/**
 * Parse a structured markdown review comment (as posted by claude[bot] etc.)
 * into individual file-specific issues.
 *
 * Strategy:
 * 1. Split the markdown into sections by ## / ### headers
 * 2. Identify sections that contain issue/problem content (vs. "strengths")
 * 3. Within issue sections, split by numbered items (### N. or **N.)
 * 4. For each item, extract the first file:line reference as the location
 * 5. Return each item as a ParsedIssue with path, line, and body
 */
export function parseMarkdownReviewIssues(markdown: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  const lines = markdown.split('\n');

  // Phase 1: Split into top-level sections by ## headers
  const sections: Array<{ header: string; body: string }> = [];
  let currentHeader = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (currentBody.length > 0) {
        sections.push({ header: currentHeader, body: currentBody.join('\n') });
      }
      currentHeader = h2Match[1];
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    sections.push({ header: currentHeader, body: currentBody.join('\n') });
  }

  // Phase 2: Process sections, extracting issue items with file references.
  // We skip only known non-issue sections (verdicts, summaries). Everything
  // else gets processed — items without file:line refs are naturally filtered.
  for (const section of sections) {
    const headerLower = section.header.toLowerCase();
    if (SKIP_SECTION_KEYWORDS.some(kw => headerLower.includes(kw))) continue;

    // Within a section, focus on sub-areas that contain issues.
    // Claude uses two patterns:
    //   Format A: items directly under the ## header (e.g. "## 🚨 BLOCKING ISSUES")
    //   Format B: **Issues:** / **Concerns:** sub-headers within a larger section
    // We extract items from both.
    const textToProcess = extractIssueSubsections(section.body);

    // Phase 3: Split into individual items
    const items = splitIntoItems(textToProcess);

    for (const item of items) {
      // Phase 4: Extract file:line from the item.
      // Clean the body first so both branches can use it (path-less and path-having).
      const body = item.trim().replace(/\n{3,}/g, '\n\n');
      if (body.length < 20) continue; // Skip trivially short items
      if (looksLikeSummaryRecapBlock(body)) continue;

      const locationMatch = item.match(
        new RegExp(`\\*\\*Locations?:\\*\\*\\s*\`?(\\w[\\w./-]*\\/[\\w./-]+\\.${FILE_EXTENSIONS})(?::(\\d+))?`)
      );
      const fileMatch = locationMatch || item.match(FILE_LINE_RE);
      const bareFileMatch = !fileMatch ? extractExplicitBareFileReference(item) : null;

      if (!fileMatch && !bareFileMatch) {
        // Path-less item: include if body is substantial and contains actionable language.
        // Downstream solvability dismisses (PR comment) at zero LLM cost if truly unfixable.
        // WHY 100 chars: shorter items are usually section intros ("Here are the issues:") not real issues.
        // WHY actionable regex: filters out pure prose summaries that happen to be long.
        if (body.length >= 100 && /\b(?:fix|bug|error|missing|should|must|add|remove|change|update|incorrect|broken|crash|fail|import|undefined|null)\b/i.test(body)) {
          issues.push({ body, path: '(PR comment)', line: null });
        }
        continue;
      }

      // WHY optional chaining: when bareFileMatch is set, fileMatch can be null; accessing fileMatch[2] would throw. Fallbacks guarantee string path and null-safe line.
      const path = (bareFileMatch?.path ?? fileMatch?.[1]) ?? '(PR comment)';
      const line = bareFileMatch?.line ?? (fileMatch?.[2] ? parseInt(fileMatch[2], 10) : null);
      issues.push({ body, path, line });
    }
  }

  return issues;
}

/**
 * Extract issue-bearing subsections from a section body.
 *
 * Claude's Format B uses subsections like:
 *   **Strengths:**
 *   - ...
 *   **Issues:**
 *   1. ...
 *
 * We keep only lines under sub-headers that indicate issues/concerns,
 * plus any ### subsections (which are always issue-level in Format A).
 * If there are no **Label:** sub-headers, returns the body as-is.
 */
function extractIssueSubsections(body: string): string {
  const ISSUE_LABELS = ['issue', 'concern', 'problem', 'bug', 'critical', 'warning', 'fix'];
  const SKIP_LABELS = ['strength', 'good', 'strong', 'highlight'];

  // Check if this section uses **Label:** sub-headers (any case, e.g. **issues:** or **Issues:**)
  const hasSubHeaders = /^\*\*[A-Za-z][\w\s]*:\*\*\s*$/m.test(body);
  if (!hasSubHeaders) return body;

  const lines = body.split('\n');
  const result: string[] = [];
  // Content before the first sub-header is treated as issue content by default.
  let inIssueBlock = true;
  let inSkipBlock = false;

  for (const line of lines) {
    const subHeaderMatch = line.match(/^\*\*([^*]+):\*\*\s*$/);
    if (subHeaderMatch) {
      const label = subHeaderMatch[1].toLowerCase();
      inIssueBlock = ISSUE_LABELS.some(kw => label.includes(kw));
      inSkipBlock = SKIP_LABELS.some(kw => label.includes(kw));
      continue;
    }

    // ### headers are always issue items (Format A under Format B sections)
    if (/^###\s+/.test(line)) {
      inIssueBlock = true;
      inSkipBlock = false;
    }

    if (inIssueBlock && !inSkipBlock) {
      result.push(line);
    }
  }

  return result.length > 0 ? result.join('\n') : body;
}

/**
 * Split a section body into individual items.
 * Looks for ### headers, **N. patterns, or N. ** patterns.
 */
function splitIntoItems(body: string): string[] {
  const items: string[] = [];
  const lines = body.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    // New item boundary patterns:
    //   ### N. **Title**  (Format A)
    //   **N. Title**      (Format A variant)
    //   N. **Title**      (Format B)
    const isNewItem = /^###\s+/.test(line)
      || /^\*\*\d+[\.\)]\s+/.test(line)
      || /^\d+\.\s+\*\*/.test(line);

    if (isNewItem && current.length > 0) {
      items.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0) {
    items.push(current.join('\n'));
  }

  return items;
}
