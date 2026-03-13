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

/**
 * Dismissed categories that get a reply. No reply for remaining, exhausted, chronic-failure.
 * WHY: already-fixed/stale/not-an-issue/false-positive are clear conclusions; exhausted/remaining mean "we gave up" or "needs human" — a bot reply there adds little and can feel like noise.
 */
const DISMISSED_CATEGORIES_WITH_REPLY = new Set<string>([
  'already-fixed',
  'stale',
  'not-an-issue',
  'false-positive',
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

/**
 * Post a reply on each review thread that was verified-fixed or dismissed (with reply).
 * Skips ic-* threads (issue comments); skips threads already in repliedThreadIds.
 * Updates repliedThreadIds in-place after each successful reply.
 */
export async function postThreadReplies(opts: PostThreadRepliesOptions): Promise<void> {
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
  const commentToThread = new Map<string, { threadId: string; databaseId: number }>();
  for (const c of comments) {
    if (c.threadId.startsWith('ic-')) continue;
    const dbId = c.databaseId ?? null;
    if (dbId == null) continue;
    commentToThread.set(c.id, { threadId: c.threadId, databaseId: dbId });
  }

  const threadsRepliedThisCall: string[] = [];
  const botLogin = process.env.PRR_BOT_LOGIN?.trim() || undefined;

  // Collect candidate thread IDs we might reply to (for batched cross-run idempotency check).
  const candidateThreadIds = new Set<string>();
  for (const commentId of verifiedCommentIds) {
    const entry = commentToThread.get(commentId);
    if (entry && !repliedThreadIds.has(entry.threadId)) candidateThreadIds.add(entry.threadId);
  }
  for (const d of dismissedIssues) {
    if (!DISMISSED_CATEGORIES_WITH_REPLY.has(d.category)) continue;
    const entry = commentToThread.get(d.commentId);
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
    const entry = commentToThread.get(commentId);
    if (!entry) continue;
    if (repliedThreadIds.has(entry.threadId)) continue;
    if (alreadyRepliedByUsMap.get(entry.threadId) === true) {
      repliedThreadIds.add(entry.threadId);
      continue;
    }
    const body = `Fixed in \`${short}\`.`;
    try {
      await github.replyToReviewThread(owner, repo, prNumber, entry.databaseId, body);
      repliedThreadIds.add(entry.threadId);
      threadsRepliedThisCall.push(entry.threadId);
      debug('Posted fixed reply on thread', { threadId: entry.threadId });
    } catch (err) {
      debug('Failed to post fixed reply', { threadId: entry.threadId, error: String(err) });
    }
  }

  // Dismissed: reply only for categories that get a reply
  for (const d of dismissedIssues) {
    if (!DISMISSED_CATEGORIES_WITH_REPLY.has(d.category)) continue;
    const entry = commentToThread.get(d.commentId);
    if (!entry) continue;
    if (repliedThreadIds.has(entry.threadId)) continue;
    if (alreadyRepliedByUsMap.get(entry.threadId) === true) {
      repliedThreadIds.add(entry.threadId);
      continue;
    }
    let body: string;
    if (d.category === 'already-fixed') {
      body = 'No changes needed — already addressed before this run.';
    } else {
      body = `Dismissed: ${oneLine(d.reason)}`;
    }
    try {
      await github.replyToReviewThread(owner, repo, prNumber, entry.databaseId, body);
      repliedThreadIds.add(entry.threadId);
      threadsRepliedThisCall.push(entry.threadId);
      debug('Posted dismissed reply on thread', { threadId: entry.threadId, category: d.category });
    } catch (err) {
      debug('Failed to post dismissed reply', { threadId: entry.threadId, error: String(err) });
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
}
