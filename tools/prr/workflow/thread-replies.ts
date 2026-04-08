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
import { debug, formatNumber } from '../../../shared/logger.js';
import chalk from 'chalk';

/**
 * Base dismissed categories that get a reply.
 * WHY: When --reply-to-threads is used, every considered thread should get a short reply so reviewers see PRR touched it.
 *
 * **`chronic-failure`:** excluded by default (batch token-saving dismissals). Opt in with **`PRR_THREAD_REPLY_INCLUDE_CHRONIC_FAILURE=1`** — see **`dismissedCategoriesWithReply()`**.
 */
const DISMISSED_CATEGORIES_BASE = new Set<string>([
  'already-fixed',
  'stale',
  'not-an-issue',
  'false-positive',
  'remaining',
  'exhausted',
  'path-unresolved', // e.g. .d.ts fragment — reply so thread has visible feedback
  'missing-file', // file not found — reply so thread has visible feedback
  'duplicate',
  'file-unchanged',
  'out-of-scope', // blast radius (opt-in dismiss) — manual review if comment still valid
]);

/** Categories that receive a dismissed-thread reply for this process (base set + optional chronic-failure). */
export function dismissedCategoriesWithReply(): Set<string> {
  const s = new Set(DISMISSED_CATEGORIES_BASE);
  if (
    process.env.PRR_THREAD_REPLY_INCLUDE_CHRONIC_FAILURE?.trim() === 'true' ||
    process.env.PRR_THREAD_REPLY_INCLUDE_CHRONIC_FAILURE === '1'
  ) {
    s.add('chronic-failure');
  }
  return s;
}

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

/** GitHub REST cap for review reply bodies (leave margin below 65,536). */
const REVIEW_REPLY_BODY_MAX_CHARS = 60_000;

function clampReplyBodyForGitHub(body: string): string {
  if (body.length <= REVIEW_REPLY_BODY_MAX_CHARS) return body;
  return `${body.slice(0, REVIEW_REPLY_BODY_MAX_CHARS - 24)}\n[body truncated]`;
}

/**
 * When true, 422 is almost certainly stale thread / diff position / comment id — a shorter body will not help.
 * Skip the second API call (pill-output audits: redundant fallback still 422s).
 */
