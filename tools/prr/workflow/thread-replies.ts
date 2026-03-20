/**
 * Post short replies on GitHub review threads when PRR fixes or dismisses an issue.
 * One reply per thread, as soon as we know the outcome; repliedThreadIds prevents duplicates.
 * WHY one reply per thread: Keeps noise low and leaves room for human follow-up in the same thread.
 * WHY opt-in (caller passes replyToThreads): Default runs stay unchanged; posting to GitHub is a conscious choice.
 */

import type { ReviewComment } from '../github/types.js';
import type { PRInfo } from '../github/types.js';
import type { DismissedIssue } from '../state/types.js';
import type { GitHubAPI } from '../github/api.js';
import { debug } from '../../../shared/logger.js';
import chalk from 'chalk';

/**
 * Dismissed categories that get a reply.
 * WHY: When --reply-to-threads is used, every considered thread should get a short reply so reviewers see PRR touched it. Previously only a subset got replies (e.g. remaining/exhausted), so runs that dismissed as path-unresolved or missing-file posted nothing.
 */
const DISMISSED_CATEGORIES_WITH_REPLY = new Set<string>([
  'already-fixed',
  'stale',
  'not-an-issue',
  'false-positive',
  'remaining',
  'exhausted',
  'path-unresolved',  // e.g. .d.ts fragment — reply so thread has visible feedback
  'missing-file',    // file not found — reply so thread has visible feedback
  'chronic-failure',
  'duplicate',
  'file-unchanged',
]);

export interface PostThreadRepliesOptions {
  comments: ReviewComment[];
  verifiedCommentIds: Set<string>;
  dismissedIssues: DismissedIssue[];
  commitSha: string;
  repliedThreadIds: Set<string>;
  github: GitHubAPI;
  prInfo: PRInfo;
  replyToThreads: boolean;
  resolveThreads?: boolean;
}

