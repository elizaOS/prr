# INV-008: Merge / conflict “blocked run” operator UX

## Why This Document

This inventory item is split from **`pill-output.md`** so pill runs that cite wrong legacy paths (**`tools/prr/merge.js`**, **`base-merge.js`**) still map to real surfaces in this repo without polluting **`INV-003`** (already **Done** for conflict prompt chunking).

## State

- **Status:** Open
- **Priority:** Medium
- **Area:** merge / conflicts / operator UX
- **Hits:** 27
- **Events:** 2026-04-08, 2026-04-09, 2026-04-10, 2026-04-11, 2026-04-12, 2026-04-13, 2026-04-14, 2026-04-25, 2026-04-26, 2026-04-28, 2026-04-29

## Evidence

- **`## 2026-04-08 23:56`**: **27** **`git-pull.ts`** — stash-push **`catch`** + abort path; **29** **`redact-url.ts`** — **`git://`**, **`%40`** in HTTPS creds; **36–37**, **41** pill **`src/git/pull.ts`** — **`success`** vs **`stashConflicts`/`stashLeft`**, rebase conflict before **`stash pop`**; **44**, **46–47** pill **`src/merge.ts`** — lockfile regen / git-first conflict vs LLM, **`forceMerge`** transparency (**`tools/prr/git/`**, **`shared/git/git-merge.ts`**). **Raw § removed after triage.**
- **`## 2026-04-09 00:27`**: **29** **`git-pull.ts`** — stash-push **`catch`** body + structured **`success:false`**; **32** **`redact-url.ts`** — **`?access_token=`**, Bearer headers; **35–36**, **44** pill **`tools/prr/src/git-helpers.ts`** — merge after failed rebase (**`--ff-only`** policy), **`stashLeft`/`success`**, log **`restoreStashOnFailure`** errors; **45**, **50** lockfile regen fail / retry + no push without lock (pill **`src/fixers/llm-api.ts`**, **`src/git.ts`** → **`tools/prr/git/`**, **`shared/git/git-lock-files.ts`**). **Raw § removed after triage.**
- **`## 2026-04-09 01:00`**: **29** **`git-pull.ts`** — non-empty **`catch`** on stash-push + structured failure to caller; **32** **`redact-url.ts`** — **`x-access-token:`** / **extraheader** leak paths; **40–41**, **44** pill **`tools/prr/src/git.ts`** — merge fallback vs linear history, **`stashLeft`/`success`** contract → **`shared/git/git-pull.ts`** / **`git-merge.ts`**. **Raw § removed after triage.**
- **`## 2026-04-09 01:17`**: **36** **`git-pull.ts`** — log stash-push **`catch`** / skip pop on failure; **39** **`redact-url.ts`** — test/comment edge cases (**ports**, assumptions); **43–44** pill **`tools/prr/src/git-helpers.ts`** → **`shared/git/git-pull.ts`** / rebase-abort + **`stashLeft`** contract (**`success`** vs silent loss). **Raw § removed after triage.**
- **`## 2026-04-09 21:22`**: **20**, **24** **`redact-url.ts`** — **`%40`**, bare **`ghp_`/`ghs_`**, **`password=`** in **git** stderr; **21** **`git-pull.ts`** — verify stash entry exists before **`didStash`**; **34**, **39**, **41** lockfile merge / **`bun install`** fail — guard empty **`git add`** (pill **`tools/prr/src/git.ts`** / **`conflicts.ts`** → **`tools/prr/git/`**). **Raw § removed after triage.**
- **`## 2026-04-10 04:40`**: **26**, **29** **`shared/git/git-pull.ts`** — stash **catch** / **`stashConflicts`/`stashLeft`** on failed pop; **30** **`shared/git/redact-url.ts`** — multi-**`@`** / credential boundary in redaction. **Raw § removed after triage.**
- **`## 2026-04-10 07:17`**: **24** **`tools/prr/github/thread-replies.ts`** — cache **`GET /user`** when **`PRR_BOT_LOGIN`** unset + warn on login drift vs existing replies; **29**, **30** **`shared/git/git-pull.ts`** — stash push **catch** completeness, **`stashConflicts`/`stashLeft`** on failed **stash pop**; **31** **`shared/git/redact-url.ts`** — percent-encoded **`@`** in credentials. **Raw § removed after triage.**
- **`## 2026-04-10 10:05`**: **32** **`shared/git/git-pull.ts`** — stash push fail / **`didStash`** vs pop; **33** **`shared/git/redact-url.ts`** — bare **`ghp_`/`ghs_`/`github_pat_`** in log text (defense in depth). **Raw § removed after triage.**
- **`## 2026-04-11 18:47`**: **25** **`shared/git/git-pull.ts`** — stash pop failure recovery / breadcrumb; **27** **`shared/git/redact-url.ts`** — percent-encoded **`@`** / credential edge cases; **24** **`README.md`** — prominent “no **`git-hooks.ts`**” / foreign-repo misconception. **Raw § removed after triage.**
- **`pill-output.md`** — **`## 2026-04-29 02:01`**, items **13–16** (auto-resolve failures, logging, blocked run); pill paths are **not** the real layout — use **`tools/prr/git/git-conflict-resolve.ts`**, **`tools/prr/git/git-conflict-*.ts`**, **`tools/prr/workflow/base-merge.ts`**, **`shared/git/git-merge.ts`** as appropriate.
- **17** — **`docs/README.md`**: conflict troubleshooting / “when the tool is blocked” (pairs with merge UX).
- **Raw dated section removed from `pill-output.md` after triage.**
- **`## 2026-04-26 17:49`**, item **51**: fork **`origin/develop`** missing ref / repeated fetch latency — **`shared/git/`** clone/fetch helpers; cache negative ref or prefer upstream when configured. **Raw § removed after triage.**
- **`## 2026-04-26 17:19`**: **30** clone hang / credential prompt watchdog (**`shared/git/clone.ts`**); **31** **`pr-mergeable.ts`** — poll when **`mergeable: null`**; **41** fail-fast after missing branch fetch (avoid long run then same fatal); **48–49** missing **`origin/develop`** — avoid **`origin/develop..HEAD`** line map when **`upstream/develop`** exists (**`shared/git/`** + diff helpers). **Raw § removed after triage.**
- **`## 2026-04-26 16:57`**: **14** **`shared/git/index.ts`** — **`rev-parse --show-toplevel`** vs expected **`workdir`**; **19** **`clone.ts`** — **`PRR_CLONE_DEPTH`** + merge-base / shallow pitfalls; **36–39**, **41** pre-clone / missing-base / large-repo clone / fail-fast (**`shared/git/`**, **`cloneOrUpdateRepository`** — not **`tools/prr/src/git.ts`**). **Raw § removed after triage.**
- **`## 2026-04-26 07:12`**: **9** **`stripGitDiffPathPrefix`** / diff-header leak (**`shared/git/git-diff.ts`** + **`path-utils`**); **25** **`git ls-files`** / tree fallback for short paths; **26** **`docs/THREAD-REPLIES.md`** depth (**`--reply-to-threads`**). **Raw § removed after triage.**
- **`## 2026-04-26 05:57`**: **27** **`rev-parse`** / **`workdir`** vs **CWD** guard (**`shared/git/git-helpers.ts`**). **Raw § removed after triage.**
- **`## 2026-04-26 05:35`**: **22** **`clone.ts`** timeout error UX; **25** **`pushWithRetry`** conflict operator hints (**`shared/git/`**). **Raw § removed after triage.**
- **`## 2026-04-25 22:12`**: **8** **`shared/git/workdir.ts`** — **`existsSync`** before reuse / corrupt partial clone (**`clone.ts`** pairs **INV-008** clone narrative). **Raw § removed after triage.**
- **`## 2026-04-25 09:07`**, **`09:42`**, **`09:57`** (3 sections): **`git-commit-scan`**, **`scan-committed-fixes`**, **`git-pull`**, **`git-scan`**, **`redact-url`**, merge-conflict / **`git-helpers`** / **`conflict-checker`** — pill **`tools/prr/src/git*`**, **`merge-conflict-resolver`**, **`conflictResolver`** → **`shared/git/`**, **`tools/prr/git/`**. **Raw § removed after triage.**
- **`## 2026-04-14 07:20`**: **28** **`push-with-retry.ts`** **`onConflict`** errors; **47–55**, **57–62**, **64–67**, **73–93** merge/conflict loops, self-merge, duplicate file passes, timeouts, **`merge.ts`** latent materialize, **clone** perf — pill **`tools/prr/src/*`** → **`tools/prr/git/git-conflict-*.ts`**, **`shared/git/`** (**elizaOS-scale** run narrative). **Raw § removed after triage.**
- **`## 2026-04-14 03:06`**: **26** **`pushWithRetry`** wall-clock cap; **37** **`PRR_GIT_PUSH_TIMEOUT_MS`** vs **`GIT_PUSH_TIMEOUT_MS`** (**`shared/constants/git-constants.ts`**, **`shared/git/push-with-retry.ts`**). **Raw § removed after triage.**
- **`## 2026-04-14 00:20`**: **7** **`run-orchestrator`** push try/catch; **12** post-clone **HEAD** SHA check (**`git-clone-core`**); **27** **`onConflict`** logging (**`push-with-retry`**); **34** **`GIT_PUSH_TIMEOUT_MS`** env override (**Open**). **Raw § removed after triage.**
- **`## 2026-04-13 03:31`**: **23** clone “no output” fail-fast vs **`PRR_CLONE_TIMEOUT_MS`** (**`cloneOrUpdateRepository`** — pill **`shared/git/index.ts`** **N/A**); **26** **`onConflict`** / **`.github/workflows/`** auto-resolve visibility; **28** **`GIT_PUSH_TIMEOUT_MS`** + push backoff (**Open**). **Raw § removed after triage.**
- **`## 2026-04-12 18:21`**: **24** SSH/credential stall hint before full clone timeout; **37** pull/rebase vs merge fallback — structured **`rebased`/`merged`** + stash pop errors (**`shared/git/`** sync helpers — pill **`pullWithStash`** **N/A**). **Raw § removed after triage.**
- **`## 2026-04-12 08:39`**: **10** post-clone **HEAD** SHA vs PR tip; **28** **`git-pull`/`pullSafely`** — stash error handling + **`stashLeft`** vs **`success`**; **32** **`redact-url`** auth header gaps; **37–38** rebase conflict / stash-pop / dirty tree; **45** latent merge on conflicted paths; **50** merge failure recovery — pill **`mergeBase`/`git.ts`** → **`shared/git/`**, **`tools/prr/git/`**. **Raw § removed after triage.**

## Next action

Skim **`tools/prr/CONFLICT-RESOLUTION.md`** and latest **`CHANGELOG`** [Unreleased] merge bullets; open a concrete issue only if **`output.log`** shows a reproducible gap (not pill path typos alone).

## Resolution

_(empty until closed.)_