function threadReply422SkipShortBodyRetry(err: unknown): boolean {
  const { body } = getErrorDetails(err);
  if (body != null && typeof body === 'object' && !Array.isArray(body) && 'errors' in body) {
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const raw of errors) {
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as { field?: string; resource?: string; code?: string };
        const field = (e.field ?? '').toLowerCase();
        const resource = (e.resource ?? '').toLowerCase();
        if (field === 'body' || field.endsWith('_body')) return false;
        if (resource.includes('pullrequestreviewcomment') || resource.includes('pull_request_review')) return true;
        if (
          field === 'in_reply_to' ||
          field === 'commit_id' ||
          field === 'path' ||
          field === 'position' ||
          field === 'line' ||
          field === 'side' ||
          field === 'subject_type' ||
          field === 'diff_hunk'
        ) {
          return true;
        }
      }
    }
  }
  const s =
    typeof body === 'string'
      ? body
      : body != null
        ? JSON.stringify(body)
        : '';
  const lower = s.toLowerCase();
  if (/\bfield["']?\s*:\s*["']body["']/.test(s) || /\bcode["']?\s*:\s*["']too_large["']/.test(s)) {
    return false;
  }
  return (
    /pullrequestreviewcomment|in_reply_to|"field":"commit_id"|"field":"path"|"field":"position"|"field":"line"|"field":"side"|diff_hunk/.test(
      lower,
    )
  );
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
  const primary = clampReplyBodyForGitHub(body);
  const fallback = clampReplyBodyForGitHub(fallbackBody);
  try {
    await github.replyToReviewThread(owner, repo, prNumber, databaseId, primary);
    return { ok: true };
  } catch (err) {
    const { status, message, body: errBody } = getErrorDetails(err);
    const validationFailed = status === 422 || /validation failed/i.test(message);
    if (validationFailed) {
      debug('Validation Failed posting reply — full error', { threadId, status, message, responseBody: errBody });
    } else {
      debug('Failed to post reply', { threadId, error: message });
    }
    const skipShortRetry = validationFailed && threadReply422SkipShortBodyRetry(err);
    if (skipShortRetry) {
      debug('Skipping short-body reply retry — 422 looks like thread/diff/comment state, not body length', { threadId });
    }
    if (!skipShortRetry && fallback !== primary) {
      try {
        await github.replyToReviewThread(owner, repo, prNumber, databaseId, fallback);
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

/** Consecutive batches where **every** reply in the batch failed with 422 — then stop (avoids parallel 422 miscount; pill-output). */
const MAX_CONSECUTIVE_ALL_422_BATCHES_BEFORE_STOP = 3;

/**
 * Post a reply on each review thread that was verified-fixed or dismissed (with reply).
 * Skips ic-* threads (issue comments); skips threads already in repliedThreadIds.
 * Updates repliedThreadIds in-place after each successful reply.
 * On 3 consecutive batches where every reply in the batch returns 422, stops attempting more replies (serial batch accounting; pill-output).
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
  const dismissedWithReply = dismissedCategoriesWithReply();

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
  let attempted = 0;
  let replied = 0;
  let consecutiveAll422Batches = 0;
  let stopReplyDueTo422 = false;

  // Collect candidate thread IDs we might reply to (for batched cross-run idempotency check).
  const candidateThreadIds = new Set<string>();
  for (const commentId of verifiedCommentIds) {
    const entry = getThreadEntry(commentId);
    if (entry && !repliedThreadIds.has(entry.threadId)) candidateThreadIds.add(entry.threadId);
  }
  for (const d of dismissedIssues) {
    if (!dismissedWithReply.has(d.category)) continue;
    const entry = getThreadEntry(d.commentId);
    if (entry && !repliedThreadIds.has(entry.threadId)) candidateThreadIds.add(entry.threadId);
  }

  let botLogin = process.env.PRR_BOT_LOGIN?.trim() || undefined;
  if (!botLogin && candidateThreadIds.size > 0) {
    botLogin = await github.getAuthenticatedLogin();
  }

  // Batch-fetch "already replied by us" for all candidates in parallel (one API call per thread, parallelized).
  // WHY parallel: Sequential getThreadComments would make latency linear in thread count; Promise.all keeps wall-clock time low.
  const alreadyRepliedByUsMap = new Map<string, boolean>();
  if (!botLogin && candidateThreadIds.size > 0) {
    console.warn(
      chalk.yellow(
        '  Thread replies: could not determine bot login (set PRR_BOT_LOGIN or use a token allowed to call GET /user); cross-run idempotency is off.',
      ),
    );
  }
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

  // Pill #10: Batch verified-fixed replies with concurrency limit (reduce wall-clock time)
  const verifiedReplies: Array<{ entry: { threadId: string; databaseId: number }; body: string }> = [];
  for (const commentId of verifiedCommentIds) {
    const entry = getThreadEntry(commentId);
    if (!entry) continue;
    if (repliedThreadIds.has(entry.threadId)) continue;
    if (alreadyRepliedByUsMap.get(entry.threadId) === true) {
      repliedThreadIds.add(entry.threadId);
      continue;
    }
    verifiedReplies.push({ entry, body: `Fixed in \`${short}\`.` });
  }

  // Process verified replies with concurrency limit (3 parallel)
  const REPLY_CONCURRENCY = 3;
  for (let i = 0; i < verifiedReplies.length && !stopReplyDueTo422; i += REPLY_CONCURRENCY) {
    const batch = verifiedReplies.slice(i, i + REPLY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ entry, body }) => {
        attempted++;
        const result = await postReplyWithRetry(github, owner, repo, prNumber, entry.databaseId, entry.threadId, body, 'Addressed.');
        if (result.ok) {
          replied++;
          repliedThreadIds.add(entry.threadId);
          threadsRepliedThisCall.push(entry.threadId);
          debug('Posted fixed reply on thread', { threadId: entry.threadId });
        }
        return result;
      })
    );
    const anyOk = results.some((r) => r.ok);
    const all422 =
      results.length > 0 && results.every((r) => !r.ok && r.is422 === true);
    if (anyOk) consecutiveAll422Batches = 0;
    else if (all422) consecutiveAll422Batches++;
    else consecutiveAll422Batches = 0;
    if (consecutiveAll422Batches >= MAX_CONSECUTIVE_ALL_422_BATCHES_BEFORE_STOP) {
      console.log(
        chalk.yellow(
          `Stopping thread replies after ${formatNumber(MAX_CONSECUTIVE_ALL_422_BATCHES_BEFORE_STOP)} consecutive batches where every reply returned 422 (Validation Failed).`,
        ),
      );
      stopReplyDueTo422 = true;
      break;
    }
  }

  // Pill #10: Batch dismissed replies with concurrency limit
  const dismissedReplies: Array<{ entry: { threadId: string; databaseId: number }; body: string }> = [];
  for (const d of dismissedIssues) {
    if (!dismissedWithReply.has(d.category)) continue;
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
    } else if (d.category === 'chronic-failure') {
      body = 'Could not auto-verify after repeated failures; batch-dismissed. Manual review if still needed.';
    } else if (d.category === 'path-unresolved') {
      body = 'Could not auto-fix (path unresolved); manual review recommended.';
    } else if (d.category === 'missing-file') {
      body = 'Could not auto-fix (file not found); manual review recommended.';
    } else if (d.category === 'duplicate') {
      body = 'Treated as duplicate of another comment; no separate fix.';
    } else if (d.category === 'file-unchanged') {
      body = 'No change in this file this run; manual review if still needed.';
    } else if (d.category === 'out-of-scope') {
      body = 'Outside PR scope — manual review recommended.';
    } else {
      body = `Dismissed: ${oneLine(d.reason)}`;
    }
    dismissedReplies.push({ entry, body });
  }

  // Process dismissed replies with concurrency limit (3 parallel)
  for (let i = 0; i < dismissedReplies.length && !stopReplyDueTo422; i += REPLY_CONCURRENCY) {
    const batch = dismissedReplies.slice(i, i + REPLY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ entry, body }) => {
        attempted++;
        const result = await postReplyWithRetry(github, owner, repo, prNumber, entry.databaseId, entry.threadId, body, 'No change needed.');
        if (result.ok) {
          replied++;
          repliedThreadIds.add(entry.threadId);
          threadsRepliedThisCall.push(entry.threadId);
          debug('Posted dismissed reply on thread', { threadId: entry.threadId });
        }
        return result;
      })
    );
    const anyOk = results.some((r) => r.ok);
    const all422 =
      results.length > 0 && results.every((r) => !r.ok && r.is422 === true);
    if (anyOk) consecutiveAll422Batches = 0;
    else if (all422) consecutiveAll422Batches++;
    else consecutiveAll422Batches = 0;
    if (consecutiveAll422Batches >= MAX_CONSECUTIVE_ALL_422_BATCHES_BEFORE_STOP) {
      console.log(
        chalk.yellow(
          `Stopping thread replies after ${formatNumber(MAX_CONSECUTIVE_ALL_422_BATCHES_BEFORE_STOP)} consecutive batches where every reply returned 422 (Validation Failed).`,
        ),
      );
      stopReplyDueTo422 = true;
      break;
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