function shortSha(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

/** WHY: Dismissal reasons can be long; one line + truncation keeps reply bodies readable and under GitHub UX expectations. */
function oneLine(text: string, maxLen: number = 200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= maxLen ? one : one.slice(0, maxLen - 3) + '...';
}

/** Extract status and response body from an error (GitHub API often returns 422 Validation Failed with details in response). */
function getErrorDetails(err: unknown): { status?: number; message: string; body: unknown } {
  const obj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const status = typeof obj.status === 'number' ? obj.status : (obj.response && typeof obj.response === 'object' && 'status' in obj.response ? (obj.response as { status: number }).status : undefined);
  const message = obj.message != null ? String(obj.message) : String(err);
  const body = obj.response && typeof obj.response === 'object' && 'data' in obj.response
    ? (obj.response as { data: unknown }).data
    : obj.response ?? obj;
  return { status, message, body };
}

/**
 * Post reply; on 422/Validation Failed log full error body and retry once with shortened message.
 * WHY full error: GitHub's reason (body format, thread state) is in the response; we log it so we can fix.
 * WHY retry with short fallback: Long or special characters in the first message can trigger validation; "Addressed." / "No change needed." often succeed so the thread still gets a reply.
 * Returns { ok, is422 } so caller can count consecutive 422s and bail (output.log audit).
 */
async function postReplyWithRetry(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  databaseId: number,
  threadId: string,
  body: string,
  fallbackBody: string
): Promise<{ ok: boolean; is422?: boolean }> {
  try {
    await github.replyToReviewThread(owner, repo, prNumber, databaseId, body);
    return { ok: true };
  } catch (err) {
    const { status, message, body: errBody } = getErrorDetails(err);
    const validationFailed = status === 422 || /validation failed/i.test(message);
    if (validationFailed) {
      debug('Validation Failed posting reply — full error', { threadId, status, message, responseBody: errBody });
    } else {
      debug('Failed to post reply', { threadId, error: message });
    }
    if (fallbackBody !== body) {
      try {
        await github.replyToReviewThread(owner, repo, prNumber, databaseId, fallbackBody);
        return { ok: true };
      } catch (retryErr) {
        const retryDetails = getErrorDetails(retryErr);
        if (retryDetails.status === 422 || /validation failed/i.test(retryDetails.message)) {
          debug('Validation Failed on retry — full error', { threadId, status: retryDetails.status, responseBody: retryDetails.body });
        } else {
          debug('Failed to post reply (retry)', { threadId, error: retryDetails.message });
        }
        return { ok: false, is422: validationFailed || (retryDetails.status === 422 || /validation failed/i.test(retryDetails.message)) };
      }
    }
    return { ok: false, is422: validationFailed };
  }
}

/** Return type: when replyToThreads is true, returns counts for user-visible summary on high failure rate (output.log audit). */
export interface PostThreadRepliesResult {
  attempted: number;
  replied: number;
}

/** Consecutive 422s after which we stop attempting further replies (avoids retry storm; output.log audit). */
const MAX_CONSECUTIVE_422_BEFORE_STOP = 3;

/**
 * Post a reply on each review thread that was verified-fixed or dismissed (with reply).
 * Skips ic-* threads (issue comments); skips threads already in repliedThreadIds.
 * Updates repliedThreadIds in-place after each successful reply.
 * On 3 consecutive 422 Validation Failed, stops attempting more replies and returns counts.
 * Caller may print a summary when replied/attempted is very low (e.g. <10%).
 */
export async function postThreadReplies(opts: PostThreadRepliesOptions): Promise<PostThreadRepliesResult | void> {
  if (!opts.replyToThreads) return;

  const {
    comments,
    verifiedCommentIds,
    dismissedIssues,
    commitSha,
    repliedThreadIds,
    github,
    prInfo,
    resolveThreads = false,
  } = opts;
  const { owner, repo, number: prNumber } = prInfo;
  const short = shortSha(commitSha);

  // commentId -> { threadId, databaseId } for replyable threads only.
  // WHY skip ic-*: Synthetic issue-comment threads have no real inline thread to reply to; posting would fail or confuse.
  // WHY require databaseId: REST createReplyForReviewComment expects numeric comment_id; GraphQL gives us this at fetch time.
  // WHY lowercase alias: Commit messages store prr-fix:<id> with id.toLowerCase() (git-commit-iteration); GraphQL node ids
  // are mixed-case. verifiedCommentIds / dismissed commentId may not match c.id string equality — lookup must be case-insensitive.
  const commentToThread = new Map<string, { threadId: string; databaseId: number }>();
  for (const c of comments) {
    if (c.threadId.startsWith('ic-')) continue;
    const dbId = c.databaseId ?? null;
    if (dbId == null) continue;
    const entry = { threadId: c.threadId, databaseId: dbId };
    commentToThread.set(c.id, entry);
    const lower = c.id.toLowerCase();
    if (lower !== c.id) commentToThread.set(lower, entry);
  }

  const getThreadEntry = (commentId: string): { threadId: string; databaseId: number } | undefined =>
    commentToThread.get(commentId) ?? commentToThread.get(commentId.toLowerCase());

  const threadsRepliedThisCall: string[] = [];
  const botLogin = process.env.PRR_BOT_LOGIN?.trim() || undefined;
  let attempted = 0;
  let replied = 0;
  let consecutive422 = 0;
  let stopReplyDueTo422 = false;

  // Collect candidate thread IDs we might reply to (for batched cross-run idempotency check).
  const candidateThreadIds = new Set<string>();
  for (const commentId of verifiedCommentIds) {
    const entry = getThreadEntry(commentId);
    if (entry && !repliedThreadIds.has(entry.threadId)) candidateThreadIds.add(entry.threadId);
  }
  for (const d of dismissedIssues) {
    if (!DISMISSED_CATEGORIES_WITH_REPLY.has(d.category)) continue;
    const entry = getThreadEntry(d.commentId);
    if (entry && !repliedThreadIds.has(entry.threadId)) candidateThreadIds.add(entry.threadId);
  }

  // Batch-fetch "already replied by us" for all candidates in parallel (one API call per thread, parallelized).
  // WHY parallel: Sequential getThreadComments would make latency linear in thread count; Promise.all keeps wall-clock time low.
  const alreadyRepliedByUsMap = new Map<string, boolean>();
  if (botLogin && candidateThreadIds.size > 0) {
    const results = await Promise.all(
      Array.from(candidateThreadIds, async (threadId) => {
        try {
          const threadComments = await github.getThreadComments(owner, repo, prNumber, threadId);
          return [threadId, threadComments.some((c) => c.author === botLogin)] as const;
        } catch {
          return [threadId, false] as const;
        }
      })
    );
    for (const [threadId, already] of results) {
      alreadyRepliedByUsMap.set(threadId, already);
    }
  }

  // Verified-fixed: reply "Fixed in `abc1234`."
  for (const commentId of verifiedCommentIds) {
    if (stopReplyDueTo422) break;
    const entry = getThreadEntry(commentId);
    if (!entry) continue;
    if (repliedThreadIds.has(entry.threadId)) continue;
    if (alreadyRepliedByUsMap.get(entry.threadId) === true) {
      repliedThreadIds.add(entry.threadId);
      continue;
    }
    const body = `Fixed in \`${short}\`.`;
    attempted++;
    const result = await postReplyWithRetry(github, owner, repo, prNumber, entry.databaseId, entry.threadId, body, 'Addressed.');
    if (result.ok) {
      replied++;
      consecutive422 = 0;
      repliedThreadIds.add(entry.threadId);
      threadsRepliedThisCall.push(entry.threadId);
      debug('Posted fixed reply on thread', { threadId: entry.threadId });
    } else {
      if (result.is422) {
        consecutive422++;
        if (consecutive422 >= MAX_CONSECUTIVE_422_BEFORE_STOP) {
          console.log(chalk.yellow(`Stopping thread replies after ${MAX_CONSECUTIVE_422_BEFORE_STOP} consecutive 422s (Validation Failed).`));
          stopReplyDueTo422 = true;
        }
      } else {
        consecutive422 = 0;
      }
    }
  }

  // Dismissed: reply only for categories that get a reply
  for (const d of dismissedIssues) {
    if (stopReplyDueTo422) break;
    if (!DISMISSED_CATEGORIES_WITH_REPLY.has(d.category)) continue;
    const entry = getThreadEntry(d.commentId);
    if (!entry) continue;
    if (repliedThreadIds.has(entry.threadId)) continue;
    if (alreadyRepliedByUsMap.get(entry.threadId) === true) {
      repliedThreadIds.add(entry.threadId);
      continue;
    }
    let body: string;
    if (d.category === 'already-fixed') {
      body = 'No changes needed — already addressed before this run.';
    } else if (d.category === 'remaining' || d.category === 'exhausted') {
      body = 'Could not auto-fix (wrong file or repeated failures); manual review recommended.';
    } else if (d.category === 'path-unresolved') {
      body = 'Could not auto-fix (path unresolved); manual review recommended.';
    } else if (d.category === 'missing-file') {
      body = 'Could not auto-fix (file not found); manual review recommended.';
    } else if (d.category === 'chronic-failure') {
      body = 'Could not auto-fix (repeated failures); manual review recommended.';
    } else if (d.category === 'duplicate') {
      body = 'Treated as duplicate of another comment; no separate fix.';
    } else if (d.category === 'file-unchanged') {
      body = 'No change in this file this run; manual review if still needed.';
    } else {
      body = `Dismissed: ${oneLine(d.reason)}`;
    }
    attempted++;
    const result = await postReplyWithRetry(github, owner, repo, prNumber, entry.databaseId, entry.threadId, body, 'No change needed.');
    if (result.ok) {
      replied++;
      consecutive422 = 0;
      repliedThreadIds.add(entry.threadId);
      threadsRepliedThisCall.push(entry.threadId);
      debug('Posted dismissed reply on thread', { threadId: entry.threadId, category: d.category });
    } else {
      if (result.is422) {
        consecutive422++;
        if (consecutive422 >= MAX_CONSECUTIVE_422_BEFORE_STOP) {
          console.log(chalk.yellow(`Stopping thread replies after ${MAX_CONSECUTIVE_422_BEFORE_STOP} consecutive 422s (Validation Failed).`));
          stopReplyDueTo422 = true;
        }
      } else {
        consecutive422 = 0;
      }
    }
  }

  // WHY resolve only after we actually replied: Resolving without a reply would collapse the thread with no PRR message; we resolve only threads we just replied to.
  if (resolveThreads && threadsRepliedThisCall.length > 0) {
    for (const threadId of threadsRepliedThisCall) {
      try {
        await github.resolveReviewThread(owner, repo, threadId);
        debug('Resolved thread', { threadId: threadId.slice(0, 20) });
      } catch (err) {
        debug('Failed to resolve thread', { threadId: threadId.slice(0, 20), error: String(err) });
      }
    }
  }

  return { attempted, replied };
}
