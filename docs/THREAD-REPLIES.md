# PRR thread replies (GitHub feedback)

When PRR fixes or dismisses a review comment, it can post a short reply on that comment’s GitHub thread so reviewers and authors see visible feedback. This document describes behavior, design, and WHYs.

## What it does

- **Opt-in:** `--reply-to-threads` (or `PRR_REPLY_TO_THREADS=true`). Default is off so existing runs are unchanged.
- **Fixed issues:** After the commit is **successfully pushed** (in the commit-and-push phase), PRR posts one reply per thread it verified as fixed: `Fixed in \`abc1234\`.` (short commit SHA).
- **Dismissed issues:** At end of run, for reply-eligible dismissals (see below), PRR posts one reply per thread, e.g. `No changes needed — already addressed before this run.` or `Dismissed: <reason>`.
- **Resolve threads:** On by default whenever thread replies are enabled (**`--reply-to-threads`** / **`PRR_REPLY_TO_THREADS`**). **`--no-resolve-threads`** or **`PRR_RESOLVE_THREADS=0`** leaves conversations open. PRR collapses threads with a checkmark in the GitHub UI. If a **prior** run already posted **“Fixed in …”** / a dismissal reply but threads stayed open, a **follow-up** run still resolves those threads (no duplicate reply), as long as the token’s login appears on the thread (**`getThreadComments`** idempotency check).

## WHY opt-in

Default runs stay fast and unchanged; posting to GitHub is a conscious choice. Some environments (e.g. read-only tokens, or “analysis only” runs) should not write comments.

## WHY one reply per thread

GitHub review threads are one conversation per location. Multiple replies from the bot in the same thread add noise and make it harder for humans to reply in-thread. One short reply per outcome keeps the thread readable and leaves room for human follow-up.

## WHY fixed replies only after successful push

We post "Fixed in \<sha\>" only when the commit has been **successfully pushed** in the commit-and-push phase (`handleCommitAndPush`). We do not reply after incremental pushes during the fix loop. **WHY:** The right place for the reply is when the code is actually on the remote; replying only after push avoids claiming a fix before it's visible and keeps the single source of truth for fixed replies in one place.

## WHY reply at end of run for dismissed

We only know the full set of dismissals at end of run (after audit, bail-out, etc.). Posting dismissed replies once at the end keeps logic in one place and avoids replying for issues we might later re-open.


## WHY only some dismissal categories get a reply

We reply for: `already-fixed`, `stale`, `not-an-issue`, `false-positive`, `remaining`, `exhausted`, `path-unresolved`, `path-fragment`, `missing-file`, `duplicate`, `file-unchanged`, `out-of-scope` (see **`dismissedCategoriesWithReply()`** / **`DISMISSED_CATEGORIES_BASE`** in `tools/prr/workflow/thread-replies.ts`). By default we do **not** reply for `chronic-failure` (and other categories omitted from that set). Set **`PRR_THREAD_REPLY_INCLUDE_CHRONIC_FAILURE=1`** (or `true`) to also reply on **`chronic-failure`** threads with a short batch-dismissal line.

**WHY:** Clear dismissals (`already-fixed`, `stale`, `not-an-issue`, `false-positive`) give the reviewer a definitive outcome. `remaining` / `exhausted` get a short “Could not auto-fix; manual review recommended.” so threads are not left silent after we stop the fix loop. `path-unresolved` / `path-fragment` / `missing-file` / `duplicate` / `file-unchanged` get a specific line so the thread shows why PRR stopped. **`out-of-scope`** (opt-in via **`PRR_BLAST_RADIUS_DISMISS=1`**) gets “Outside PR scope — manual review recommended.” **`chronic-failure` is excluded by default:** those threads are bulk-dismissed to save tokens without a full fix cycle on each one — replying can add noise; operators who want visible closure on every thread can opt in with the env var above.

## WHY in-run and cross-run idempotency

- **In-run:** A single `repliedThreadIds` set is shared across commit-and-push (fixed replies) and final cleanup (dismissed replies). We never post twice to the same thread in one run.
- **Cross-run:** We need a GitHub **login** to match against thread comment authors. If **`PRR_BOT_LOGIN`** is set, we use it; otherwise we call **`GET /user`** with the same token (see **`GitHubAPI.getAuthenticatedLogin`**) when there are reply candidates. We then fetch each candidate thread’s comments and skip posting when that login already commented. **WHY:** Re-runs (e.g. after manual edits) would otherwise post duplicate “Fixed in …” or “Dismissed: …” for threads we already replied to. **`PRR_BOT_LOGIN`** remains useful to override when the token identity is not the account that posts review replies (rare).

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

