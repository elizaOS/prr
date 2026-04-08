# PRR thread replies (GitHub feedback)

When PRR fixes or dismisses a review comment, it can post a short reply on that comment’s GitHub thread so reviewers and authors see visible feedback. This document describes behavior, design, and WHYs.

## What it does

- **Opt-in:** `--reply-to-threads` (or `PRR_REPLY_TO_THREADS=true`). Default is off so existing runs are unchanged.
- **Fixed issues:** After the commit is **successfully pushed** (in the commit-and-push phase), PRR posts one reply per thread it verified as fixed: `Fixed in \`abc1234\`.` (short commit SHA).
- **Dismissed issues:** At end of run, for reply-eligible dismissals (see below), PRR posts one reply per thread, e.g. `No changes needed — already addressed before this run.` or `Dismissed: <reason>`.
- **Resolve threads:** Optional `--resolve-threads` collapses replied threads with a checkmark in the GitHub UI.

## WHY opt-in

Default runs stay fast and unchanged; posting to GitHub is a conscious choice. Some environments (e.g. read-only tokens, or “analysis only” runs) should not write comments.

## WHY one reply per thread

GitHub review threads are one conversation per location. Multiple replies from the bot in the same thread add noise and make it harder for humans to reply in-thread. One short reply per outcome keeps the thread readable and leaves room for human follow-up.

## WHY fixed replies only after successful push

We post "Fixed in \<sha\>" only when the commit has been **successfully pushed** in the commit-and-push phase (`handleCommitAndPush`). We do not reply after incremental pushes during the fix loop. **WHY:** The right place for the reply is when the code is actually on the remote; replying only after push avoids claiming a fix before it's visible and keeps the single source of truth for fixed replies in one place.

## WHY reply at end of run for dismissed

We only know the full set of dismissals at end of run (after audit, bail-out, etc.). Posting dismissed replies once at the end keeps logic in one place and avoids replying for issues we might later re-open.


## WHY only some dismissal categories get a reply

We reply for: `already-fixed`, `stale`, `not-an-issue`, `false-positive`, `remaining`, `exhausted`, `path-unresolved`, `missing-file`, `duplicate`, `file-unchanged`, `out-of-scope` (see **`dismissedCategoriesWithReply()`** / **`DISMISSED_CATEGORIES_BASE`** in `tools/prr/workflow/thread-replies.ts`). By default we do **not** reply for `chronic-failure` (and other categories omitted from that set). Set **`PRR_THREAD_REPLY_INCLUDE_CHRONIC_FAILURE=1`** (or `true`) to also reply on **`chronic-failure`** threads with a short batch-dismissal line.

**WHY:** Clear dismissals (`already-fixed`, `stale`, `not-an-issue`, `false-positive`) give the reviewer a definitive outcome. `remaining` / `exhausted` get a short “Could not auto-fix; manual review recommended.” so threads are not left silent after we stop the fix loop. `path-unresolved` / `missing-file` / `duplicate` / `file-unchanged` get a specific line so the thread shows why PRR stopped. **`out-of-scope`** (opt-in via **`PRR_BLAST_RADIUS_DISMISS=1`**) gets “Outside PR scope — manual review recommended.” **`chronic-failure` is excluded by default:** those threads are bulk-dismissed to save tokens without a full fix cycle on each one — replying can add noise; operators who want visible closure on every thread can opt in with the env var above.

## WHY in-run and cross-run idempotency

- **In-run:** A single `repliedThreadIds` set is shared across commit-and-push (fixed replies) and final cleanup (dismissed replies). We never post twice to the same thread in one run.
- **Cross-run:** If `PRR_BOT_LOGIN` is set, we fetch each candidate thread’s comments and skip posting when that login already commented. **WHY:** Re-runs (e.g. after manual edits) would otherwise post duplicate “Fixed in …” or “Dismissed: …” for threads we already replied to. Checking by bot login makes re-runs safe and avoids spamming threads.

## WHY batch idempotency check

We collect all candidate thread IDs (verified + reply-eligible dismissed), then call `getThreadComments` for each in **parallel** (`Promise.all`). **WHY:** Doing one request per thread sequentially would make latency grow with thread count. Parallelizing keeps wall-clock time low when many threads are reply candidates.

## WHY we use databaseId for replies

GitHub’s REST API `pulls.createReplyForReviewComment` expects the comment’s numeric `comment_id` (databaseId). GraphQL gives us node IDs; we fetch and store `databaseId` on review comments so we can reply without a second lookup. **WHY:** Using the wrong ID type causes 404 or wrong thread; one source of truth (databaseId for REST) keeps replies reliable.

## WHY we skip issue-comment threads (ic-*)

Some “comments” are synthetic: we create them from issue comments (e.g. bot review text) with a synthetic `threadId` like `ic-123`. Those don’t have a real review thread to reply to. **WHY:** Posting would fail or create confusion; skipping them keeps the reply flow for real inline threads only.

## WHY comment ID lookup is case-insensitive

`prr-fix:` markers in commit messages store the comment id **lowercase** (see `git-commit-iteration`). Recovery from git therefore puts **lowercase** ids in `verifiedFixed`. GitHub GraphQL returns review comment **node ids with mixed case**. Thread replies map `comment.id → thread`; lookups use **case-insensitive** matching so recovered ids still resolve to the correct `databaseId` for `createReplyForReviewComment`.

## WHY final cleanup also passes verified-this-session

“Fixed in \`sha\`” replies after **push** only run when a push actually happened (`!pushNothingToPush`). If you use **`--no-push`**, or the remote was already up to date after a fix, push-phase replies are skipped. **Final cleanup** calls `postThreadReplies` with **`verifiedThisSession`** (plus dismissals) so threads still get a “Fixed in …” when appropriate. **`repliedThreadIds`** prevents double posts if push-phase already replied.

## Configuration

| Option / env | Purpose |
|--------------|---------|
| `--reply-to-threads` | Enable posting replies on review threads when we fix or dismiss. |
| `--no-reply-to-threads` | Disable (default). |
| `PRR_REPLY_TO_THREADS=true` | Enable via env (e.g. CI). |
| `--resolve-threads` | After replying, resolve the thread (collapse with checkmark). Default off. |
| `PRR_BOT_LOGIN` | GitHub login of the bot that posts replies. When set, we skip threads that already have a comment from this login (cross-run idempotency). |

## 422 Validation Failed and retries

On **`pulls.createReplyForReviewComment`**, GitHub may return **422** with structured **`errors`** (e.g. **`PullRequestReviewComment`** / **`in_reply_to`**) when the thread is not replyable (stale diff, wrong anchor). PRR logs the full response body in **debug** and **does not** send the short fallback body in that case — a shorter string would 422 the same way and wastes an API call. Plain **422** without those fields still gets one retry with the short fallback (e.g. `Addressed.`). Reply bodies are clamped to a safe max length before send. After several consecutive batches where **every** reply in the batch returns **422**, PRR stops attempting further replies for that run (see **`postThreadReplies`**).

## See also

- **AGENTS.md** — “PRR thread replies” for a short reference.
- **README.md** — “Thread replies (GitHub feedback)” in Features and CLI options table.
- **Code:** `tools/prr/workflow/thread-replies.ts`, `tools/prr/github/api.ts` (`replyToReviewThread`, `resolveReviewThread`, `getThreadComments`).