---

## Thread working reactions (👀) — separate from thread replies

PRR can post an **`eyes`** reaction on **inline** pull request review comments (**REST** [`reactions.createForPullRequestReviewComment`](https://docs.github.com/en/rest/reactions/reactions#create-reaction-for-a-pull-request-review-comment)) **while it is actively working** those comments in the fix loop. This is **not** the same feature as **thread replies** (which remain **opt-in** via **`--reply-to-threads`**).

### What it does

- **Default on:** **`--thread-working-reactions`** defaults to **true**; opt out with **`--no-thread-working-reactions`** or **`PRR_THREAD_WORKING_REACTIONS=0`** / **`false`** / **`off`**.
- **When:** After **`issuesForPrompt`** is finalized and **before** the fixer runs (**`execute-fix-iteration.ts`**), and at the start of each single-issue focus iteration (**`trySingleIssueFix`** in **`recovery.ts`**).
- **Targets:** Only issues whose **`comment.databaseId`** is a positive finite number (same rule as **`replyToReviewThread`**). Synthetic rows without a REST id are skipped.
- **No API traffic:** **`--dry-run`**, missing **`github`** / **`prInfo`**, or **`hasGithubToken: false`** (resolver passes **`Boolean(config.githubToken?.trim())`**) → poster returns immediately.

### WHY default on (product)

Review bots often drop a 👀-style signal so humans know someone is looking at a thread. PRR does the same **without** requiring **`--reply-to-threads`**, so operators get lightweight GitHub-visible progress **during** long fix runs, not only after outcomes are known.

### WHY separate from `--reply-to-threads`

Thread replies change thread text and notification volume; they stay **opt-in** so unattended runs and read-only tokens stay safe. Reactions are **smaller surface area** (one REST POST per comment id, throttled) and are easier to disable globally when REST budget matters — so defaults can differ without coupling the two features.

### WHY throttle + per-run dedupe

Default-on means many comments could trigger many POSTs in one run. **`PRR_THREAD_WORKING_REACTION_MIN_MS`** (default **1,000** ms) spaces POSTs process-wide for that run. A **`Set`** on **`stateContext.threadWorkingReactionRunState.postedCommentDatabaseIds`** ensures the same id is not hammered repeatedly.

### WHY record `not_found` and disable on hard `error`

- **`404` / `not_found`:** The comment may be deleted or invisible; re-posting every iteration would waste calls. Treating **`not_found`** as “handled for this run” matches “don’t keep trying the same dead anchor.”
- **`error` (e.g. 403 integration, 5xx):** Disabling for the rest of the run after the first hard failure avoids **N** identical errors on huge PRs when the token cannot react or GitHub is failing closed.

### WHY backoff only on `rate_limited`

GitHub may return **429** (or **403** with rate-ish wording). The poster **`sleep(2000)`** and retries **once**; if it is still rate-limited or errors, it sets **`disabledForRestOfRun`** so the **fix loop never fails** because of reactions.

### WHY clear the cached poster each `PRResolver.run()`

The poster closes over **`prInfo`**. Clearing **`threadWorkingReactionPoster`** at the start of each **`run()`** avoids a rare foot-gun where a long-lived **`PRResolver`** instance could keep stale **`owner/repo`** if someone reused it across PRs.

### Configuration (reactions)

| Option / env | Purpose |
|--------------|---------|
| **`--thread-working-reactions`** | Default **on** — post 👀 while working inline review comments (REST). |
| **`--no-thread-working-reactions`** | Disable reactions for this invocation. |
| **`PRR_THREAD_WORKING_REACTIONS`** | **`0`** / **`false`** / **`off`** — disable via env (same as **`--no-thread-working-reactions`**). |
| **`PRR_THREAD_WORKING_REACTION_MIN_MS`** | Minimum ms between reaction POSTs in one run (default **1,000**; invalid / negative → default; capped at **60,000**). |

### Code pointers

- **`tools/prr/workflow/thread-working-reactions.ts`** — poster factory, spacing, dedupe, disable rules.
- **`tools/prr/github/api.ts`** — **`createPullRequestReviewCommentReaction`** (non-throwing outcomes for 404 / 422 / rate-ish responses).
- **`tools/prr/workflow/execute-fix-iteration.ts`** — calls **`notifyThreadWorking(issuesForPrompt)`** after prompt is built, before the fixer.
- **`tools/prr/workflow/helpers/recovery.ts`** — **`notifyThreadWorking([issue])`** per single-issue attempt.
- **`tools/prr/resolver.ts`** — builds the poster once per run (after **`run()`** clears any stale instance) and passes **`notifyThreadWorking`** through orchestrator callbacks.

## Configuration

| Option / env | Purpose |
|--------------|---------|
| `--reply-to-threads` | Enable posting replies on review threads when we fix or dismiss. |
| `--no-reply-to-threads` | Disable (default). |
| `PRR_REPLY_TO_THREADS=true` | Enable via env (e.g. CI). |
| `--resolve-threads` | **Default on** when replies are enabled. After replying, resolve the thread (collapse with checkmark). Also resolves threads where **this token** already replied on a **previous** run (no re-post). |
| `--no-resolve-threads` | Opt out: do not resolve threads after replying. |
| `PRR_RESOLVE_THREADS` | **`0`** / **`false`** / **`off`** — disable resolving when replies are enabled via env (same as **`--no-resolve-threads`**). |
| `PRR_BOT_LOGIN` | Optional override: GitHub login for cross-run idempotency. If unset, PRR uses the token’s login from **`GET /user`** when there are threads to reply to. |
| **Thread working reactions (👀)** | Default **on**, separate from replies — full **WHY** / wiring / env in the **Thread working reactions** section above; CLI/env also in **README** / **AGENTS.md**. |

## 422 Validation Failed and retries

On **`pulls.createReplyForReviewComment`**, GitHub may return **422** with structured **`errors`** (e.g. **`PullRequestReviewComment`** / **`in_reply_to`**) when the thread is not replyable (stale diff, wrong anchor). PRR logs the full response body in **debug** and **does not** send the short fallback body in that case — a shorter string would 422 the same way and wastes an API call. Plain **422** without those fields still gets one retry with the short fallback (e.g. `Addressed.`). Reply bodies are clamped to a safe max length before send. After several consecutive batches where **every** reply in the batch returns **422**, PRR stops attempting further replies for that run (see **`postThreadReplies`**).

### User-visible summary (422 storms)

At the end of **`postThreadReplies`**, PRR prints a **single line** with **`formatNumber`**: how many attempts **succeeded**, how many failed with **422**, how many failed for **other** reasons, and how many threads were **not attempted** because posting stopped early (repeated all-422 batches). When the stop threshold triggers, a **yellow** line also states how many were posted **so far** and how many remain **skipped**, plus a short pointer to this doc.

**Common causes of mass 422:** (1) Review bots commented on an **older commit** than the PR head — inline anchors no longer match the current diff (PRR warns when CodeRabbit’s review SHA ≠ HEAD; wait for a re-review or use **`PRR_EXIT_ON_STALE_BOT_REVIEW=1`** to fail fast before clone). (2) Threads **resolved or outdated** on GitHub so REST reply is rejected. (3) Wrong **`databaseId`** / thread state (rare if GraphQL ingestion is consistent).

**Mitigations:** Re-run after bots catch up; avoid **`--reply-to-threads`** on huge PRs until reviews target HEAD; ensure the token can post PR review comments; set **`PRR_BOT_LOGIN`** if cross-run idempotency should match a specific bot account.

## See also

- **AGENTS.md** — “PRR thread replies” for a short reference.
- **README.md** — “Thread replies (GitHub feedback)” in Features and CLI options table; thread working reactions in the same area.
- **Code (replies):** `tools/prr/workflow/thread-replies.ts`, `tools/prr/github/api.ts` (`replyToReviewThread`, `resolveReviewThread`, `getThreadComments`, `getAuthenticatedLogin`).
- **Code (👀 while working):** `tools/prr/workflow/thread-working-reactions.ts`, `createPullRequestReviewCommentReaction` in `tools/prr/github/api.ts`.
