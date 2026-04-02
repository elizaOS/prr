# Audit cycles

**Last updated:** 2026-03-28 · **Recorded cycles:** 70 · **Historical (legacy):** 4

Single audit log for output.log, prompts.log, and code changes. Use it to spot recurring patterns and avoid flip-flopping.

---

## How to use this doc

1. **Before an audit:** Skim "Recurring patterns" and "Regression watchlist" so you know what to watch for.
2. **Before implementing audit-driven code changes:** Check "Recurring patterns" and "Regression watchlist" so improvements don't contradict prior cycles (avoid yoyoing). If the change touches stale re-check, verification, recovery-from-git, or loop guards, read the relevant cycle notes (e.g. Cycle 38 unmark-on-still-exists, "Stale verification / head change").
3. **During an audit (output.log / prompts.log):** Do not trust the logs alone for "fixed" or "already verified". **Verify against the workdir** when possible:
   - Find the workdir path in the log (e.g. `Reusing existing workdir: /root/.prr/work/…` or `Workdir preserved: …`).
   - For at least one issue that the log says is "already verified", "fixed", or "dismissed (already-fixed)", open the **actual file** at the cited path (and line range) in that workdir and confirm the fix is present (e.g. the bug pattern is gone). If the log says "skip fixer — all already verified" but the file still contains the bug, that is a finding (stale verification, head change, etc.).
   - This catches mismatches where state says "fixed" but the branch was rebased/reverted or verification was wrong.
4. **After an audit:** Add a new cycle using the template below. Fill findings, improvements, and flip-flop check.
5. **Periodically:** Update "Recurring patterns" if a new theme appears in 2+ cycles; add regression checks if we keep fixing the same class of bug.

---

## Repeating patterns to watch (concerns)

These themes have appeared in multiple cycles. When auditing, check whether they are still present or regressed.

| Theme | Cycles | Risk |
|-------|--------|------|
| **Verifier / snippet** | 2, 5, 7, 8, 9 | Truncated or placeholder snippet → verifier says YES when it shouldn’t, or can’t see fix → stalemate. Guard: wider snippet on WRONG_LOCATION, YES→STALE when "truncated/unavailable", stronger verifier for API/signature fixes, auto-verify when bug pattern absent after N rejections. |
| **Dedup across sources** | 9, 10 | Same issue from different authors or phrasings not merged → duplicate issues in fix prompt, wasted attempts. Guard: heuristic same-symbol + same-caller; LLM dedup for 3+ per file; GROUP over NONE. |
| **Noise in queue** | 5, 7, 9, 10 | Approval/summary comments, "file no longer exists", or generic dismissal comments get fix or LLM comment attempts. Guard: solvability approval/summary filter; skip dismissal when reason = file missing; post-filter generic COMMENT; file-exists before dismissal prompt. |
| **Multi-file / call sites** | 7, 10 | Fixer updates one file but not callers (e.g. async signature) → verifier or next run finds broken call site. Guard: pathExists for test path; multi-file nudge when body mentions callers; TARGET FILE(S) includes caller when relevant. |
| **Model strength** | 5, 8, 9, 10 | Weak default model (e.g. qwen-3-14b) approves bad fixes or rejects good ones; model rec ignores success rate. Guard: verifier model floor for API/signature; model rec prompt "weight overall success rate heavily"; escalation for repeated rejections. |
| **Mid-loop bypass** | 12 | Thresholds (couldNotInject) or filters (solvability) only run at push-iteration start; new comments or in-loop state bypass them and burn iterations. Guard: apply same dismissal/threshold checks at start of each fix iteration; run assessSolvability on new comments before adding to queue. |
| **STALE vs YES (snippet)** | 12 | Verifier returns STALE when explanation is "can't evaluate", "doesn't show", "only shows" (incomplete snippet) — judge instructions say use YES. Guard: STALE→YES override for these phrasings; avoid false positives on legitimate STALE ("only shows re-export"). |
| **Basename / fragment path** | 13 | Short or fragment paths (e.g. `10/route.ts`, `modelcontextprotocol/.../auto-top-up.ts`) resolved by basename to a *different* file with same basename → wrong content injected, S/R fails or wrong file edited. Guard: prefer basename candidate that shares path prefix with requested path; skip substitution when fragment looks like repo-root and no exact match. |
| **Stale verification / head change** | 33, 34 | Log says "already verified" or "fixed" but the workdir file still has the bug (e.g. PR head changed, state not cleared). Guard: when PR head SHA changes, clear verified state so fixes are re-checked; auditor must verify at least one "fixed" issue against workdir file content. |
| **Fix-in-test vs production** | 15 | Review says "fix mocks in tests" / "root cause in tests" but TARGET FILE(S) only lists production file → fixer edits production (no-op or workaround) or tries test file and is blocked. Guard: when review body indicates fix-in-test, add co-located test file to allowed paths so fixer can edit it. |
| **Canonical path propagation / rename targets** | 19, 20 | Early phases resolve basename/truncated review paths, but later cleanup/commit/reporting paths still use raw fragments or extension words like `test.ts` → successful fixes crash on `git add`/hashing or the real rename target is blocked as disallowed. Guard: use canonical primary path everywhere after issue creation; infer explicit rename destinations for filename-review issues. |
| **Hidden target file / lesson contamination** | 21 | Review comment is attached to implementation file, but the actual bug is in a test/import caller file that is not directly named in TARGET FILE(S). The fixer says "wrong file" repeatedly, while unrelated same-file lessons muddy the prompt. Guard: infer likely hidden test targets from the review text and scope lessons to the issue, not merely the file. |

---

## Recurring patterns

Improvements should reinforce these, not reverse.

| Pattern | What we keep doing |
|--------|---------------------|
| **Prompt size / noise** | Cap lessons, trim diff for tiny batches, filter global lessons by path relevance. |
| **Snippet visibility** | Quality gate (too-short note), wider fallback for analysis batch, anchor-aware expansion. |
| **Queue / log clarity** | One clear "still in queue" line, queue subtitle (to-fix vs already-verified), no contradictory "No issues" vs "N in queue". |
| **Allow-path / test path** | Expand for test-coverage, plausible-path checks, test path at issue build; migration journal in allowedPaths when review mentions it; consolidate-duplicate "other file" when refactor issue. Do *not* add a file when comment only *references* it — use isReferencePathInComment before persisting otherFile from CANNOT_FIX/WRONG_LOCATION. |
| **Loop prevention** | Counters and thresholds (WRONG_LOCATION/UNCLEAR, wrong-file, verifier rejection, CANNOT_FIX missing content); exhaust and dismiss instead of burning models. Auto-verify when bug pattern absent after N verifier rejections. Apply threshold checks (couldNotInject, ALREADY_FIXED) inside the fix loop, not only at analysis; run solvability on new comments before adding to queue. |
| **File injection** | Basename fallback for short/fragment paths; placeholder detection before injection; hallucination guard for full-file rewrite output (< 15% of original = reject). **llm-api:** files over 200k chars or 5k lines get a **line-anchored excerpt** (from `### Issue N: path:line` / `primary:` / `path:line` in the prompt) or a **head excerpt** when no anchors — avoids skipping injection entirely on mega-files (Cycle 67). |
| **Approval/noise filter** | Summary/meta-review tables, approval comments ("Approve", "LGTM", "All issues resolved"), PR metadata requests — all dismissed in solvability. |
| **Judge / verifier** | Judge NO must cite specific code or line numbers; format colons. Verifier: LESSON only for NO; for duplicate/shared-util steer to canonical lib/utils/..., not reference file; "Code before fix" empty/artifact → base verdict on Current Code and diff; multi-fix same file → judge by review comment. STALE→YES override when explanation indicates code/snippet not visible or "can't evaluate" (per judge instructions: if you would say "not in excerpt", say YES not STALE). |
| **Output / UX** | Pluralize (1 file / N files); timing aggregated by phase; model recommendation only when real reasoning; AAR title from first meaningful line. Exhausted issues appear in AAR and handoff until resolved (fix, conversation, or other). |
| **Conflict resolution** | Skip batch when prompt > 40 KB; hasConflictMarkers(); 504/timeout → chunked fallback; heartbeat every 30 s. |
| **Dedup across authors** | Same file + same primary symbol + same caller file (e.g. runner.py) → heuristic merge even when authors differ. LLM dedup still runs for 3+ issues per file; GROUP lines take priority over NONE. |
| **Verifier strength** | Escalation for previous rejections; stronger model for API/signature-related fixes (async, await, caller, TypeError). Weak default verifier kept approving call-site bugs. |
| **Dismissal comments** | Skip when reason says "file no longer exists" / "file not found"; skip when file missing in workdir; post-filter comments that only restate code (e.g. "extracts metrics"). |
| **Multi-file / call sites** | When TARGET FILE(S) has multiple files and review mentions callers (await, file:line), nudge: update implementation and every call site so signatures match. |
| **Fix-in-test allowed path** | When review says to fix root cause in tests / update mocks (e.g. "fix logger mocks in tests" rather than workaround in production), add co-located test file to allowed paths so fixer can edit it (optional follow-up from Cycle 15). |
| **Canonical paths / iteration commit scope** | Use canonical primary path (`resolvedPath ?? comment.path`) in cleanup, snippet refresh, verification, dismissal, and commit/reporting. Do not commit/push when the worktree is dirty but the current push iteration produced no newly verified fixes. For rename/file-naming issues, add the destination path (e.g. `foo.test.ts`) to TARGET FILE(S) instead of treating `.test.ts` as a sibling file named `test.ts`. |
| **Hidden target inference / issue-scoped lessons** | When a review says the bug is in a test file importing the implementation, infer likely test targets (for example `dir/__tests__/foo.test.ts`) and persist them on retry. If the target still cannot be inferred after repeated `WRONG_LOCATION` / `CANNOT_FIX`, stop retrying automatically. Filter lessons by issue text + current target paths so unrelated same-file failures do not dominate the prompt. |

---

## Regression watchlist

Quick checks each audit. Drill into the category that matches what you changed.

**Log vs reality (output.log / prompts.log)**
- [ ] For runs that report "already verified" or "fixed": spot-check at least one such issue by reading the file at the cited path in the workdir (path from log: `Reusing existing workdir:` / `Workdir preserved:`). Confirm the bug pattern is actually gone. If the log says fixed but the file still has the bug, treat as a finding (stale verification, head change).
- [ ] **prompts.log (Cycle 67):** PROMPT and RESPONSE JSON metadata share the same **`requestId`** (UUID) when using `shared/logger` — grep `requestId` to pair entries when concurrent calls reorder the file; slug number still pairs by convention.
- [ ] RESULTS SUMMARY "N issue(s) fixed and verified" counts only verifiedFixed/verifiedComments; it must not include issues dismissed as already-fixed (pill-output.md #2; cycles 33/34).
- [ ] Base-merge push: when log says "Merged latest X into Y" followed by "Everything up-to-date", the merge was a no-op (already merged). Verify `mergeBaseBranch` returns `alreadyUpToDate: true` so the caller doesn't attempt a pointless push.

**Prompt quality**
- [ ] Final audit: comments with empty path, **`(PR comment)`**, or **`isReviewPathFragment`** skip the adversarial LLM (`shouldSkipFinalAuditLlmForPath`); merged result still marks verified on synthetic pass (Cycle 69).
- [ ] Queue line shows to-fix vs already-verified when relevant.
- [ ] Verification: single "still in queue" line with clear detail (file not modified / failed verification).
- [ ] Global lessons capped and filtered by path relevance for small batches.
- [ ] Snippet expansion for analysis batch uses commentBody anchors when widening.
- [ ] No double ERROR logging for same LLM failure; disallowed-file lesson only when path-relevant.

**Allow-path / verifier / judge**
- [ ] otherFile from CANNOT_FIX/WRONG_LOCATION only when `!isReferencePathInComment(comment.body, otherFile)`.
- [ ] Migration journal: allowedPaths includes `db/migrations/meta/_journal.json` when body/path match; fix prompt hint that journal is JSON not SQL.
- [ ] Verifier: LESSON only for NO; duplicate/shared-util → lib/utils/...; empty/artifact "Code before fix" → use Current Code and diff.
- [ ] Verifier: API/signature-related fixes (async/await, caller, TypeError) use stronger model when available (commentMentionsApiOrSignature).
- [ ] Judge: NO must cite specific code or line numbers; format uses colons.
- [ ] Verifier: YES→NO override when explanation says "already correct", "comment mistaken", etc.
- [ ] Verifier: NO→YES override when explanation says "not visible in excerpt", "can't confirm whether", "missing from excerpts", "truncated portion would contain" (Cycle 14).
- [ ] Summary/meta-review comments (status recap tables, "### Summary" with 3+ status phrases) dismissed as not-an-issue (solvability).
- [ ] When snippet is "(file not found or unreadable)", batch analysis tries getFileContentFromRepo (git show HEAD:path) before sending to verifier.
- [ ] No-changes lessons: single-issue uses "Fix for path:line - ..."; batch uses "(N issues in batch)" in global lesson.
- [ ] Multi-file fix: when allowedPaths.length > 1 and body mentions callers (calls/caller/await/file:line), prompt includes nudge to update all listed files and call sites.

**Loop / mid-loop guards (Cycle 12)**
- [ ] couldNotInject: at start of each fix iteration, issues with couldNotInjectCountByCommentId >= threshold are dismissed and removed from queue; empty queue after dismiss → allFixed and break.
- [ ] New comments: processNewBotReviews runs assessSolvability when workdir + stateContext provided; unsolvable (e.g. (PR comment), lockfile) dismissed and not added to unresolvedIssues; dismissed comment IDs added to existingCommentIds.
- [ ] issuesForPrompt excludes Verification.isVerified and consecutiveAlreadyFixedAnyByCommentId >= 2.
- [ ] STALE→YES override: phrasings for "can't evaluate", "doesn't show", "only shows" (with not/beginning/start/first/lines), "incomplete"; no false positive on legitimate STALE ("only shows re-export").

**Stale re-check / recovery (Cycle 38, output-log-audit)**
- [ ] When batch analysis says "still exists" for a verified comment, we call unmarkVerified so the issue re-enters the fix queue (Cycle 38). Do not remove this for non-recovered IDs.
- [ ] Exception: comment IDs in recoveredFromGitCommentIds (set in recoverVerificationState from scanCommittedFixes) are excluded from stale re-check on first analysis and we skip unmark when batch says "still exists" for them (output-log-audit); cleared on load and after first findUnresolvedIssues.
- [ ] When findUnresolvedIssuesOptions.changedFiles is provided, only re-check stale verifications whose comment path is in that set (subset by file change).
- [ ] When PR head SHA changes, state/head handling still allows re-check (see "Stale verification / head change"); we do not carry recoveredFromGitCommentIds across runs.

**File injection / circuit breakers**
- [ ] Basename fallback: when requestedPath has 2+ segments, only accept a candidate with ≥1 shared prefix segment; return null if best candidate has pathScore 0 (avoids `10/route.ts` → `app/.../route.ts`, `verify/route.ts` → `app/.../nonce/route.ts`). Bare basenames (1 segment) are unrestricted. (Cycle 13)
- [ ] Placeholder content ("COMPLETE FILE CONTENTS", "[Previous content remains identical]") never injected into fix prompts.
- [ ] CANNOT_FIX missing content counter increments and solvability dismisses after threshold.
- [ ] Hallucination guard rejects `<file>` blocks < 15% of original size.
- [ ] Basename fallback triggers for short/missing code files; skips .git and node_modules.
- [ ] Approval comments ("Approve", "LGTM", "All issues resolved") dismissed in solvability.
- [ ] Dedup: GROUP lines take priority over NONE in LLM response; heuristic merges same file + same symbol + same caller file (callerFileFromBody) across authors.
- [ ] Diff summary capped for all batch sizes (not just ≤2 issues); filters to batch-relevant files.
- [ ] Dismissal comments: skip when reason matches "file no longer exists" / "file not found"; skip when file missing in workdir; post-filter COMMENT that only restates code (words from comment in surroundingCode).
- [ ] Fix-in-test: when review says "fix mocks in test" / "root cause in tests", add co-located test file to allowed paths (Cycle 15). When all S/R fail and fixer attempted a path not in allowedPaths, ensure skippedDisallowedFiles is used so wrong-file lesson/state is added (runner returns it on failure path).
- [ ] Canonical path propagation: cleanup/hash/commit/snippet-refresh/verification-failure flows use `resolvedPath ?? comment.path`, not raw truncated review paths (Cycle 20).
- [ ] Commit gate: if a push iteration verified no new fixes, do not create/push a commit from leftover dirty files in the worktree (Cycle 20).
- [ ] Rename target inference: review comments about missing `.test.ts` / `.spec.ts` naming add the renamed destination to TARGET FILE(S), and sibling extraction does not hallucinate bare `test.ts` from extension prose (Cycle 20).
- [ ] Hidden test target inference: comments like "test file has invalid imports" add likely test targets to allowed paths at issue creation and retry time; repeated disallowed attempts to those paths should be learned (Cycle 21).
- [ ] Missing-target escape hatch: if repeated `WRONG_LOCATION` / `CANNOT_FIX` says the real bug is in a hidden test file and no concrete target can be inferred, stop automatic retries and surface it for human follow-up (Cycle 21).
- [ ] Lesson scoping: per-issue prompt lessons should exclude unrelated same-file failures when their symbols/target paths do not match the current comment (Cycle 21).

**Output / UX / conflict**
- [ ] Pluralize for "N file(s)" / "N fix(es)" in verification, iteration, repository, llm-api.
- [ ] Exhausted issues appear in AAR (full detail + resolution hints) and in handoff; final summary shows exhausted when remaining=0.
- [ ] CodeRabbit "Recent review info" filtered in getReviewComments.
- [ ] Injected file content for fixer is raw (no "N | "); instruction not to add line prefixes in output.
- [ ] Conflict: batch skipped when prompt > 40 KB; hasConflictMarkers(); 504 → chunked retry; heartbeat every 30 s.

---

## Cycle template

Copy the block below for each new cycle.

**Severity:** High = regression or data-loss risk. Medium = correctness or significant UX. Low = minor/cosmetic.

```markdown
### Cycle — YYYY-MM-DD

**Artifacts audited:** (e.g. output.log from run X, prompts.log #0005–#0016, diff of prompt-building + fix-verification)

**Findings:**
- **High:** (none or 1-line)
- **Medium:** (1-line each)
- **Low:** (1-line each)

**Improvements implemented:**
- (bullet list)

**Flip-flop check:** Y / N — (one line: any revert or conflicting change?)

**Notes:** (optional). If you verified a "fixed" issue against the workdir, note it (e.g. "Spot-checked path:line — fix present" or "Spot-checked — bug still present, finding").
```

---

## Recorded cycles

### Cycle 70 — 2026-03-28 (basename + PR diff, repopulate resolvedPath, dedup-cluster ALREADY_FIXED, AAR)

**Artifacts audited:** output.log / handoff from milady-ai/milady#1511-style run (workdir `~/.prr/work/f4b02ae0e531442b`); themes: bare **`smoke.testcafe.js`**, empty **`unresolvedIssues`** vs unaccounted duplicate IDs, misleading “remaining”.

**Findings:**
- **Medium:** Ambiguous basename skipped real file; **`checkEmptyIssues`** repopulate lacked **`resolvedPath`** → same skip next iteration.
- **Medium:** Single-row **`ALREADY_FIXED`** with no disk edit left dedup-cluster siblings unaccounted.
- **Low:** AAR “Fixed this session” repeated boilerplate / duplicate threads.

**Improvements implemented:** **`resolveTrackedPathWithPrFiles`** + use in **`findUnresolvedIssues`** / repopulate; analysis cache **`changedFiles`** into **`checkEmptyIssues`**; **`getDuplicateClusterCommentIds`** + **`handleNoChangesWithVerification`** cluster dismiss; **`printAfterActionReport`** suppression + count line; tests **`resolve-tracked-path-pr-files`**, **`duplicate-cluster-ids`**; **CHANGELOG**, **README**, **DEVELOPMENT.md**, **AGENTS.md**, **docs/ROADMAP.md**.

**Flip-flop check:** N — additive path resolution and accounting; conservative when PR diff does not uniquely pick a basename.

**Notes:** Spot-checks on cited workdir (prior audit): port/BASE, error-count, shebang, ClientFunction fixes present. Dedup false-merge risk documented in DEVELOPMENT.md (same as canonical dedup assumption).

---

### Cycle 69 — 2026-03-26 (final audit: skip LLM for synthetic / fragment paths)

**Artifacts audited:** Prior prompts.log / output.log theme — **`(PR comment)`** and unreadable snippets driving bogus **UNFIXED** and wasted final-audit batches.

**Findings:**
- **Medium:** Final audit sent **all** non-dismissed comments to the adversarial LLM; synthetic paths only produced placeholder snippets → noise and re-queue risk.

**Improvements implemented:** **`shouldSkipFinalAuditLlmForPath`** (**`shared/path-utils.ts`**) — skip LLM when path is empty, **`(PR comment)`**, or **`isReviewPathFragment`**. **`runFinalAudit`** builds LLM batch only for remaining comments; skipped rows get **`stillExists: false`** with a fixed explanation; **`auditSnippets`** aligned by index for downstream tie-break logic. Tests in **`tests/path-utils.test.ts`**. **CHANGELOG** [Unreleased].

**Flip-flop check:** N — additive fast-path; file-backed comments unchanged.

**Notes:** Does not replace solvability / dismissal for those threads; only avoids a meaningless adversarial pass at exit.

---

### Cycle 68 — 2026-03-26 (thread-replies: align `chronic-failure` with docs; locale numbers)

**Artifacts audited:** Pill item (thread-replies / chronic-failure), **AGENTS.md** vs **`tools/prr/workflow/thread-replies.ts`** (code had **`chronic-failure`** in reply set; docs said no reply).

**Findings:**
- **Medium:** **AGENTS** / **THREAD-REPLIES** said no reply for **`chronic-failure`**, but **`DISMISSED_CATEGORIES_WITH_REPLY`** included it — duplicate “could not fix” class vs **`remaining`/`exhausted`** without the same semantics (batch token-saving dismissals).
- **Low:** 422 stop **`console.log`** used raw small integer — **number-formatting** rule prefers **`formatNumber`**.

**Improvements implemented:** Removed **`chronic-failure`** from **`DISMISSED_CATEGORIES_WITH_REPLY`** and the dedicated body branch; expanded file comment **WHY**; **`formatNumber`** on stop message; **docs/THREAD-REPLIES.md** list + **WHY** paragraph corrected (no longer claims **`remaining`/`exhausted`** replies are “less useful” — we **do** reply); **AGENTS.md** clause for **`chronic-failure`**; **CHANGELOG** [Unreleased].

**Flip-flop check:** Y — Threads dismissed **`chronic-failure`** lose a bot reply (aligns with long-documented intent); operators who relied on the brief accidental reply lose it.

**Notes:** **`path-unresolved`**, **`missing-file`**, **`duplicate`**, **`file-unchanged`** were already reply-eligible; doc now lists them explicitly. **Follow-up (same day):** **`debugPromptError`** **`debug()`** line includes **`requestId`**; **pill** **`pill-prompts.log`** uses the same **`requestId`** metadata pairing as **`shared/logger`**.

---

### Cycle 67 — 2026-03-26 (audit follow-ups: output.log + prompts.log — RESULTS SUMMARY, final-audit debug, llm-api injection, prompts.log pairing, dedup note)

**Artifacts audited:** Prior **output.log** / **prompts.log** audits (elizaOS/eliza#6562 thread, prompts.log structure). **Code review** of landed changes in **this repo** (no new workdir spot-check for PR “fixed” claims in this cycle).

**Findings:**
- **High:** (none — changes are observability, UX copy, and fixer context; no state/verification semantics altered except clearer operator messaging.)
- **Medium:** (none)
- **Low:** **`debugPromptError`** one-liner to `debug()` when `PRR_DEBUG_PROMPTS` is set does not echo **`requestId`** (metadata still has it in prompts.log ERROR entry) — cosmetic only.

**Improvements implemented:**
- **RESULTS SUMMARY** (`tools/prr/ui/reporter.ts`): When **final audit re-queue count** ≠ **Remaining**, explain that re-queue is **per thread (comment id)** and Remaining uses **deduped locations** / post-audit verification — same for GitHub review markdown summary and early cyan block when counts differ.
- **Final audit** (`tools/prr/llm/client.ts`): **Suppress** repeated identical **`Final audit truncated code snippets…`** debug lines after **5** per process, plus one **suppression notice** (reduces output.log noise on huge audits).
- **llm-api file injection** (`shared/runners/llm-api.ts`): Files **>200k chars** or **>5000 lines** no longer **skipped**; inject **windows around line anchors** parsed from the fix prompt (`### Issue N: path:line`, `primary: path:line`, `path:line`) or a **head excerpt** + label so the model knows content is partial.
- **prompts.log pairing** (`shared/logger.ts`): Auto **`requestId`** (UUID) on **PROMPT** metadata; **RESPONSE** / **ERROR** repeat it; map **cleared** on **`initOutputLog`**; **empty PROMPT** refusal **deletes** slug from map (no orphan pairing slot). **`debug()`** PROMPT/RESPONSE lines include **`requestId`** when present.
- **LLM dedup** (`tools/prr/workflow/issue-analysis.ts`): Comment that **`GROUP` + trailing `NONE`** must not discard parsed groups (behavior unchanged; documents prompts.log pattern).

**Flip-flop check:** N — additive logging and UX; injection is **strictly more context** than skip; no reversal of verification or dismissal rules.

**Notes:** **Logic review:** `debugResponse` / `debugPromptError` **remove** slug from `promptRequestIdBySlug` **before** `writeToPromptLog`, so an **empty RESPONSE** refusal does not leak map entries. **llm-api** bare `path:line` regex could theoretically pick extra line numbers if the same path string appears elsewhere in the prompt; risk is low vs previous **no injection**. **Not verified:** eliza PR workdir files for “fixed” this cycle — that remains the rule for **output.log “already verified”** audits, not for this tooling-only cycle.

---

### Cycle 66 — 2026-03-24 (output.log: elizaOS/eliza#6562 — base merge, ROADMAP index false positive, exit 500)

**Artifacts audited:** `output.log` (~01:54–02:xxZ). PR **elizaOS/eliza#6562** (`odi-dev` vs `v2.0.0`). Workdir **`/root/.prr/work/641c5dac25972ea4`**.

**Findings:**
- **High (H1):** Run ends with **`Error: 500 status code (no body)`** immediately after the long **RESULTS SUMMARY** table (after comment **266**). No stack trace in log — likely **GitHub REST/GraphQL** failure (submit review, large body, or transient). **Impact:** Operator sees hard failure after substantial work; unclear which step failed. **Improvement:** Log **request phase** (e.g. create review, comment) + **response headers** on 5xx; retry with backoff for idempotent reads; truncate/split review body if size limit.
- **Medium (M1):** **Base merge** conflict on **`packages/typescript/ROADMAP.md`**: verbose debug shows **`Conflict index stage 2 still contains marker-like lines`** → **`readOursFromConflictIndex` rejects stage-2** → deterministic keep-ours **cannot** use index; **LLM** eventually merges successfully. Suggests **`hasConflictMarkers` false positive on “ours” blob** (e.g. markdown `=======` / lines resembling conflict middle) or rare dirty stage-2. **Improvement:** For index stage-2, use **stricter** check (only `<<<<<<<` / `>>>>>>>`) or **allow** known doc patterns; see conflict debug theme in `CONFLICT-RESOLUTION.md`.
- **Medium (M2):** **Bail-out** after fixer **`All change blocks targeted disallowed files`** — model proposed **`banner.test.ts` / `reply.test.ts`** as **newfile** while **`TARGET FILE(S)`** was only **`anxiety.test.ts`**. **Remaining:** 1 issue; **zero progress** cycle. **Improvement:** Prompt nudge to **only** edit listed targets or expand allowed paths when review explicitly needs sibling tests.
- **Low (L1):** **ElizaCloud** **timeout/retry** on first conflict-resolution batch (`claude-sonnet-4-5`); recovered on retry — cost/latency.
- **Low (L2):** **CodeRabbit** review targets older SHA vs PR **HEAD**; **mergeable/dirty** on GitHub — expected noise; latent **merge-tree** probe correctly listed **6** conflicting paths.

**Improvements implemented:** **`hasGitConflictOpenOrCloseMarkers`** in **`shared/git/git-lock-files.ts`** — index **stage-2** check in **`readOursFromConflictIndex`** no longer uses full **`hasConflictMarkers`** (avoids false reject on doc **`=======`**). Tests in **`tests/has-conflict-markers.test.ts`**. **H1 (partial):** **`tools/prr/github/github-api-errors.ts`** — **`logGitHubApiFailure`** on key REST/GraphQL paths (**`pulls.get`**, **`createReview`**, **`createComment`**, **reviewThreads** pages, **reply** / **resolve** thread): **`debug`** includes phase, **`x-github-request-id`**, method/URL, response preview; **`warn`** on **5xx** / gateway-style message and **429**. **Still open:** retry/backoff, review-body size split (H1 full ask).

**Flip-flop check:** N — stricter only for rejecting corrupt stage-2; more merges succeed deterministically.

**Notes:** **Workdir spot-check:** **`packages/typescript/src/utils/slice-to-fit-budget.ts:42`** — `return items.slice(0, count);` present — aligns with log **`resolved/fixed`** for **`ic-4070759879-1`** (slice `fromEnd: false`). **`packages/typescript/src/logger.ts`** ~**399–402** — single `openSync` sequence for log fds; no duplicate declaration — aligns with **`ic-4070631596-0` verified**. **`packages/typescript/CHANGELOG.md`** (start of file) — **no** conflict markers visible — aligns with successful merge path. **ROADMAP** path: log shows nested markers + **stage-2 failed marker check** then **LLM success** — spot-check: **`grep ^=======` on ROADMAP** in workdir **no matches** (post-merge clean).

---

### Cycle 65 — 2026-03-21 (prompts.log: babylon#1327 — final audit parrots review; verifier + huge fix prompts)

**Artifacts audited:** prompts.log BabylonSocial/babylon#1327 run (~03:25–03:29Z). Workdir `/root/.prr/work/63e58dcd956d6759`. Cross-check: final-audit **PROMPT** text in log (not workdir spot-check for this cycle).

**Findings:**
- **High (H1):** **Final audit (#0009, qwen)** line **`[1] UNFIXED`** claims the **comment still says UUID v4** while the **same prompt’s full-file snippet** shows line 40 as **`Matches standard UUID format (versions 1-8)`** aligned with **`[1-8]`** in the regex — i.e. the audit **ignored the shown current code** and **parroted the original review**. That drove **spurious UNFIXED**, **unmarkVerified**, and **extra fix-loop work** (matches output.log Cycle 64 narrative). **Improvement:** Run **final audit** with **≥ same capability as post-fix verification** (e.g. opus), and add an instruction: **if the in-prompt file already matches the review’s requested alignment (comment ↔ regex), respond FIXED and quote the lines.**
- **Medium (M1):** **Batch verify (#0002, qwen)** for **`issue_1`**: explanation cites **“code snippet truncated, but regex not shown to be corrected”** while still answering **YES** — conflicts with **truncated → STALE / don’t speculate** guidance and can **inflate YES** vs a complete-snippet verify. **Improvement:** Enforce **STALE** or **secondary verify** when the verifier cites truncation as the reason.
- **Medium (M2):** **Fixer prompts** **#0004 ~73k** and **#0007 ~55k** chars before API — **timeout/cost** risk on gateways. **Improvement:** Tighter **batch split**, cap **injected file** sections, or align with conservative prompt cap messaging.
- **Low (L1):** **Verifier system prompt** embeds **generic SQL injection / `var` examples** in every batch-verify call — small **token tax** and **domain noise** for unrelated PRs. **Improvement:** Shorten examples or use **neutral placeholders**.
- **Low (L2):** **Model recommendation (#0003)** is useful; when only **one** model is available the block is mostly **ritual** — could **skip** or shorten.

**Improvements implemented:**
- **H1:** **`PRR_FINAL_AUDIT_MODEL`** + **`getFinalAuditModel()`** — final audit calls **`complete(..., { model })`** with **`finalAuditModel ?? verifierModel ?? llmModel`**. Prompt rules **8–9** require judging from shown code, not stale review text. **Post-parse:** UNFIXED demoted to FIXED when **`snippetShowsUuidCommentAlignedWithVersionRange`** and review mentions UUID/version (parrot guard).
- **M1:** Batch verify: instruction to prefer **STALE** when uncertainty is **only** truncation; **YES→NO** override when snippet is **`(end of file)`** but explanation cites **truncation**.
- **M2:** (Deferred) Enriched fix cap — monitor after opus prompt sizes.
- **L1:** Shorter **batch-verify** example lines (drop SQL/`var` toy examples).
- **L2:** Skip separate **model recommendation** call when **`availableModels.length <= 1`**.

**Flip-flop check:** Y — Final audit can mark FIXED where a weak model said UNFIXED (post-check + stronger model); batch override can clear YES when file is complete.

**Notes:** Final-audit prompt/response **contradiction** verified by reading `prompts.log` around **#0009** (lines 5899–5902 vs response **[1] UNFIXED**). Set **`PRR_FINAL_AUDIT_MODEL`** (e.g. same as fixer) when **`PRR_LLM_MODEL`** is a small verifier.

---

### Cycle 64 — 2026-03-21 (output.log: babylon#1327 — final audit unmark vs `verifiedThisSession` empty-queue bug)

**Artifacts audited:** output.log BabylonSocial/babylon#1327 (~03:15–03:29Z). Workdir `/root/.prr/work/63e58dcd956d6759`, branch `odi-db`.

**Findings:**
- **High (H1):** After **final audit** said **UNFIXED** for 5 previously verified Copilot threads, **`unmarkVerified`** ran but **`Filtering issues verified this session`** immediately removed all 5 from the queue → **`BUG DETECTED: unresolvedIssues is empty but N comments are neither verified nor dismissed`** → **re-populated**. Same pattern later with **3** issues. **Root cause:** **`verifiedThisSession`** still contained those comment IDs from earlier in the same run; **`unmarkVerified`** cleared persisted verification but **not** the session set, so **`filterUnresolvedAgainstVerifiedThisSession`** (fix-loop-utils) treated re-queued issues as “already fixed this session.” **Improvement:** On **`unmarkVerified`**, also **`verifiedThisSession.delete(commentId)`** so audit re-queue and persistent state stay aligned.
- **Medium (M1):** **RESULTS SUMMARY** shows **“Exit: All issues resolved”** / **0 remaining** alongside **“5 issues re-queued: audit said UNFIXED”** — confusing for operators; clarify that re-queue was **handled** in the same run vs **deferred technical debt**.
- **Medium (M2):** **Final audit** (qwen) contradicted **inline verification** (opus) on substantive Copilot threads (comment vs UUID version bits, test naming vs routing, DB skip, assertion gap) — risk of **flip-flop** between “verified” and “audit UNFIXED”. Consider **stronger / same model** for final audit when issues were verified with opus, or **tie-break** rules when audit disagrees with recent successful verify.
- **Low (L1):** **`[Auto-heal detection] Comment does not suggest invalid model ID`** logged **per comment × per phase** (many lines) — batch or **debug-only** once per phase to cut noise.
- **Low (L2):** **Duplicate `unmarkVerified`** debug lines for the same IDs in one audit tick (two back-to-back unmark sequences) — dedupe or single code path.

**Improvements implemented:**
- **H1:** **`unmarkVerified`** (`state-verification.ts`) now removes the comment id from **`verifiedThisSession`** when present.
- **M1:** **RESULTS SUMMARY**, **AAR**, and **GitHub review summary** (`reporter.ts` / `buildReviewSummaryMarkdown`) clarify mid-run **audit re-queue** vs end state: when **0 remaining** and re-opened ids are back in **verified-fixed**, informational copy instead of implying unresolved debt.
- **M2 (partial):** **`runFinalAudit`** (`analysis.ts`) **tie-break**: if the comment was **verified this session** and **`snippetShowsUuidCommentAlignedWithVersionRange`**, keep verified (defense in depth with final-audit client post-check / **`PRR_FINAL_AUDIT_MODEL`** from Cycle 65).
- **L1:** **`getOutdatedModelCatalogDismissal`**: no per-comment **`debug`** when the comment does not suggest an invalid model id (noise reduction).
- **L2:** **Single `unmarkVerified` path** for final-audit failures: batch unmark in **`runFinalAudit`** after building **`failedAudit`**; removed duplicate loop from **`main-loop-setup.ts`**.

**Flip-flop check:** Y — Changes who enters the fix loop after unmark; aligns with intent of audit re-queue (re-verify / re-fix). Should not skip fixes that audit explicitly reopened.

**Notes:** Did not spot-check workdir files for “audit UNFIXED vs opus verified” substance; log shows both narratives in one session — worth human review on the PR if tests/comments still mismatch Copilot’s bar. Cycle 64 follow-through landed 2026-03-18 (M1/M2/L1/L2).

---

### Cycle 62 — 2026-03-20 (output.log: eliza#6575 — auto-heal corrects telegram models, fix queue undoes it)

**Artifacts audited:** output.log elizaOS/eliza#6575 (~07:24–07:25Z). Workdir `/root/.prr/work/5102b5012b5d2a72`, head `e11d00ebf5…` (after prior `94dd9af → e11d00e` head change + verified clear).

**Findings:**
- **High (H1):** **Catalog auto-heal** correctly applied **`gpt-4o-mini` → `gpt-5-mini`** (2 literals) on `examples/telegram/typescript/telegram-agent.ts` for **`ic-4050517082-0`**, then the **fix loop** ran on **CodeRabbit** thread **`PRRC_kw…`** (“Model name typo `gpt-5-mini`”) and the fixer **claimed** it changed **`gpt-5-mini` → `gpt-4o-mini`** (catalog-wrong). **Spot-check workdir** `telegram-agent.ts` lines 31–32: **`gpt-4o-mini` present** — net state matches **wrong** review, not catalog. **Improvement:** After catalog heal/dismiss on a path, **suppress or merge** contradictory threads on the **same file** (or block S/R that flips to `wronglySuggestedId` from catalog dismissal); tie fix queue to **0a6** outcome.
- **Medium (M1):** **Contradictory runner UX:** log shows **`Applied search/replace`**, **`Modified 1 file`**, then **`No changes made by llm-api`** while **`Result: FIXED`** — operators cannot tell success vs no-op. Reconcile post-apply diff vs narrative.
- **Medium (M2):** **`ic-4079055770-0`** (“Closing — branch merged…”) still **verified** in final table (git recovery) while **open** PRRC telegram thread remains — meta vs code thread confusion persists (see Cycle 61 M1).
- **Low (L1):** **`PRRC_kw…`** telegram thread: auto-heal **Could not parse model rename advice** (same duplicate-framing gap as Cycle 61 L1).
- **Low (L2):** State churn: **133** fixes recovered from git, then **130** verification IDs **pruned** (not in current 52-comment set) — noisy; optional summary line “recovered N, pruned M, retained K”.
- **Info:** **Pill** after run: **504 FUNCTION_INVOCATION_TIMEOUT** with request body **~44,176 chars** (smaller than pre-chunk-fix 76k) — suggests **wall-clock / model** timeout as well as size; lighter **`PILL_AUDIT_MODEL`** or env caps still relevant.

**Improvements implemented:**
- **H1 (partial):** Extended **`parseModelRenameAdvice`** for CodeRabbit **typo heading + later `use`/`recommended`** so **0a6** + auto-heal apply to **`PRRC_kw…`** threads (stops contradictory queue item when body matches).
- **M2:** **`isMergeClosingMetaComment`** in **`assessSolvability` (0a3b)** dismisses **Closing / branch merged** meta text.
- **M1:** **`pathsWrittenByRunner`** + **execute-fix-iteration** note when git clean after reported writes.
- **L2:** Prune log **recovered-this-run** hint via **`gitRecoveredVerificationCount`**.
- **Noise:** Removed auto-heal **target comment** debug branches.

**Flip-flop check:** N — Dismissals and logging only; parse extension is fail-closed via catalog pair validation.

**Notes:** Spot-check: `examples/telegram/typescript/telegram-agent.ts:31-32` — **`gpt-4o-mini`** (catalog prefers **`gpt-5-mini`** after heal narrative); confirms fix queue fought auto-heal. Overlaps Cycle 61 H1 with evidence auto-heal ran before fix iteration in this run.

---

### Cycle 63 — 2026-03-20 (prompts.log: eliza#6575 — verifier/fixer prompts lack catalog context)

**Artifacts audited:** prompts.log elizaOS/eliza#6575 (~07:24–07:25Z). Same run as Cycle 62.

**Findings:**
- **High (H1):** **Verifier prompt (#0001)** and **fixer prompt (#0002)** both include the review comment text ("`gpt-5-mini` is not a valid OpenAI model name… it likely needs to be `gpt-4o-mini`") **without catalog context**. The verifier says **YES** (issue still exists) because code has `gpt-5-mini` instead of `gpt-4o-mini`; the fixer then changes `gpt-5-mini` → `gpt-4o-mini` (wrong direction per catalog). **Root cause:** Prompts parrot the review's claim; when `getOutdatedModelCatalogDismissal` matches but parsing fails (or comment reaches queue despite 0a6), verifier/fixer have no catalog knowledge. **Improvement:** Inject catalog context warning into verifier/fixer prompts when comment matches outdated model advice pattern (even if not dismissed) — warn that both IDs are valid and PR should keep catalog-correct ID.

**Improvements implemented:**
- **H1:** **`buildFixPrompt`** (prompt-builder.ts), **`buildSingleIssuePrompt`** (workflow/utils.ts), and **`batchCheckIssuesExist`** (llm/client.ts) now check **`getOutdatedModelCatalogDismissal`** and inject a **catalog context warning** when the comment matches outdated model advice. Warning states both IDs are valid per catalog and PR should keep the catalog-correct ID; fixer should respond ALREADY_FIXED if code already has it.

**Flip-flop check:** N — Additive prompt context only; no behavior change when catalog pattern doesn't match.

**Notes:** Follow-up to Cycle 62 H1. Even with improved parsing (Cycle 62), comments that slip through or have edge-case phrasing still reach verifier/fixer without catalog context. This ensures verifier/fixer see catalog truth even when 0a6 doesn't dismiss.

---

### Cycle 61 — 2026-03-20 (output.log: eliza#6575 short session — fixer flipped catalog model, meta comment stalemate)

**Artifacts audited:** output.log elizaOS/eliza#6575 (~1m 40s session, 51 comments in RESULTS). Workdir `/root/.prr/work/5102b5012b5d2a72`, head `94dd9af`.

**Findings:**
- **High (H1):** Fixer **applied** a search/replace on `examples/telegram/typescript/telegram-agent.ts` claiming FIXED by changing **`gpt-5-mini` → `gpt-4o-mini`** — the **opposite** of catalog-correct behavior for outdated model-id advice (both ids valid; PR should **keep** `gpt-5-mini`). Risk: PRR reinforces the bot’s wrong suggestion. Guard: block or warn when the proposed change matches `wronglySuggestedId` from `getOutdatedModelCatalogDismissal` for the same file/thread family, or inject an explicit “do not change model string to gpt-4o-mini” lesson when 0a6 would dismiss a related comment on that file.
- **Medium (M1):** **`ic-4079055770-0`** body is human **meta** (“Closing — the `odi-want` branch was already merged into develop…”) but is anchored on **`telegram-agent.ts`** and was treated as a **code fix** task → bail-out stalemate (`--max-stale-cycles`), wasted fix iteration. **Improvement:** Solvability (or early filter): treat “closing / merged / no further action” PR conversation comments as **`not-an-issue`** or **`not-solvable`** when they don’t cite a concrete code defect, even if GitHub attaches them to a file line.
- **Medium (M2):** **Auto-heal** in this log still shows **window-only** skip (`no replacements found in window` for `ic-4050…`). **Cycle 60** already added full-file fallback + noop verify — **re-run with current `main`** should heal or noop without burning the fixer. This log predates or was captured before that build.
- **Low (L1):** **Duplicate framing** on telegram model: **`PRRC_kw…`** thread body (“Model name typo `gpt-5-mini`…”) hit **Could not parse model rename advice**; **`ic-4050517082-0`** parsed the pair. Consider extending **`parseModelRenameAdvice`** for short “typo \`X\` … use \`Y\`” shapes so auto-heal + 0a6 apply consistently across thread variants.
- **Low (L2):** UX: log shows **“✓ Modified 1 file”** then **“No changes made”** / confusing no-change path — tighten messaging when apply runs but verification or no-change detection disagrees.
- **Info:** **Pruned 129** stale verified IDs (not in current 50-comment fetch) — expected after head/comment churn. **132** recovered-from-git verifications then heavy prune — OK. **4** final-audit re-queues (**UNFIXED** vs prior verify) — intentional safe-over-sorry. **3** `unseen` rows in debug table — note for thread/sync. Pill line present; outcome not shown in captured log tail.

**Improvements implemented:**
- **None in this cycle** — findings recorded for follow-up (H1/M1 highest leverage).

**Flip-flop check:** N — Audit-only.

**Notes:** Spot-check optional: workdir `telegram-agent.ts` after run to see whether `gpt-5-mini` or `gpt-4o-mini` is present (log suggests fixer attempted wrong swap). Cycle 60 addresses auto-heal gap; Cycle 61 adds fixer-vs-catalog and meta-comment queue issues.

---

### Cycle 60 — 2026-03-20 (output.log: eliza#6575 — catalog auto-heal matched but healed 0 files)

**Artifacts audited:** output.log from elizaOS/eliza#6575 run (workdir `/root/.prr/work/5102b5012b5d2a72`). Auto-heal summary: `matchedPattern: 1`, `skippedNoReplacements: 1`, `healed: 0`.

**Findings:**
- **Root cause:** Catalog auto-heal correctly matched outdated model-id advice on `examples/telegram/typescript/telegram-agent.ts` (`ic-4050…`, parsed pair `gpt-5-mini` / `gpt-4o-mini`). It only replaces **quoted** `gpt-4o-mini` within **±20 lines** of GitHub anchor line 35. The workdir file had **no** quoted `gpt-4o-mini` in that window (PR never applied the bad suggestion, or the literal lives outside the window) → `Skipping: no replacements found in window`.
- **Secondary gap:** No-op case did not **`markVerified`**, so the comment could still flow into analysis/fix loop unless solvability dismissed it; **`saveState`** only ran when disk paths were modified.

**Improvements implemented:**
- `catalog-model-autoheal.ts`: Full-file quoted-literal fallback when the anchor window finds no match; **noop verify** when the file has quoted catalog-good id and zero quoted wrong id (`catalog-autoheal-noop`). Return **`CatalogModelAutoHealOutcome`** `{ modifiedPaths, verificationTouched }`.
- `main-loop-setup.ts`: **`saveState`** when **`verificationTouched`** (including noop), not only when files are modified.
- Tests: noop + full-file fallback in `tests/outdated-model-advice.test.ts`. **CHANGELOG.md**, **AGENTS.md** updated.

**Flip-flop check:** N — Additive healing/verify paths; quoted-only safety preserved.

**Notes:** Spot-check not required for “heal failed” — log explains empty window; improvement addresses anchor drift and already-correct branches.

---

### Cycle 59 — 2026-03-20 (prompts.log: babylon#1293 — empty target file paths, large prompts, content generation failures)

**Artifacts audited:** prompts.log from BabylonSocial/babylon#1293 run (93,810 lines, 96 prompts). Workdir `/root/.prr/work/03a784a488499b4d`.

**Findings:**
- **High (H1):** Multiple prompts have target files listed as empty string `""` (e.g., issues 3-7 in prompt #0017), causing LLM to respond with CANNOT_FIX because file content wasn't provided. This is directly related to the path resolution issue in Cycle 58 — basenames like `db.ts`, `pnl-history/route.ts` aren't resolved to full paths, so the prompt builder can't find file content to include. Wastes LLM credits on issues that can't be fixed.
- **Medium (M1):** 10 instances of "Content generation ran but no content was created" — LLM calls that returned empty responses. This suggests silent failures or API issues that aren't being handled gracefully.
- **Medium (M2):** Several very large prompts (100k-169k chars, e.g., #0002: 164k, #0008: 144k, #0043: 169k). While within token limits, these large prompts may cause slower processing, higher costs, and potential quality degradation as the model's attention window is spread thin.
- **Low (L1):** Some prompts include issues where the target file path exists but file content is missing from the "Current Code:" section — this should be caught earlier in the pipeline (solvability or issue analysis phase).

**Improvements implemented:**
- `tools/prr/analyzer/prompt-builder.ts`: Skip issues with empty or invalid target file paths before building prompts. When `primaryPath` is empty, `(PR comment)`, or doesn't exist after resolution attempts (extension variants and common prefixes), the issue is skipped rather than included with an empty target file path. This prevents wasted LLM calls that would result in CANNOT_FIX responses. If all issues are skipped, return early with an informative message. Also skip issues where `allowedPaths` is empty after filtering (safety check).

**Flip-flop check:** N — Additive improvement; skips invalid issues rather than including them, preventing wasted LLM calls.

**Notes:** The empty target file path issue is the most critical — when `primaryPath` is empty or doesn't exist after resolution attempts, the prompt builder should either skip that issue entirely or dismiss it earlier (in solvability/issue-analysis phase) rather than including it with an empty target file path. The "Content generation ran but no content was created" errors suggest API-level issues that may need retry logic or better error handling. Large prompts are acceptable but could benefit from better batching or issue prioritization to keep prompts focused.

---

### Cycle 58 — 2026-03-20 (output.log: babylon#1293 — basename path resolution, BUG DETECTED mismatch)

**Artifacts audited:** output.log from BabylonSocial/babylon#1293 run (workdir `/root/.prr/work/03a784a488499b4d`). Exit `no_changes` after 5 push iterations; 9 fixed, 57 dismissed, 12 remaining; Pill failed 504.

**Findings:**
- **Medium (M1):** Many "Warning: primary path does not exist in workdir" for basenames like `db.ts`, `game-tick.ts`, `PerpMarketService.ts` and partial paths like `pnl-history/route.ts`, `notifications-digest/route.ts`. These paths should be resolved to full paths (e.g. `packages/db/src/db.ts`) before being used in prompts, but `resolvedPath` may not be set or resolution fails. This wastes LLM credits on phantom files.
- **Medium (M2):** BUG DETECTED mismatch occurred twice: "unresolvedIssues is empty but 1 comments are neither verified nor dismissed" (line 509) and "8 comments are neither verified nor dismissed" (line 5495). The checkEmptyIssues function correctly re-populates the queue, but the root cause (why comments are unaccounted) should be investigated — likely timing issue where comments are added during the run but not properly tracked in state.
- **Low (L1):** Many issues dismissed as "file-unchanged" (13 total) — files were not modified by the fixer tool. This could indicate path resolution issues or the fixer not targeting the right file.
- **Low (L2):** Several issues dismissed as "remaining" after "Repeated failed fix attempts (output did not match file)" — these are complex issues requiring manual review, which is expected behavior.

**Improvements implemented:**
- `tools/prr/analyzer/prompt-builder.ts`: Enhanced path resolution when `pathExists` returns false — tries extension variants (e.g. `.js` → `.json`, `.ts` → `.tsx`) and common prefixes (`apps/`, `packages/`, etc.) for basenames before logging warning. This helps resolve basenames like `db.ts` to `packages/db/src/db.ts` when the path doesn't exist.

**Flip-flop check:** N — Additive improvement; tries to resolve paths before warning, but doesn't change core behavior if resolution fails.

**Notes:** Workdir `/root/.prr/work/03a784a488499b4d`. BUG DETECTED mismatch suggests a state tracking issue where comments added during the run aren't properly marked as verified or dismissed. The checkEmptyIssues function handles this gracefully by re-populating the queue, but the root cause should be investigated in future cycles. Path resolution improvement helps with basenames but doesn't fully solve partial paths like `pnl-history/route.ts` without workdir context — those still rely on solvability.ts setting `resolvedPath` correctly.

---

### Cycle 57 — 2026-03-20 (prompts.log: eliza#6575 — conflict resolution retry prompts lack error context)

**Artifacts audited:** prompts.log from elizaOS/eliza#6575 run (45,126 lines, 52 parse error retries).

**Findings:**
- **Medium (M1):** Conflict resolution retry prompts show parse error location (e.g., "At line 463, column 40: Expected '=' for property initializer") but only include the conflict region (BASE/OURS/THEIRS snippets), not the code around line 463 where the error occurred. LLM cannot see what's wrong at the error location, leading to repeated failures (9 retries for same error at line 463).
- **Low (L1):** Syntax-fix pass (`tryFixSyntaxWithLlm`) correctly includes full file content, but only runs after retry attempts are exhausted. Retry prompts should include code around error location (e.g., ±20 lines) or show the full resolved file when error is outside the conflict region.
- **Low (L2):** Verification prompts are well-structured with clear rules for STALE vs YES, truncation handling, and citation requirements. No issues found.

**Improvements implemented:**
- **None** — Finding is for future optimization. Retry prompts should include code around parse error location (extract ±20 lines from resolved content at error line/column) or fall back to syntax-fix pass earlier when error is outside conflict region.

**Flip-flop check:** N — Audit-only; no code changes.

**Notes:** 52 parse error retries observed; 9 retries for same error at line 463 in `inMemoryAdapter.ts` suggests retry prompt lacks sufficient context. Syntax-fix pass (which includes full file) succeeds when retries fail, confirming that showing the error location improves success rate. Consider: (1) extract code around error location from resolved content and include in retry prompt, (2) skip retries and go straight to syntax-fix pass when error location is far from conflict region, or (3) include full resolved file in retry prompt when error is outside conflict region.

---

### Cycle 56 — 2026-03-20 (eliza#6575 all_fixed: 504s during conflict resolution, parse errors, long merge time)

**Artifacts audited:** output.log from elizaOS/eliza#6575 run that exited `all_fixed` (105m 12s session, 242m 45s overall).

**Findings:**
- **High (H1):** Multiple 504 timeouts during conflict resolution (4 instances) and syntax fix passes, causing 10s+20s retry delays per file. Retry logic exists but gateway timeouts still add significant latency (30s+ per failed attempt).
- **Medium (M1):** Parse errors requiring multiple retries (Expression expected, Unterminated string literal, Declaration or statement expected) — 5 files failed syntax validation after conflict resolution, suggesting LLM output quality issues or insufficient context in retry prompts.
- **Low (L1):** Base branch merge took 46m this session (183m overall) for 124 conflicted files — expected for large conflicts but could benefit from parallelization of independent files (future work).
- **Low (L2):** Audit re-queued 3 issues (samTts.ts, tsconfig.json, test-run-cli.test.ts) because final audit said UNFIXED despite being previously verified — correct behavior (safe over sorry), but spot-check of samTts.ts:45 shows the fix is present (`out.set(new Uint8Array(wav))` is correct usage).

**Improvements implemented:**
- **None** — 504 retry logic already exists (chunked fallback, exponential backoff); parse errors are handled via retry. Findings are observations for future optimization rather than bugs requiring immediate fixes.

**Flip-flop check:** N — Audit-only; no code changes.

**Notes:** Spot-checked workdir `/root/.prr/work/5102b5012b5d2a72/examples/avatar/src/runtime/samTts.ts:45` — fix present (correct `Uint8Array.set()` usage). The audit re-queue is conservative and correct. 504s during conflict resolution are gateway-level issues; retry logic is working but adds latency. Parse errors suggest LLM may need more context in retry prompts (e.g., show surrounding code, not just the conflict region). Consider parallelizing conflict resolution for independent files in future (124 files processed sequentially).

---

### Cycle 55 — 2026-03-18 (pill-output follow-ups: skip sonnet, shallow clone, prune verified, strict exit)

**Artifacts audited:** pill-output.md recurring items; code changes in this session.

**Findings:**
- **Info:** Several pill items were already implemented (mutual exclusivity, dedupe, path hints in solvability, logger bodies); remaining gaps were skip `claude-3.5-sonnet` without breaking fallback, optional shallow clone, prune stale verified IDs, early raw-vs-comments warning, strict audit exit.

**Improvements implemented:**
- `shared/constants.ts`: Skip `anthropic/claude-3.5-sonnet` (zero-fix-rate); `ELIZACLOUD_FALLBACK_MODEL` → `anthropic/claude-sonnet-4-5-20250929`.
- `shared/git/git-clone-core.ts`: `PRR_CLONE_DEPTH` → `git clone --depth N`.
- `state-core.ts` + `main-loop-setup.ts`: `pruneVerifiedToCurrentCommentIds` after fetch comments; save if pruned.
- `reporter.ts`: Warn when verifiedFixed > 2× current PR comment count.
- `index.ts` + `resolver.ts`: `PRR_STRICT_FINAL_AUDIT` → exit 2 when `getAuditOverrideCount() > 0`.
- `AGENTS.md`, `README.md`, `CHANGELOG.md` updated.

**Flip-flop check:** N — Additive/opt-in (strict exit, shallow clone); skip list + fallback alignment; state prune reduces stale IDs only.

**Notes:** Deduplicate-by-file+line and resume-partial-clone not implemented (higher risk / lower ROI).

---

### Cycle 54 — 2026-03-18 (output.log: eliza#6575, RESULTS UX + audit follow-up)

**Artifacts audited:** output.log (elizaOS/eliza#6575, branch odi-want; workdir `/root/.prr/work/5102b5012b5d2a72`). Exit merge_conflicts after 117/124 files auto-resolved, 7 manual; 94 verified from state; session ~76m; Pill failed 504 (FUNCTION_INVOCATION_TIMEOUT, ~78k char request to elizacloud).

**Findings:**
- **Low:** RESULTS SUMMARY showed green "✓ No issues remaining" next to exit merge_conflicts — review queue empty but run did not complete main loop; misleading without a line that base-merge is still blocking.
- **Info:** Same run as Cycle 53 (lastResult fix landed after that log); Pill 504 already documented (AGENTS.md: lower `PILL_CONTEXT_BUDGET_TOKENS` or inspect output.log manually).

**Improvements implemented:**
- reporter.ts: When `exitReason === 'merge_conflicts'` and `remainingCount === 0`, print a yellow line that the run is blocked on base-merge and review issues were not processed this run.

**Flip-flop check:** N — Additive UX; no behavior change to exit codes or queue.

**Notes:** Spot-checked `packages/typescript/src/database/inMemoryAdapter.ts` in workdir — no `<<<<<<<` markers at read time (workdir may differ from exact log snapshot). Cycle 53 covers `lastResult` ReferenceError in conflict resolver.

---

### Cycle 53 — 2026-03-18 (output.log: eliza#6575 re-run, merge_conflicts 7 remaining, lastResult ReferenceError)

**Artifacts audited:** output.log (elizaOS/eliza#6575, branch odi-want; workdir `/root/.prr/work/5102b5012b5d2a72` reused). State: 94 verifiedFixed. Reused partial conflict resolutions; 117 of 124 auto-resolved this session, 7 remaining; exit merge_conflicts. One file failed with "Error - ReferenceError: lastResult is not defined" (runtime-integration.test.ts). Pill 504 again (request body ~78k chars). Run stopped at base-merge.

**Findings:**
- **Medium:** When parse validation failed and resolution path was not 'chunked' or 'single' (e.g. heuristic, take-theirs, overview), `lastResult` was only declared inside the retry block, so the syntax-fix path at line 753 referenced undefined `lastResult` → ReferenceError thrown and printed as "Error - ReferenceError: lastResult is not defined". Syntax-fix pass was never attempted for that file.
- **Low:** Pill 504 on large output.log (documented in AGENTS.md).

**Improvements implemented:**
- git-conflict-resolve.ts: Declare `lastResult = result` in the outer validation-else block so it is in scope when `!parseValidation.valid`; syntax-fix path and fallback error message can use it regardless of resolution path. Fixes ReferenceError and allows syntax-fix attempt for non-chunked/single paths that produce invalid parse.

**Flip-flop check:** N — Bug fix; no behavior revert.

**Notes:** Spot-check N/A (run stopped at base-merge; 94 from state; no fix applied this run). Workdir in merge state with 7 unresolved files.

---

### Cycle 52 — 2026-03-18 (output.log: eliza#6575, merge_conflicts exit, 124 conflicts)

**Artifacts audited:** output.log (elizaOS/eliza#6575, branch odi-want, base v2.0.0; workdir `/root/.prr/work/5102b5012b5d2a72`). New workdir; 94 fixes recovered from git; merge with v2.0.0 had 124 conflicted files; 93 auto-resolved, 31 remaining; exit merge_conflicts. ~99m on "Merge base branch", 310 conflict LLM calls, ~$6.92. Pill later failed with 504 (request body ~78k chars). Run never reached fix loop.

**Findings:**
- **Medium:** Five files failed with "Resolution produced invalid syntax" (inMemoryAdapter.ts, runtime.ts, LLMStrategy.test.ts, publishPluginAction.ts, runtime-integration.test.ts) — parse errors (e.g. "Expression expected", "',' expected") after main or top+tails resolution; no syntax-fix pass was run in this log (run predates `tryFixSyntaxWithLlm`).
- **Low:** Pill 504 on very large output.log — already documented in AGENTS.md (PILL_CONTEXT_BUDGET_TOKENS, inspect manually).
- **Info:** Batch prompt 629 KB → correctly skipped runner, used per-file resolution. State saved so next run reuses 93 resolved files and only resolves 31.

**Improvements implemented:**
- None this cycle. Conflict syntax-fix pass (`tryFixSyntaxWithLlm`) and base-merge "Re-run prr to continue — already-resolved files will be reused" were added in prior work; this run predates syntax-fix. Future runs with syntax-fix may recover some of the five parse-fail files.

**Flip-flop check:** N — Audit-only; no code change.

**Notes:** Spot-check N/A (run stopped at base-merge; workdir reset on abort; 94 "fixed" from git recovery only, no fix-loop). The five parse-error files are candidates for syntax-fix pass on re-run.

---

### Cycle 51 — 2026-03-18 (pill-output improvements: state exclusivity, audit re-queue, path disambiguation, AGENTS.md)

**Artifacts audited:** pill-output.md (2026-03-18 run analysis); code and docs changes driven by pill recommendations and conversation summary (no output.log workdir spot-check this cycle).

**Findings:**
- **Medium:** Final audit could report UNFIXED for an issue that was previously verified; we trusted prior verification and kept it as verified (audit override). Pill and README "safe over sorry" principle argue for re-queuing when audit says UNFIXED.
- **Medium:** verifiedFixed and dismissedIssues could overlap (recovery/legacy state); rawVerifiedFixed could grow far beyond relevantVerified (stale IDs across iterations).
- **Low:** Ambiguous basenames (e.g. context.ts) were dismissed as path-unresolved even when comment body contained path hints (e.g. ../src/providers/context, plugins/.../context.ts).
- **Low:** AGENTS.md did not document audit re-queue behavior or elizacloud-specific empty prompts.log troubleshooting.

**Improvements implemented:**
- state/manager.ts, state-core.ts: On load, remove from verifiedFixed any ID in dismissedIssues (symmetric cleanup); warn when overlap cleaned. state-dismissed already removed from verified when dismissing.
- reporter.ts: When rawVerifiedFixed >= 3× relevantVerified, warn (pill #7) so operators see stale verified set size.
- workflow/analysis.ts: When final audit says UNFIXED for a previously verified comment, unmarkVerified and re-queue (add to failedAudit) instead of trusting prior verification; AAR still records for visibility. Reporter copy: "re-queued: audit said UNFIXED (were previously verified)".
- workflow/helpers/solvability.ts: extractPathHintsFromBody now extracts path-like strings without extension (e.g. ../src/providers/context); ambiguous basename resolution matches candidates that contain hint and end with hint+.ts/.tsx (pill #5/#10).
- AGENTS.md: Document final-audit re-queue (safe over sorry); expand troubleshooting empty prompts.log for llm-elizacloud and stderr warning.

**Flip-flop check:** Y — Final audit now re-queues when it says UNFIXED (previously we kept as verified). Intentional behavior change per "safe over sorry".

**Notes:** No output.log workdir spot-check this cycle (code/docs improvements only). Related: Stale verification / head change (33, 34), Basename / fragment path (13).

---

### Cycle 49 — 2026-03-17 (output.log: eliza#6614, all_fixed exit)

**Artifacts audited:** output.log (elizaOS/eliza#6614, branch fix-all, base v2.0.0; workdir `/root/.prr/work/919b98edcd448b7b`). PR head changed (62e95be → ec2b56b); 104 fixes recovered from git; 1 open issue (server.ts:71 InMemoryDatabaseAdapter); 1 fix applied and verified; pushed; iter 2 all verified; final audit 8 overrides; exit all_fixed. RESULTS: 13 fixed (1 this session), 13 dismissed, 0 remaining.

**Findings:**
- **Medium:** Workflow uses `state-core.loadState()` (startup/initialization); on PR head change it only updated headSha and warned "some cached state may be stale" and did **not** clear verified state. Only `StateManager.load()` cleared verified; so runs using state-core could keep stale verified IDs and skip re-verifying after rebase/revert.
- **Low:** Final audit reported 8 issues as UNFIXED but we kept them as verified (audit overrides); one of them was the issue fixed this session (server.ts InMemoryDatabaseAdapter). Audit-override visibility is already implemented (RESULTS SUMMARY yellow line, AAR section).
- **Info:** Debug table showed outdated=4, verified=9; recovery and markVerified brought total to 116 then 13 fixed in RESULTS (outdated counted in fixed when previously verified).

**Improvements implemented:**
- state-core.ts: When `ctx.state.headSha !== headSha`, clear `verifiedFixed`, `verifiedComments`, and `partialConflictResolutions` (when non-empty) and log "PR head changed (...): cleared verified state so fixes are re-checked against current code" (and partial clear message) so behavior matches StateManager and the prr-state-head-change rule.

**Flip-flop check:** N — Additive (state-core now clears on head change); aligns with existing manager behavior and audit rules.

**Notes:** Spot-checked `examples/a2a/typescript/server.ts` in workdir — conditional adapter present (useOpenAi ? undefined : new InMemoryDatabaseAdapter()); fix consistent with "don't override SQL plugin when useOpenAi".

---

### Cycle 48 — 2026-03-17 (output.log: plugin-babylon#2, merge_conflicts exit)

**Artifacts audited:** types/output.log (591 lines). Run: elizaos-plugins/plugin-babylon#2, branch odi-dev, base 1.x; workdir `/home/runner/.prr/work/225e45ff4b48714e`; 145 fixes recovered from git; merge with 1.x had 12 conflicted files; 10/12 auto-resolved, 2 failed (AutonomousCoordinator.ts parse `*/` expected, evm.ts parse `,` expected); exit merge_conflicts.

**Findings:**
- **Low:** RESULTS SUMMARY showed "145 issues fixed and verified (all from previous runs; 0 new this session)" and "No issues remaining" with exit merge_conflicts — correct but could be clearer that the run stopped at base-merge (no comment analysis).
- **Low:** When some conflicts were auto-resolved, manual instructions always say "merge from scratch"; no hint that N of M files were already resolved (we abort and reset workdir, so partial state is lost; a future improvement could leave merge in progress so user fixes only remaining files).
- **Info:** Conflict resolution: 504 on src/plugin.ts → chunked fallback succeeded; parse validation correctly rejected invalid TS (comment/syntax) on two files.

**Improvements implemented:**
- reporter.ts: When exitReason is merge_conflicts and toolFixedCount > 0, session note now "(from state; run stopped at base-merge)" so the fixed count is clearly from state/recovery, not this run.
- base-merge.ts: When some files were auto-resolved, print "(N of M file(s) were auto-resolved; K still need manual resolution.)" before "To resolve manually" so users see partial progress.

**Flip-flop check:** N — Additive (session note, progress line); no behavior revert.

**Notes:** Spot-check skipped: workdir path is on CI runner (/home/runner/.prr/work/…), not available locally. No "already verified" / "fixed" review-comment path to verify against workdir this run (exit before main loop).

---

### Cycle 47 — 2026-03-17 (Actions run: elizaos-plugins/plugin-babylon Run PRR #6)

**Artifacts audited:** [Run PRR #6](https://github.com/elizaos-plugins/plugin-babylon/actions/runs/23218797340/job/67486303608) (exit code 1, ~6m 6s). Client workflow calls `elizaOS/prr/.github/workflows/run-prr-server.yml@babylon` but does not pass `prr_ref`; server workflow input default is empty so checkout uses repo default branch (main), not babylon — can cause npm ci / lockfile or code mismatch and failure.

**Findings:**
- **Medium:** Client workflow (plugin-babylon) uses `@babylon` in `uses:` but omits `prr_ref` in `with:`. The server checks out PRR with `ref: ${{ inputs.prr_ref }}` (default ''), so the code run is from default branch, not babylon. Mismatch can produce exit code 1 (e.g. typecheck or runtime).
- **Low:** When the Run PRR step fails, the only way to see why was to download the prr-logs artifact; no tail of output.log in the job log.
- **Info:** Node.js 20 deprecation warning on the job; server workflow already sets FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 and node-version 24.

**Improvements implemented:**
- run-prr-server.yml: (1) New step "Show PRR output on failure" — if failure() and prr/output.log exists, run `tail -n 120 prr/output.log` so the error is visible in the Actions log without downloading artifacts. (2) prr_ref input description clarified: "When using @babylon in uses:, pass prr_ref: \"babylon\" so checkout matches and npm ci succeeds."
- INSTALL-WORKFLOW-OTHER-REPO.md: Troubleshooting — "If the job fails with exit code 1: Ensure you pass prr_ref when your uses: line pins to a branch (e.g. @babylon). Set prr_ref: 'babylon' in with: …". README "In any other repo": note that prr_ref must match the ref in uses:.

**Flip-flop check:** N — Additive (failure step, docs); no behavior revert.

**Notes:** Client-side fix for plugin-babylon: add `prr_ref: 'babylon'` to the `with:` block in `.github/workflows/run-prr.yml`. After the server workflow change, re-runs will show the last 120 lines of output.log in the job log on failure.

---

### Cycle 50 — 2026-03-18 (output.log audit: elizaOS/eliza#6577, verifiedThisSession across push iters)

**Artifacts audited:** output.log (elizaOS/eliza#6577, branch odi-form; workdir `/root/.prr/work/0c9c2571d63f2445`). Conflict resolved (package.json); push iter 1: 6 fixed; bail-out push iter 2 (__tests__/context.test.ts created, verification failed); push iter 3: stale re-check unmarked image.yaml + 2× metrics.py; fix iter 5 re-fixed image.yaml:78 and verified; push iter 4: all resolved, exit no_changes. RESULTS: 1 fixed, 13 dismissed, 4 remaining. Summary showed "1 issue fixed and verified (all from previous runs; 0 new this session)" despite 1 fix verified this run.

**Findings:**
- **Medium:** RESULTS SUMMARY showed "0 new this session" even though image.yaml:78 was fixed and verified in push iter 3. Cause: `verifiedThisSession` is re-initialized (new Set) at the start of each push iteration in `initializeFixLoop()`, so IDs added in a previous push iter were lost and `fixedThisSession` was 0 at report time.
- **Low:** __tests__/context.test.ts: fixer created the file but verification failed; bail-out left it uncommitted (commit skipped when no newly verified fixes). Expected; handoff correctly lists remaining issues.

**Improvements implemented:**
- push-iteration-loop.ts: Reuse `stateContext.verifiedThisSession` across push iterations when it is already a Set (from a previous push iter), instead of always using the new Set from `initializeFixLoop()`. Ensures RESULTS SUMMARY "N this session" counts fixes verified in any push iter this run.

**Flip-flop check:** N — Additive (persist same Set across push iters); no behavior revert.

**Notes:** Spot-checked workdir: `.github/workflows/image.yaml` lines 77–79 — `context: .` and `file: docker/Dockerfile` present (fix for "workflow builds Docker image from repository context"). `plugins/plugin-form/typescript/src/providers/context.ts` line 145 — `hasActiveForm: true` present (dismissed already-fixed). Remaining 4: README (PR title), metrics.py (unit tests, overall_score, relevance_error).

---
### Cycle 46 — 2026-03-17 (prompts.log improvements: crash flush, one snippet per file)

**Artifacts audited:** prompts.log audit (AUDIT-CYCLES Cycles 38, 42); shared/logger.ts writeToPromptLog; tools/prr/workflow/issue-analysis.ts batch analysis snippet building.

**Findings:**
- **Low:** Writes are buffered; on crash/kill the last entry may be truncated and break the parser (AGENTS.md "Crash / truncation"). **Done:** cork/uncork around each entry so the entry is flushed as a unit.
- **Low (Cycle 38):** Batch analysis sent the same file snippet multiple times when several issues referred to the same file (token waste). **Done:** One snippet per file; fetch once per path and reuse for all issues on that path.

**Improvements implemented:**
- shared/logger.ts: writeToPromptLog calls cork() before writing and uncork() after so each PROMPT/RESPONSE/ERROR entry is flushed as a unit; reduces truncated last entry on crash.
- issue-analysis.ts: In batch mode, group by primaryPath; compute one snippet per path (first issue’s line/body for wider/repo content); build batchInput from snippetByPath so multiple issues on the same file share one snippet.

**Flip-flop check:** N — Additive (flush behavior, token saving); no behavior revert.

**Notes:** Slug pairing (Cycle 42) and zero-content refuse (Cycle 39) already in place. When llm-api is sole fixer, subprocess may not call initOutputLog — prompts.log may be empty; use PRR_DEBUG_PROMPTS=1 (AGENTS.md).

---

### Cycle 45 — 2026-03-17 (output.log audit: evening follow-up run)

**Artifacts audited:** output.log (elizaOS/eliza#6562, 2026-03-17 evening run; PR head 1563b79, 4 push iterations, exit no_progress after 2 consecutive push iters with no verified fixes). Content from root-level output-log-audit-2026-03-17-evening.md; integrated here per docs-no-new-md.

**Findings:**
- **Positive:** exitReason non-empty (no_progress) on push iters 3–4; 422 early bail and "Stopping thread replies after 3 consecutive 422s" working; "No status checks reported for this ref" when totalChecks === 0 (startup.ts). Dedup/dismissals and fix loop behaved as intended.
- **Neutral:** Pill 504 on large audit request (~97k chars) — documented in AGENTS.md; short paths (banner.ts, reply.ts) still in dismissal-comment skip logs (full-path normalization deferred).

**Improvements implemented:**
- None this cycle (confirmation run). Prior improvements (exitReason, 422 bail, CI 0/0 message) confirmed working.

**Flip-flop check:** N — Audit-only; no code change.

**Notes:** Run matched intended behavior after recent improvements. Optional: pill truncation for very large logs.

---

### Cycle 44 — 2026-03-17 (output-log-improvements code audit)

**Artifacts audited:** Git diff of changes implementing recommendations from output-log-audit.md (thread reply 422 handling, S/R message, exitReason, long fix duration, docs). Content from root-level output-log-improvements-audit.md; integrated here per docs-no-new-md.

**Findings:**
- **Correctness:** thread-replies.ts + final-cleanup: return { ok, is422 }, consecutive 422 bail, attempted/replied counts, summary when replied < 10% attempted. execute-fix-iteration: S/R failure log line, long-duration (>120s) log line. push-iteration-loop: exitReason || 'no_progress'. AGENTS.md and QUICK_REFERENCE 422 subsection accurate.
- **Low:** Search/replace "N file(s)" can overcount when runner fails on a subset of batch; wording softened to "this batch (N file(s))".

**Improvements implemented:**
- (Already implemented before this cycle.) This cycle records the code review of those changes; tests for thread-reply return value and 422 bail added in follow-up.

**Flip-flop check:** N — Review only; no revert.

**Notes:** Logic correct; number formatting and thresholds match audit and workspace rules.

---

### Cycle 43 — 2026-03-17 (output.log audit: elizaOS/eliza#6562 run)

**Artifacts audited:** output.log from PRR run on elizaOS/eliza#6562 (8 push iters, exit no_changes; 213 comments, many dismissed; thread reply 422s; pill 504). Content from root-level output-log-audit.md; integrated here per docs-no-new-md.

**Findings:**
- **Medium:** Thread reply 422s (almost every attempt); empty exitReason on push iter 2; "File no longer exists" skip used short paths (banner.ts, reply.ts, logger.ts).
- **Low:** S/R failures and "output did not match file" — pass last apply error into fix prompt; optional summary line. Pill 504 on large request — document and consider truncation. Optional long-fix-duration log (>120s). User-facing numbers: formatNumber/toLocaleString spot-check.

**Improvements implemented:**
- Thread reply: 422 early bail (3 consecutive), user-visible summary when replied < 10% attempted, QUICK_REFERENCE 422 subsection (Cycle 44 code review).
- exitReason: push-iteration-loop sets exitReason || 'no_progress' (Cycle 44).
- Last apply error in fix prompt, S/R failure log line, long-duration log line (Cycle 44).
- Pill: AGENTS.md and pill context budget (Cycle 41); 0/0 CI message in startup.ts.
- "File no longer exists": dismissal-comments debug messages clarified (this session: skip = no place to insert comment); full-path normalization deferred.

**Flip-flop check:** N — Additive (messages, docs, thresholds); no behavior revert.

**Notes:** Dismissal-comments skip reason clarified so operators don't confuse with "file not found during fix."

---

### Cycle 39 — 2026-03-13 (wrong-file/pill/thread-replies code audit)

**Artifacts audited:** Git diff of all changes from this session (wrong-file empty allowedPaths fix, pill-output.md improvements, thread replies only after push).

**Findings:**
- **Correctness:** All changes are consistent. execute-fix-iteration ensures each issue contributes at least primaryPath to allowedPathsForBatch; per-issue filter fallback prevents empty union. addDisallowedFilesLessonsAndState only increments wrongFileLessonCountByCommentId for issues whose target was in skippedDisallowedFiles. recovery.ts already had issueTargetPaths/trulyWrong; we added allowedForIssue empty fallback and expectedStr fallback. utils.ts and getEffectiveAllowedPathsForNewIssue never leave allowedPaths empty. lessons-normalize rejects "need to modify one of: ." lessons. Thread replies for fixed issues only in commit-and-push-loop after successful push; iteration-cleanup no longer posts after incremental push.
- **Edge case:** If the only pushes in a run are incremental (iteration-cleanup) and COMMIT PHASE has no changes (hasChanges false), handleCommitAndPush is not called and no fixed replies are posted. Acceptable: the intended "right place" is the commit-and-push phase; doc (THREAD-REPLIES) states this.
- **Low:** issue-analysis diff includes unrelated isCommentPositiveOnly expansion (correctly reflects, concern, etc.); not reverted.

**Improvements implemented (this session):**
- execute-fix-iteration: base.length === 0 → [primaryPath]; per-issue filterAllowedPathsForFix with fallback to [primaryPath]; wrong-file count only for issues whose primary/allowed path in skippedDisallowedFiles; allowedStr fallback from issue primary paths when allowedPathsForBatch empty.
- recovery: allowedForIssue empty fallback after filter; expectedStr = primaryPath when allowedForIssue empty; trulyWrong excludes issue target paths (was already present).
- utils.ts: allowedPaths empty → [primaryPath] after filter in buildSingleIssuePrompt.
- issue-analysis: getEffectiveAllowedPathsForNewIssue never returns [] (filter fallback to [primaryPath]).
- logger: warn when writeToPromptLog body length 0 (PROMPT/RESPONSE) so pill/audit visibility is detectable.
- llm-api: comment that caller must match TARGET FILE(S); debug when injection paths dropped by allowedPathsForInjection.
- analysis: L1 override logs auditExplanation (result.explanation slice 300).
- no-changes-verification: WRONG_LOCATION with "Per the lessons learned" / "not allowed to modify" does not increment wrongLocationUnclearCountByCommentId (lesson-induced refusal).
- lessons-normalize: return null for lessons matching "need to modify one of: ." (empty allowed list).
- AGENTS.md: prompts.log troubleshooting (initOutputLog, promptLogStream); WHY fixed replies only after push.
- README: empty prompts.log = logging bug, see AGENTS.
- ROADMAP: lesson staleness / conflict detection item.
- iteration-cleanup: removed postThreadReplies after incremental push; comment that fixed replies only in commit-and-push phase.
- THREAD-REPLIES.md: fixed replies only after successful push (commit-and-push phase); in-run idempotency wording updated.
- tests: normalize-lesson-text.test.ts — reject "need to modify one of: ." lessons.

**Flip-flop check:** N — No reverts; thread reply removal from iteration-cleanup is intentional (replies only after push in commit-and-push).

**Notes:** commit-and-push-loop.ts unchanged (already posts after push); verifiedThisSession and repliedThreadIds shared correctly. Typecheck and full test suite pass.

---

### Cycle 40 — 2026-03-16 (output-log-audit: stale re-check vs recovered-from-git)

**Artifacts audited:** output.log (elizaOS/eliza#6562 run, 14,628 lines). Audit pain points and implementation status are integrated into DEVELOPMENT.md "Fix loop audits (output.log)".

**Findings:**
- **Medium:** Mass unmark at start of push iteration: after recovering 143 fixes from git (scanCommittedFixes), stale re-check unmarked ~35 of them ("still exists") so they were re-verified and re-attempted despite being fixed in prior runs.
- **Low:** Stale re-check ran over all verified-by-age; when changedFiles is provided we could re-check only issues whose file changed.

**Improvements implemented:**
- state/types.ts: `recoveredFromGitCommentIds` on state (session-only; cleared on load and after first use).
- repository.ts: recoverVerificationState sets `recoveredFromGitCommentIds = [...committedFixes]` after markVerified.
- state-core.ts: loadState clears `recoveredFromGitCommentIds` so we never carry it across runs.
- issue-analysis.ts: (1) Exclude recoveredFromGitCommentIds from staleVerifications and skip unmark when batch says "still exists" for those IDs on first analysis. (2) When changedFiles is provided, filter staleVerifications to only comments whose path is in changedFiles.
- AUDIT-CYCLES.md: "Before implementing audit-driven code changes" step; regression watchlist "Stale re-check / recovery"; this cycle.

**Flip-flop check:** N — Refines Cycle 38 (unmark when batch says "still exists") with a narrow exception for just-recovered IDs on first analysis only; unmark for all other verified IDs unchanged. Does not touch "when PR head SHA changes" behavior (Stale verification / head change).

**Notes:** Implemented without reviewing AUDIT-CYCLES first; doc updated so future audit-driven changes check recurring patterns and watchlist to avoid yoyoing.

---

### Cycle 41 — 2026-03-15 (output.log + prompts.log elizaOS/eliza#6576, pill 504, overlap, paths)

**Artifacts audited:** output.log and prompts.log from prr run on elizaOS/eliza#6576 (66 comments, 7 remaining); output-log-audit-improvements.md (why pill missed some findings).

**Findings:**
- **High:** Pill audit 504 — closeOutputLog invoked pill with context ~673k chars; Vercel FUNCTION_INVOCATION_TIMEOUT. **Done:** Pill enforces 60k token audit context budget and trims sections when over.
- **Medium:** Overlap verifiedFixed ∩ dismissedIssues (e.g. 11 or 18 IDs) — state had same comment IDs in both sets. **Done:** On state load, remove from dismissedIssues any commentId in verifiedFixed so sets stay mutually exclusive.
- **Medium:** Wrong test path in TARGET FILE(S) — e.g. `packages/typescript/src/types/database.test.ts` listed but real file is `src/__tests__/database.test.ts`. **Done:** getTestPathForIssueLike adds src-level __tests__ candidate and prefers it when colocated missing.
- **Medium:** Duplicate 78k fix prompt — same issue sent twice after ALREADY_FIXED. **Done:** Single-issue ALREADY_FIXED dismisses immediately so same prompt not re-sent.
- **Low:** Wrong-file / path resolution (plugin-personality without plugins/ prefix, tsconfig.js vs .json, .d.ts fragment) — stronger targeting and path tries documented; some in path-utils/REPO_TOP_LEVEL.
- **Low:** CANNOT_FIX missing caller files — consider including caller files when issue body references them; document limitation.
- **Low:** Model timeouts / debug vs summary counts — document ElizaCloud timeout and pill 60k budget (AGENTS.md, DEVELOPMENT.md).

**Improvements implemented:**
- Pill: 60k audit context budget; trim when over; no-improvements written to pill-output/summary on api_call_failed.
- State: overlap cleanup on load (dismissedIssues minus verifiedFixed).
- no-changes-verification: single-issue ALREADY_FIXED → immediate dismiss, empty updated queue.
- test-path-inference: src-level __tests__ candidate; prefer when pathExists and colocated missing.
- DEVELOPMENT.md: "Pill and log audit limits" (60k budget; output.log summarized when large so pill may miss single-line/table evidence; optional: structured extraction, head+tail of log, audit prompt extension).

**Flip-flop check:** N — All additive or narrowing (overlap cleanup, immediate dismiss, path inference).

**Notes:** Why pill didn't catch some output.log findings: log over 40k tokens is story-read (summarized), so single-line DEBUG and Model Performance table often drop; audit schema is code/docs so state/rotation suggestions may not be emitted. Recommendations (structured extraction, always include head+tail of output.log, extend audit prompt) captured in DEVELOPMENT.md for future pill improvements.

---

### Cycle 42 — 2026-03-16 (prompts.log 287k lines, slug pairing, fix prompt cap)

**Artifacts audited:** prompts.log 287,823 lines, ~695 PROMPT/RESPONSE entries from a large PR run.

**Findings:**
- **Medium:** Prompt/response slug mismatch — PROMPT #0001 had RESPONSE #0002 because both debugPrompt and debugResponse incremented the counter; responses could correlate wrong when many requests in flight. **Done:** Request-scoped slug: debugPrompt returns slug; debugResponse(slug, …) and debugPromptError(slug, …) take it; all call sites pass slug so prompt and response stay paired.
- **Medium:** Very large fix prompts (194k, 178k, 174k, 137k chars) — increased timeout risk. **Done:** MAX_FIX_PROMPT_CHARS 200_000 → 100_000 (shared/constants.ts).
- **Low:** Repeated same-size prompts (18,217 chars); tiny grouping RESPONSEs — optional dedup/skip; no change.

**Improvements implemented:**
- shared/logger.ts: debugPrompt returns string (slug); debugResponse(slug, label, response, metadata); debugPromptError(slug, label, errorMessage, metadata); slugNumber(slug) for standalone filenames.
- tools/prr/llm/client.ts and shared/runners (llm-api, opencode, gemini, cursor, codex, claude-code, aider, openhands, junie, goose): capture slug from debugPrompt, pass to debugResponse (and debugPromptError where used).
- shared/constants.ts: MAX_FIX_PROMPT_CHARS = 100_000.

**Flip-flop check:** N — Slug is additive (callers now pass slug); cap is stricter (fewer oversized prompts).

**Notes:** First-fix cap (FIRST_ATTEMPT_MAX_PROMPT_CHARS 80k) unchanged. getMaxFixPromptCharsForModel can lower cap per model if needed.

---

### Cycle 38 — 2026-03-13 (output.log + prompts.log elizaOS/eliza#6576, pill-output improvements)

**Artifacts audited:** output.log (~1132 lines), prompts.log (~7545 lines, 32 entries) from prr run on elizaOS/eliza#6576; pill-output.md (19:12 run analysis + prompts/output audit notes).

**Findings:**
- **High:** Single-issue focus: `allowedPathsForBatch` was empty for issues under `plugins/` and `benchmarks/` because those top-level dirs were not in `REPO_TOP_LEVEL`, so every fixer edit was rejected as "disallowed" or "wrong file" and issues were dismissed after WRONG_FILE_EXHAUST_THRESHOLD.
- **High:** Stale re-check: when batch analysis (e.g. "6 stale verifications - re-checking") returned "still exists" for a comment that remained in `verifiedFixed`, we never unmarked it, so the fix loop saw "All N already verified — skipping fixer" with unresolved count > 0.
- **Medium:** Final audit: for a deleted file (snippet "(file not found or unreadable)") when the review asked to "delete this file", the model returned UNFIXED; rule 6 only covered "already verified in a previous step", not "requested fix = delete file".
- **Medium:** File-unchanged dismissal too early: one fix iteration only changed one file; issues whose files were not modified were dismissed as file-unchanged and never retried when a later iteration would have modified those files.
- **Medium:** Single-issue prompt: when a lesson said "RESULT: ALREADY_FIXED - … line 69 …" and Current Code already showed the fix, the fixer still output a <change> block claiming the fix was missing.
- **Low:** Prompts.log audit: batch analysis could send the same file snippet twice for two issues on the same file (token saving: one snippet per file).

**Improvements implemented:**
- shared/path-utils.ts: Added `plugins` and `benchmarks` to `REPO_TOP_LEVEL` so paths under those dirs are no longer filtered out of allowedPaths.
- tools/prr/workflow/helpers/recovery.ts: After `filterAllowedPathsForFix(allowedForIssue)`, if result is empty, set `allowedForIssue = [primaryPath]` so single-issue always allows the issue's file. When recording "wrong file", do not count edits to the issue's target path (`primaryPath`, `comment.path`, `resolvedPath`) as wrong-file.
- shared/constants.ts: Comment on WRONG_FILE_EXHAUST_THRESHOLD documenting false-positive risk when allowedPaths was empty and that we now address it.
- tools/prr/workflow/issue-analysis.ts: When processing batch results, if result is "exists" (still exists) and the comment is currently verified, call `Verification.unmarkVerified(stateContext, comment.id)` so the issue re-enters the fix queue after a stale re-check.
- tools/prr/llm/client.ts: Final audit rule 7 — if snippet shows "(file not found or unreadable)" and the review asked to DELETE or REMOVE the file, mark FIXED.
- shared/constants.ts: `FILE_UNCHANGED_DISMISS_THRESHOLD = 2`; tools/prr/state/types.ts: `fileUnchangedConsecutiveCountByCommentId`; fix-verification: only add to unchangedIssues (and dismiss) when consecutive "file not modified" count >= 2; reset count when file is modified.
- tools/prr/workflow/utils.ts: When building single-issue prompt and any lesson mentions `RESULT: ALREADY_FIXED`, add instruction: if Current Code already shows the fix cited in ALREADY_FIXED, respond RESULT: ALREADY_FIXED and do not output <change> blocks.
- AGENTS.md, README: prompts.log / PRR_DEBUG_PROMPTS and subprocess runner note. docs/ROADMAP.md: single-issue allowedPaths item. no-changes-verification.ts: comment that full file for ALREADY_FIXED re-check would reduce false "still exists".

**Flip-flop check:** N — All additive (path allowlist, unmark on re-check, final audit rule, file-unchanged deferral, prompt nudge); no behavior revert.

**Notes:** Run matched pill-output 19:12 analysis (expectedPaths: [], wrong-file exhaust). Spot-check: workdir from log; fixes for database.ts and elizaos-core-shim.d.ts were committed and pushed.

---

### Cycle 36 — 2026-03-10 (split-exec + pill hook, .split-plan.md)

**Artifacts audited:** split-exec-output.log (2 splits, 0 commits cherry-picked), .split-plan.md, pill-output.md improvements #1–#7.

**Findings:**
- **High:** split-exec commit parser only read inline `**Commits:** sha1, sha2`; plan listed commits as bullet lines (`- \`12d870a\` (partial — …)`), so parser found 0 commits and every split was skipped (tool no-op).
- **Medium:** .split-plan.md contained duplicate YAML frontmatter (two `---` blocks); second block could confuse body offset.
- **Medium:** Pill zero-improvements path still gave one generic message from the hook; Cycle 35 had flagged distinct reasons but console output from closeOutputLog() didn’t surface them.
- **Low:** When split-exec skipped a split (0 commits), log said only "No commits listed — skipping" with no hint of what the parser saw.
- **Low:** package-lock.json bin section lacked split-exec/split-plan (npm link wouldn’t expose them).

**Improvements implemented:**
- parse-plan.ts: Extract SHAs from bullet lines matching `- \`sha\` (note)` in addition to inline **Commits:**; strip optional second frontmatter from body; add rawCommitLines per split for diagnostics.
- .split-plan.md: Removed duplicate frontmatter block.
- pill orchestrator: Distinct spinner messages per reason (no API key, no logs, zero improvements, API failed); same reasons already returned for callers.
- shared/logger.ts: When pill hook gets no result, print actionable console message per reason (no logs, no API key, zero improvements, audit failed).
- split-exec/run.ts: When 0 commits for a split, log rawCommitLines or hint that **Commits:**/bullets were missing.
- AUDIT-CYCLES.md: This cycle; header bumped to 36.

**Flip-flop check:** N — Parser and pill messages additive; no behavior revert.

**Notes:** package-lock.json bins: run `npm install` to refresh lockfile so bin includes split-exec/split-plan.

---

### Cycle 37 — 2026-03-11 (output.log BabylonSocial/babylon#1229, aria/accessibility)

**Artifacts audited:** output.log from prr run on [BabylonSocial/babylon#1229](https://github.com/BabylonSocial/babylon/pull/1229) (Ticker Enhancement; ~4m 25s, 2 issues fixed and verified, 3 dismissed).

**Findings:**
- **Medium:** SVG accessibility issue (Copilot: "PredictionArcMeter renders an unlabelled SVG — add aria-label/title") was queued, fixed, and verified, but the PR may still lack a meaningful accessible name. Root cause: (1) truncated snippet in analysis/fix so fixer saw incomplete context and may have added only `role="img"` or `aria-hidden`; (2) verifier had no rule that accessibility fixes must add a meaningful accessible name (aria-label/title with conveyed value), so any attribute change was accepted as "fixed".
- **Low:** Unresolved issues built from batch analysis used original `freshToAnalyze[i].codeSnippet` instead of the widened snippet from `batchInput[i]` when we had expanded for short or a11y — fixer prompt could still get the narrow snippet.

**What went well:** Dismissals correct (3 PR-level/Vercel/no target file). STALE→YES override worked: analyzer returned STALE ("SVG section truncated") and we correctly kept the issue in queue. Both issues sent to fixer; 2 edits applied and pushed.

**Improvements implemented:**
- prompt-builder.ts: `commentAsksForAccessibility(body)` to detect aria-label, screen reader, accessible name, unlabelled SVG, etc. Exported for issue-analysis.
- issue-analysis.ts: When building batch input, use wider snippet when `isSnippetTooShort(codeSnippet) || commentAsksForAccessibility(item.comment.body)` so analyzer and fixer get full component context. When building unresolved issues from batch results, use `batchInput[i].codeSnippet` (widened) as the issue's codeSnippet so fix prompt gets same context.
- client.ts (batch verify): Rule for ACCESSIBILITY — answer YES only if code adds a meaningful accessible name (aria-label/title with value); if only aria-hidden or role="img" with no label, answer NO and suggest adding aria-label/title with actual value.
- client.ts (final audit): AUDIT RULES rule 5 — same a11y rule for FIXED vs UNFIXED.
- prompt-builder.ts (fix instructions): New instruction 6 — for ACCESSIBILITY issues, add a meaningful accessible name; do not add only aria-hidden or role="img" without a label.

**Flip-flop check:** N — Additive (wider snippet for a11y, verifier/fix rules); no revert.

**Notes:** Re-run prr on #1229 with `--reverify` or after these changes to get proper aria-label (e.g. "X% yes") on the SVG.

---

### Cycle 22 — 2026-03-10 (prompts.log elizaOS/eliza#6562)

**Artifacts audited:** prompts.log (#0001–#0048: dedup, fix, batch verify, analysis prompts and responses)

**Findings:**
- **Medium:** Batch verifier responded with "## Fix 1: YES: ..." / "## Fix 2: NO: ..." (markdown headings) instead of "1: YES: ..." / "2: NO: ...", causing parse shortfall (parsed: 0, expected: 2); retry with stronger model parsed correctly. Prompt uses "## Fix N" as section headers, so model echoed that format.
- **Low:** Dedup prompt (#0001): model returned "GROUP: 1,3,4,5 → canonical 3" for comments on lines 2493, 2530, 2531, 2507 — violated "CRITICAL: Only group comments that have the SAME line number." Re-split logic correctly rejected; prompt could reinforce same-line check before replying.
- **Low:** Fix prompt structure (TARGET FILE(S), PR context, diff summary) is clear; single-file explicit path (Cycle 21) should reduce wrong-path attempts.

**Improvements implemented:**
- Batch verify prompt: added BAD example "Do NOT use headings: ## Fix 1: YES: ... is invalid; use 1: YES: ..." and instruction that parser expects plain lines starting with fix number.
- Batch verify parser: extended regex to accept "## Fix N: YES|NO: ..." so responses in that format are parsed (resilience when model still uses headings).

**Flip-flop check:** N — Additive prompt + defensive parser; no behavior revert.

**Notes:** Optional: dedup prompt could add "Before replying, verify every index in a GROUP has the same (line N); if any two differ, do NOT group them."

---

### Cycle 23 — 2026-03-10 (prr-logs-5 elizaOS/prr#5)

**Artifacts audited:** output.log + prompts.log from Actions run 22882523900 (gh run download); PR #5, 4 comments, 3 fixed, 1 dismissed, push failed

**Findings:**
- **High:** Push after base-branch merge used `git.push('origin', branch)` (simple-git) instead of shared `push()` from git-push.ts. In CI this led to "could not read Password for 'https://...@github.com': No such device or address" (merge push) then 403 on fix push — token was in URL but credential helper/TTY prompt still triggered; fix push already used shared push with auth URL.
- **High:** Fix push 403 "Permission to elizaOS/prr.git denied to github-actions[bot]" — workflow had `contents: read` only (fixed in earlier change: `contents: write`).
- **Medium:** types.ts:167 "add tests for parseBranchSpec/normalizeCompareBranch" — fixer created `tools/prr/github/github-api-parser.test.ts`; allowed path was different (`tests/github-api-parser.test.ts` or similar). Lesson "Fixer attempted disallowed file(s): tests/github-branch-parser.test.ts"; then "Skipping newfile — path already exists" for tests/github-api-parser.test.ts; verifier saw "code change is empty" (new file not in diff shown?). Issue dismissed as file-unchanged after single-issue attempts. Aligns with Cycle 21/22: single-file explicit path and test-path resolution for "add tests" issues.

**Improvements implemented:**
- base-merge: After merging base branch, use shared `push()` from git-push.ts with `githubToken` instead of `git.push('origin', branch)`. Ensures merge-commit push uses same one-shot auth URL and credential.helper= / GIT_TERMINAL_PROMPT=0 as fix push (avoids "could not read Password" in CI).
- run-setup-phase: Pass `config.githubToken` into `checkAndMergeBaseBranch`.

**Flip-flop check:** N — Same push path as fix loop; no behavior change for local/dev.

**Notes:** Run downloaded via `gh run download 22882523900 --repo elizaOS/prr --name prr-logs-5`. Optional: when "add tests for X" resolves to a test path that doesn't exist, ensure allowedPaths and verifier diff include the to-be-created path so newfile isn't treated as "empty change".

---

### Cycle 24 — 2026-03-10 (output.log elizaOS/eliza#6562, 737 lines)

**Artifacts audited:** output.log (same PR as Cycle 21; exit "All issues resolved", 34 fixed from prior runs, 95 dismissed, 0 remaining; 1 fix this session then no_changes)

**Findings:**
- **Low:** When exit is no_changes and 0 issues still need attention, exit details said "No changes to commit (fixer made no modifications)" — correct but could clarify that all issues were already resolved (nothing new to push). Optional from Cycle 21.
- **Low:** Dedup again returned mixed line numbers (2531, 2507); re-split → 0 groups. STALE→YES overrides applied for truncated-snippet reasons. Queue showed "(1 to fix, 8 already verified)" then "(all 9 already verified — will skip fixer)". Behavior correct.
- **Positive:** Single fix (message-service.test.ts voiceMessage rename) applied, verified, pushed; iteration 2 skipped fixer and exited cleanly; dismissal comments deduped (added: 0, skipped: 11).

**Improvements implemented:**
- When no changes to commit and 0 issues still need attention, exit details now: "All issues were already resolved (fixed or dismissed); nothing new to commit or push." (push-iteration-loop noChangesDetails)

**Flip-flop check:** N — Clarifier only; same exit reason.

**Notes:** No code bugs; run completed as intended.

---

### Cycle 25 — 2026-03-10 (prompts.log elizaOS/eliza#6562, same run as Cycle 24)

**Artifacts audited:** prompts.log (~3.3k lines, 10 entries). Phases: #0001 dedup (3 comments, runtime.ts), #0002 response, #0003 judge (63k chars, 20 issues), #0004 response, #0005 fixer (46k chars, 1 issue), #0006 response, #0007 verifier (voiceMessage fix), #0008 response, #0009 dismissal-comment (roles.ts), #0010 response.

**Findings:**
- **Low:** Dedup #0001: model returned `GROUP: 1,3 → canonical 3` for comments on lines 2531 and 2507 (different lines). Re-split logic correctly produced no cross-line merge; behavior was correct. Optional: add an explicit verification step in the dedup prompt so the model self-checks (line N) before replying.
- **Low:** Judge #0004: several STALE due to truncation (issue_8, issue_10, issue_13) with clear explanations; issue_1 NO cited lines 2511–2512; format and citations were good.
- **Positive:** Fixer #0005 addressed only the allowed issue (voiceMessage → message in message-service.test.ts), used RESULT: FIXED; verifier #0007 returned 1: YES with citation; dismissal #0009/#0010 returned EXISTING for roles.ts (comment already present). Slug correlation: prompts.log uses consecutive slugs per call (#0001 PROMPT, #0002 RESPONSE, …); correlation is an eliza logger concern (issue_3 in this run), not PRR.

**Improvements implemented:**
- Dedup prompt: added explicit verification step so the model checks (line N) for each index in each GROUP before replying; reduces wrong same-GROUP when lines differ.

**Optional follow-ups:**
- None from this audit.

**Flip-flop check:** N — Prompt clarification only; re-split already enforces same-line.

**Notes:** Run matched output.log (Cycle 24): one fix applied and verified; exit clean. Prompts.log audit confirms judge/fixer/verifier/dismissal prompts and responses were coherent and produced correct outcomes.

---

### Cycle 26 — 2026-03-10 (output.log elizaOS/eliza#6562, full run complete)

**Artifacts audited:** output.log (2,011 lines). Exit: All issues resolved; 36 fixed and verified (from previous runs), 105 dismissed, 0 remaining. No new commits this run (all already resolved); dismissal comments added: 1, skipped: 11.

**Findings:**
- **Low:** RESULTS SUMMARY and GitHub review markdown showed raw numbers for dismissed breakdown (e.g. "24 stale, 38 not-an-issue") and for fixed/dismissed counts in buildReviewSummaryMarkdown. Workspace rule requires formatNumber for user-visible numbers.
- **Positive:** Exit message correct ("All issues were already resolved (fixed or dismissed); nothing new to commit or push."). Queue and final state consistent (no remaining). Timing, token summary, model performance, and debug issue table all present. Single duplicate summary post fixed in prior commit (review only, no issue comment).

**Improvements implemented:**
- reporter.ts: use formatNumber for category counts in printFinalSummary dismissed line (24 → formatNumber(count) in categoryParts).
- reporter.ts: use formatNumber in buildReviewSummaryMarkdown for fixed count, dismissed total, per-category counts, remaining count, and "this run" note so GitHub comment matches locale formatting.

**Flip-flop check:** N — Number formatting only; no behavior change.

**Notes:** Run completed as intended; 106 LLM calls, ~$2.34 estimated cost; 36 verified from state, 105 dismissed (stale/not-an-issue/file-unchanged/already-fixed/path-unresolved).

---

### Cycle 27 — 2026-03-10 (prompts.log full run, elizaOS/eliza#6562)

**Artifacts audited:** prompts.log (~24k lines). Judge prompts ~49–82k chars; fix prompts #0005 ~85k, #0067 ~145,336 chars, #0077 ~145,178 chars (single-issue with full file injection). One TARGET FILE(S) line showed **`2Fmessage-service.test.ts`** (path segment from URL-encoding). Judge response #0050: issue_6 STALE (“truncated code doesn’t show enough of the reply action handler”).

**Findings:**
- **Medium:** Single-issue prompts (#0067, #0077) reached ~145k chars (MAX_INJECT_CHARS_TOTAL = 160k; two files at 80k each + template). Acceptable but costly; optional: lower effective cap or inject line window (±N lines) for very large files to keep prompts under ~120k.
- **Low:** Judge returned STALE for reply optimization (issue_6) because truncated reply action snippet didn’t show enough context. Optional: expand snippet for `bootstrap/actions/reply.ts` (or when comment mentions hasRequestedInState / RECENT_MESSAGES / ACTION_STATE) so judge can return YES/NO instead of STALE.
- **Low:** Path `packages/typescript/src/__tests__/2Fmessage-service.test.ts` in TARGET FILE(S) — URL-encoding artifact (“%2F” with % stripped). Paths extracted from comment body (e.g. GitHub links) can contain 2F at start of segment.

**Improvements implemented:**
- shared/path-utils.ts: added `normalizePathSegmentEncoding(path)` to strip leading "2F"/"2f" from path segments (hex for '/'); `filterAllowedPathsForFix` now normalizes then dedupes then filters so TARGET FILE(S) never show `2Fmessage-service.test.ts`.

**Flip-flop check:** N — Path normalization only; valid paths unchanged; 2F-prefixed segments become correct repo-relative paths.

**Notes:** Recorded cycles = 27. Follow-ups implemented: (1) single-issue inject cap lowered to 60k/120k in recovery.ts; (2) commentNeedsLifecycleContext extended with hasRequestedInState, RECENT_MESSAGES, ACTION_STATE, reply action handler, and getCodeSnippet uses conservative analysis for path ending in reply.ts so judge gets broader snippet.

---

### Cycle 28 — 2026-03-10 (prompts.log BabylonSocial/babylon#1207)

**Artifacts audited:** prompts.log (3,344 lines, 22 entries). Phases: #0001–#0004 dedup (3.6k / 3k chars), #0005–#0006 batch judge (43k chars, 18 issues), #0007–#0008 single verifier, #0009–#0010 batch fix (31k chars), #0011–#0014 batch verifier + single verifier, #0015–#0022 dismissal-comment (4 prompts, 4 responses: SKIP, SKIP, COMMENT, COMMENT, COMMENT).

**Findings:**
- **Positive:** Judge #0006 returned sensible YES/NO/STALE mix; verifier #0012 gave 1–4 with one NO+lesson (resolve(import.meta.dir, '..') still brittle); dismissal #0016 prompt included "Why it was dismissed: The truncated snippet ... doesn't show line 82-85" and model responded SKIP; no 2F path or ERROR entries.
- **Low:** Many "truncated — snippet was cut for prompt size" in judge prompt #0005 (43k). Judge still produced usable verdicts; optional: already have wideSnippets when context ≥100k.
- **Low:** Dismissal-comment prompt could explicitly tell the model to respond SKIP when the dismissal reason states the snippet doesn't show the referenced lines, so behavior is consistent even when surrounding code in the prompt later includes those lines (e.g. re-fetched).

**Improvements implemented:**
- llm/client.ts generateDismissalComment: added TASK item 3 — "If the dismissal reason above says the snippet does not show the lines referenced in the concern, respond SKIP (you cannot safely add a comment without seeing that code)." Renumbered previous step 3 to 4.

**Flip-flop check:** N — Additive instruction only; EXISTING/SKIP/COMMENT behavior unchanged.

**Notes:** Run was babylon PR #1207 (odi-public → staging); prompt sizes all under 50k; no single-issue 145k prompts in this run.

---

### Cycle 29 — 2026-03-10 (output.log + prompts.log BabylonSocial/babylon#1207, same run as Cycle 28)

**Artifacts audited:** output.log (784 lines), prompts.log (3,451 lines, 16 entries). Run: merge staging (forceMerge, push nothingToPush), 122 comments → 4 in queue (all verified), 3 fixes committed and pushed; iteration 2 skip fixer (prompt length 0); 1 dismissal comment added; exit all resolved.

**Findings:**
- **Positive:** RESULTS SUMMARY and dismissed breakdown use formatNumber (Cycle 26). Debug issue table Counts use formatNumber. Model performance line uses formatNumber. Merge ran with forceMerge; push reported nothingToPush (branch already up-to-date with remote). Queue line clear: "4 issue(s) entering fix loop (all 4 already verified — will skip fixer)". Fix prompt #0007 69,775 chars (under 80k cap). Judge/verifier/dismissal prompts and responses as expected.
- **Low:** When fixer is skipped because all issues in queue are already verified, debug logged "Fix prompt length → 0" and "Empty prompt or no issues - skipping fixer" — slightly ambiguous; clearer to state "all issues in queue already verified (prompt empty)" when that is the reason.
- **Optional:** Many dismissals "File no longer exists: test-unit-isolated.ts" (or generate-skills-md.ts, format.test.ts) while the file exists at scripts/test-unit-isolated.ts etc. Path resolution for "file no longer exists" could resolve fragment/basename to repo path before checking; low priority.

**Improvements implemented:**
- prompt-building.ts: when skipping fixer because prompt is empty but unresolvedIssues.length > 0, debug now "Skipping fixer: all issues in queue already verified (prompt empty)"; when no issues in queue, "Skipping fixer: no issues in queue".

**Flip-flop check:** N — Debug message wording only; no behavior change.

**Notes:** Same babylon #1207 run as Cycle 28; this audit focused on output.log flow and prompts.log sizes/phase consistency.

---

### Cycle 30 — 2026-03-10 (output.log + prompts.log BabylonSocial/babylon#1207)

**Artifacts audited:** output.log (800 lines), prompts.log (1,694 lines, 18 entries). Run: merge staging (forceMerge, nothingToPush); 136 comments → 2 in queue (1 to fix, 1 already verified); 1 fix (config/index.ts chain ID) committed and pushed; iteration 2 skip fixer (all verified); exit all resolved.

**Findings:**
- **Positive:** Queue line clear ("2 issue(s) entering fix loop (1 to fix, 1 already verified)"); single-issue fix prompt 18k chars; verifier YES for chain ID fix; RESULTS SUMMARY and dismissed counts use formatNumber; debug "Skipping fixer: no issues in queue" (Cycle 29: when all verified we now log "all issues in queue already verified (prompt empty)").
- **Low:** Iteration summary showed "Fixed: 1 issues" and "Failed: 0 issues" — workspace rule: pluralize so "1 issue" / "0 issues" (not "1 issues").

**Improvements implemented:**
- iteration-cleanup.ts: use pluralize(verifiedCount, 'issue') and pluralize(failedCount, 'issue') for iteration summary "Fixed" and "Failed" lines so output is "1 issue" / "2 issues" not "1 issues".

**Flip-flop check:** N — Display only; no behavior change.

**Notes:** Merge still reported nothingToPush (run likely before --no-ff); judge issue_5 STALE (snippet doesn't show line 1120) but issue was fixed in same run via single-issue fixer.

---

### Cycle 33 — 2026-02-11 (output.log BabylonSocial/babylon#1213, 1490 lines)

**Artifacts audited:** output.log (1490 lines). Run: new workdir, conflict resolved via LLM; 16 comments → 10 dismissed (4 stale, 6 not-an-issue) → 5 batch → 4 open; fix loop fixed 3 (run-prr.yml x2, TickerClient.tsx); push failed with "refusing to allow a Personal Access Token to create or update workflow … without `workflow` scope"; one issue ("### Code Quality (Positive)" on daily-topic-service.ts) consumed many iterations (positive-only comment); revert reported "Could not reset daily-topic-service.ts" (pathspec mismatch); second push iteration hit same workflow-scope error; stalemate bail-out, exit Error.

**Findings (improvements not already in code):**
- **High:** Push fails when token lacks `workflow` scope and PR touches `.github/workflows/`. PRR does not detect this or suggest adding workflow scope (or fixing workflow files manually). Add detection and a clear user-facing message.
- **Medium:** "### Code Quality (Positive)" (positive/summary section) was treated as fixable and burned iterations. Extend positive-section detection to headings like "… (Positive)" so they are dismissed as not-an-issue.
- **Medium:** Revert after rejected fix used `issue.comment.path` (e.g. `daily-topic-service.ts`); git reset then failed with "pathspec 'daily-topic-service.ts' did not match any files". Use the path that appears in the changed-files list (full repo path) when adding target to filesToRevert so pathspec matches.
- **Low:** After a workflow-scope push failure, consider surfacing or handling workflow-file issues differently (e.g. in AAR or next-steps) so we don’t keep fixing workflow files that can’t be pushed with the current token.

**Improvements implemented:**
- **git-push.ts:** When push fails with stderr containing "refusing to allow" and "workflow" (or "without `workflow` scope"), set a clear error message: token needs `workflow` scope for `.github/workflows` changes; add scope or fix workflow files manually.
- **solvability.ts:** Extended `isWhatsGoodOrPositiveSummaryComment` to match headings like "### Code Quality (Positive)" and "### … (Positive)" so positive-only sections are dismissed as not-an-issue.
- **recovery.ts:** When building filesToRevert after a rejected fix, avoid adding a short/basename path when the same file is already in the list under its full path (use path from filesToRevert that matches issue target; only add resolvedPath ?? comment.path if no match).

**Flip-flop check:** N — Additive detection and path logic; no behavior revert.

**Notes:** Recurring theme "Noise in queue" (positive/summary comments) reinforced. Basename/path theme (Cycle 13) related: revert used short path; fix ensures we use the path git knows (from getChangedFiles).

---

### Cycle 34 — 2026-02-11 (prompts.log BabylonSocial/babylon#1213, same run as Cycle 33)

**Artifacts audited:** prompts.log (10,870 lines, 52 entries). Phases: #0001–#0002 merge conflict resolution (predictions-route-fallback.test.ts), #0003–#0006 dedup/grouping, #0007–#0008 batch fix (36k chars, 4 issues), #0009–#0010 batch verifier, then repeated single-issue fix prompts (19k chars × many for daily-topic “Code Quality (Positive)”), verifier, dismissal. Batch fixer correctly returned "ISSUE 4 RESULT: ALREADY_FIXED" for the positive comment; issue stayed in queue and was sent repeatedly. Later prompt (#0035) showed **TARGET FILE(S): `.github/workflows/run-prr.yml`, `.github/workflows/TickerClient.tsx`** — TickerClient.tsx was wrongly placed under .github/workflows/ because getSiblingFilePathsFromComment used dir of primary (run-prr.yml) + basename from body. Fixer also tried apps/docs/content/reference/ticker-embed.md when TARGET listed "ticker-embed.md" (short path).

**Findings (improvements not already in code):**
- **Medium:** When batch fix returns "ISSUE N RESULT: ALREADY_FIXED" (or CANNOT_FIX) for specific issues, those issues are not marked resolved and remain in the single-issue queue, burning many repeated prompts. Parse per-issue RESULT lines from batch fix output and dismiss/mark resolved for ALREADY_FIXED (and optionally CANNOT_FIX) so they don’t re-enter the fix loop.
- **Medium:** getSiblingFilePathsFromComment builds path as `dir(primaryPath) + basename`. For a comment that lists multiple files in different trees (e.g. "#### \`.github/workflows/run-prr.yml\`" and "#### \`apps/web/.../TickerClient.tsx\`"), the body contains "TickerClient.tsx"; we then add ".github/workflows/TickerClient.tsx" (wrong). Prefer full path from body when the body contains a path-with-slash that includes that basename (e.g. backtick-wrapped or path-like string).
- **Low:** TARGET FILE(S) sometimes lists short paths (e.g. "ticker-embed.md"); fixer resolves to a different full path (e.g. apps/docs/content/reference/ticker-embed.md) and hits disallowed-file lesson. Prefer resolved full paths in allowedPaths when available.
- **Low:** Judge response used "issue_3: YES I1 D1 |" (pipe) instead of colons; prompt says "Use colons between fields. No pipes." Parser may accept it; optional tightening or doc.

**Improvements implemented:**
- **prompt-builder.ts (getSiblingFilePathsFromComment):** Before adding dir+basename, check if the body contains a path string that includes that basename and has a slash (e.g. \`apps/web/.../TickerClient.tsx\`). If so, use that full path instead of dir+basename so we don’t add wrong paths like .github/workflows/TickerClient.tsx.

**Flip-flop check:** N — Additive path logic; no behavior revert.

**Notes:** Batch ALREADY_FIXED parsing is a follow-up (touches execute-fix-iteration and possibly apply-batch result handling). Positive-comment dismissal (Cycle 33) would have prevented the daily-topic issue from entering the queue; batch ALREADY_FIXED handling would have cleared it after the first batch.

---

### Cycle 35 — 2026-03-10 (output.log BabylonSocial/babylon#1213, 26 comments, 0 fixes this session)

**Artifacts audited:** output.log (477 lines). Run: 26 review comments, all dismissed or verified from prior runs; 0 fixes this session; merge-base "already up-to-date"; pill produced no output (generic "No improvements to record" with no diagnostic).

**Findings:**
- **Medium:** Configured default model (e.g. anthropic/claude-3.7-sonnet) was in ElizaCloud skip list; only debug line logged "skipping (known timeout)". Operators in CI don't see why their configured model was never used.
- **Medium:** RESULTS SUMMARY showed "1 issue fixed and verified (from previous runs)" but no "0 new this session" — easy to misread as this run having fixed something.
- **Medium:** Pill zero-improvements path gave same message for no logs, no API key, API failure, and LLM returned zero; impossible to debug pill integration (e.g. empty pill-prompts.log likely = missing API key in subprocess).
- **Low:** Review path `TickerClient.ts` (no x) dismissed as missing-file while `TickerClient.tsx` exists; common bot typo; extension-fuzzy match would recover.

**Improvements implemented (pill-output.md):**
- rotation.ts: When configured default is in skip list, log user-visible warning with replacement model.
- reporter.ts: RESULTS SUMMARY when session verified = 0: "(all from previous runs; 0 new this session)".
- pill orchestrator: Distinct reasons no_logs, no_api_key, api_call_failed, zero_improvements_from_llm; callers log why.
- solvability.ts: .ts → .tsx extension typo: resolve to .tsx when exact/suffix match for alt path; debug + context hint.
- constants.ts: ELIZACLOUD_SKIP_MODEL_IDS with WHY (single source of truth); rotation.ts imports it.
- README.md: Model examples table — illustrative disclaimer and real example IDs (gpt-4o, claude-sonnet-4-5-20250929).

**Flip-flop check:** N — Additive logging, constants, and path resolution; no behavior revert.

**Notes:** Patterns align with watchlist: stale verification/head change (33/34), basename/path (13). New: silent model substitution.

---

### Cycle 31 — 2026-03-11 (output.log BabylonSocial/babylon#1207, 821 lines)

**Artifacts audited:** output.log (821 lines). Run: 140 comments, 56 dismissed upfront, 5 fresh analyses → 2 open; 2 in fix queue (1 to fix, 1 already verified); 1 fix (generate-skills-md.ts) committed/pushed; iter 2 cache reuse, exit all resolved.

**Findings (improvements not already in code):**
- **Medium:** Comments that "request confirmation about a design decision" (e.g. chain ID default) are dismissed as `stale`; they are not code staleness. Add solvability check and dismiss as `not-an-issue` with reason "Design decision / confirmation request — not a code fix" so table shows correct category.
- **Low:** Debug table "reason" can say "File no longer exists: X" when comment path is Y (LLM explanation); optionally append "(comment path: Y)" when X ≠ comment.path for clarity.
- **Low:** "unseen" count (8) has no in-log definition; add one line in table header or docs: "unseen = no decision recorded (e.g. not yet analyzed or merged in dedup)".
- **Low:** PR metadata requests still use category `stale`; optional dedicated category (e.g. `non-code-change`) so table doesn't imply code obsolescence.

**Improvements implemented:** None this cycle (audit-only).

**Flip-flop check:** N — Audit only; no code change.

**Notes:** Hedged visibility and weak-identifier stale retargeting are already in code; path resolution and create-file handling behaved as intended this run.

---

### Cycle 32 — 2026-03-11 (prompts.log BabylonSocial/babylon#1207, same run as Cycle 31)

**Artifacts audited:** prompts.log (#0001 dedup through #0020 dismissal-comment responses).

**Findings (improvements not already in code):**
- **Medium:** Dismissal-comment LLM was called for a concern dismissed as "This is requesting confirmation about a design decision (chain ID default change), not a code issue to fix." The model returned a COMMENT that was then post-filtered as "too generic, skipping". Skip the dismissal-comment LLM when reason matches design-decision/confirmation phrasing (same as we skip for "file no longer exists" and metadata).
- **Low:** Fix prompt lesson listed multiple TARGET FILE(S) from a prior batch while the current issue had a single target file; optional normalization for single-issue prompts. Optional: skip dismissal-comment LLM when reason indicates truncated snippet or line-out-of-range (no code at target to attach Note to).

**Improvements implemented:** None this cycle (audit-only).

**Flip-flop check:** N — Audit only; no code change.

**Notes:** Dedup, batch analysis, model recommendation, fix prompt, and batch verify formats and responses were correct. Create-file NOTE in batch analysis worked; verifier used plain "1: YES: ..." format.

---

### Cycle 21 — 2026-03-10 (output.log elizaOS/eliza#6562)

**Artifacts audited:** output.log (exit "All issues resolved", 34 fixed from prior runs, 90 dismissed, 0 remaining; ~78 LLM calls)

**Findings:**
- **Medium:** "Add tests for banner.ts" — TARGET FILE(S) was single path `banner.test.ts` (resolved to `packages/.../__tests__/banner.test.ts`), but fixer repeatedly created `plugins/plugin-discord/.../banner.test.ts`; disallowed-file lesson existed but model still inferred colocated path.
- **Low:** Dedup re-split: GROUP had mixed line numbers (2493, 2530, 2531, 2507) → re-split correctly yielded 0 same-line groups; no change needed.
- **Low:** Verifier sometimes responded "## Fix 1: YES..." instead of `issue_1: YES: ...` → parse shortfall; stronger model retry parsed correctly.
- **Low:** Exit when nothing to commit: "No changes to commit" could add "All remaining issues were already fixed or dismissed; nothing new to commit or push."
- **Low:** Number formatting: reminder to use `formatNumber` for user-visible counts (workspace rule).

**Improvements implemented:**
- Single-issue prompt: when `allowedPaths.length === 1`, add explicit line "The ONLY file you may create or edit for this issue is: `<full path>`. Do not create or edit files in any other directory (e.g. plugins/ or a colocated path)." (utils.ts `buildSingleIssuePrompt`)

**Flip-flop check:** N — Additive prompt clarity; no behavior revert.

**Notes:** Optional follow-ups: verifier prompt BAD example for "## Fix N" format; final summary line when 0 remaining and no commit; optional dedup fallback "within N lines" when re-split yields 0 (low priority).

### Cycle 21 (stashed) — 2026-03-05 (output.log + prompts.log follow-up on hidden test-file targets)

**Artifacts audited:** output.log + prompts.log for the `generate-skills-md` run, especially repeated `WRONG_LOCATION` / disallowed-file attempts and polluted lesson sections

**Findings:**
- **High:** PRR still knew the review was about a test file import bug but kept building TARGET FILE(S) around `scripts/generate-skills-md.ts` only, so the fixer repeatedly tried plausible test files and got blocked as disallowed.
- **Medium:** Repeated `WRONG_LOCATION` / `CANNOT_FIX` answers that all said "the real bug is in a hidden test file" still went through normal retry loops when no concrete target could be inferred.
- **Medium:** File-scoped lessons for `scripts/generate-skills-md.ts` leaked unrelated failures (YAML indentation, duplicate op mapping) into the import-path issue prompt.

**Improvements implemented:**
- Added hidden test-target inference for review comments describing bugs in a test file attached to an implementation file; use it during issue creation, prompt building, retry allowlist expansion, and recovery.
- Persist inferred hidden test targets after `WRONG_LOCATION` / `UNCLEAR` / `CANNOT_FIX`, and dismiss after repeated misses when no concrete target can be inferred.
- Added `getLessonsForIssue(...)` so prompts use issue-scoped lessons instead of every lesson ever recorded for the same file.

**Flip-flop check:** N — This continues the same direction as earlier cycles: make TARGET FILE(S) more accurate, reduce repeated wrong-file retries, and cut prompt noise instead of broadening prompts indiscriminately.

**Notes:** The hidden-target inference is intentionally conservative: it only triggers when the review explicitly says the bug is in a test file/import path, and it prefers existing conventional test paths before offering guessed ones.

---

### Cycle 20 — 2026-03-05 (output.log + prompts.log follow-up on pathspec crashes and partial batches)

**Artifacts audited:** output.log (pathspec errors like `sentry-bun.d.ts` / `test-unit-isolated.ts`), prompts.log batch fix prompts, cleanup/verification/commit flows

**Findings:**
- **High:** Canonical-path propagation was still incomplete after Cycle 19: later cleanup/verification/commit paths could still use raw truncated review paths, so the fixer succeeded on the real file and a later `git add` / hashing / reporting step crashed on the short path.
- **High:** PRR could skip the fixer because everything in queue was already verified, yet still create and push a commit from unrelated dirty files already present in the worktree.
- **Medium:** Test-file naming issues were modeled as sibling-file edits (`.../test.ts`) instead of rename-target edits (`.../generate-skills-md.test.ts`), causing the real destination path to be rejected as disallowed.
- **Medium:** Multi-issue batch prompts allowed a response to say `RESULT: FIXED` while silently skipping one issue.

**Improvements implemented:**
- Added shared `getIssuePrimaryPath()` and propagated canonical paths through iteration cleanup, snippet refresh, no-changes verification, verification failure escalation, dismissal bookkeeping, and commit-message file matching.
- Added a commit/push gate so dirty leftover workspace changes are not committed unless the current push iteration actually produced newly verified, uncommitted fixes.
- Added rename-target inference for `.test.ts` / `.spec.ts` naming comments and filtered out fake sibling matches like bare `test.ts` extracted from extension prose.
- Tightened multi-issue prompts so untouched issues must be called out with `ISSUE N RESULT: ...` instead of hiding behind a batch-level success line.

**Flip-flop check:** N — This continues the same direction as Cycles 15 and 19: stricter path correctness, tighter scope control, and less silent ambiguity.

**Notes:** The commit gate intentionally prefers "skip commit" over guessing whether unrelated dirty files are safe to publish. That is conservative, but it prevents the higher-severity failure mode of shipping leftover workspace changes under a misleading "fixed review comments" commit.

---

### Cycle 1 — 2026-03-04 (output.log + queue/verification messaging)

**Artifacts audited:** output.log (single run), execute-fix-iteration, prompt-building, fix-verification, analysis.ts

**Findings:**
- **High:** (none)
- **Medium:** Queue said "5 issue(s) entering fix loop" then "No issues to fix" / "All 5 already verified" with no explanation; prompt size ~82k–98k for 1–2 issues; global lesson (plugin-sql test path) shown when fixing unrelated files.
- **Low:** Verification line "X file(s) not modified - issues marked as failed" ambiguous; two "still in queue" lines when both unchanged and failed.

**Improvements implemented:**
- Queue subtitle: show "(N to fix, K already verified)" or "(all N already verified — will skip fixer)".
- Single verification "still in queue" line with detail (file not modified / failed verification).
- Cap global lessons to 1 when ≤2 issues; filter global lessons by path relevance (first segment).
- Skip redundant "No issues to fix" / detailedSummary when caller shows "already verified — skipping fixer".
- Trim diff summary to 2500 chars for batches with ≤2 issues.

**Flip-flop check:** N — No reverts; additive clarity and caps.

**Notes:** First cycle that formalized "Recurring patterns" and regression watchlist.

---

### Cycle 2 — 2026-03-04 (prompts.log + snippet/lesson/diff)

**Artifacts audited:** prompts.log (same run, fix + verify + analysis prompts)

**Findings:**
- **High:** (none)
- **Medium:** Analysis verifier often returned "YES … snippet truncated; cannot verify" when snippet was placeholder or too short; fix prompt included unrelated global lesson (plugin-sql) for exec_evaluator.py / DOCUMENTATION_COMPLETE.md.
- **Low:** Prompt payload very large for 1–2 issues; model recommendation reasoning referenced "context inference" even when verifier said snippet missing.

**Improvements implemented:**
- Export `isSnippetTooShort`; in batch analysis, when snippet too short, replace with `getWiderSnippetForAnalysis` (anchor-aware, 80-line window, 12k cap).
- Filter global lessons by path relevance (first path segment) so cross-domain lessons don’t dominate.
- Trim diff summary for ≤2 issues (2500 chars) in fix prompt builder.

**Flip-flop check:** N — Same direction as Cycle 1 (smaller, relevant context).

**Notes:** Audit of Cycle 2 changes found `getWiderSnippetForAnalysis` ignored `commentBody`; fixed in follow-up to use same anchor logic as `getCodeSnippet`.

---

### Cycle 3 — 2026-03-04 (audit of Cycle 2 code changes)

**Artifacts audited:** issue-analysis (getWiderSnippetForAnalysis), prompt-building (pathRelevantGlobal), prompt-builder (diff trim, isSnippetTooShort export)

**Findings:**
- **High:** (none)
- **Medium:** `getWiderSnippetForAnalysis` took `commentBody` but did not use it; window could miss relevant code when line refs were in body.
- **Low:** Global lesson path filter is heuristic (no parseable path → keep lesson); acceptable.

**Improvements implemented:**
- `getWiderSnippetForAnalysis`: use same anchor logic as `getCodeSnippet` (line + LOCATIONS block + `parseLineReferencesFromBody`), center 80-line window on anchor range.

**Flip-flop check:** N — Refinement only; no behavior reverted.

---

### Cycle 4 — 2026-03-04 (output.log single-run improvements)

**Artifacts audited:** output.log (elizaOS/eliza#6509, 1 fix + 5 already verified), prompts.log #0001–#0008

**Findings:**
- **High:** (none)
- **Medium:** Model recommendation called for 1 fixable issue (~4s + tokens); push iteration 2 re-displayed full queue then skipped fixer (noise); irrelevant global lesson (plugin-sql disallowed file) in fix prompt for benchmarks file.
- **Low:** Lessons block duplicated in detailed summary and prompt; timing "Total" row in overall section showed session total.

**Improvements implemented:**
- Skip model recommendation when toFixCount ≤ 1 (issue-analysis).
- When all in queue already verified, show queue header + closing line only, no per-file box (analysis.ts).
- Detailed summary: lessons header only, no duplicate bullet list; full list stays in "## Lessons Learned" in prompt (prompt-builder).
- Filter file-specific lessons by path relevance (mentioned path root vs affected roots); added "disallowed" to path regex (prompt-building).
- Skip "Total" row in overall timing breakdown so "Overall total" is unambiguous (logger).

**Flip-flop check:** N — Additive; no behavior reverted.

---

### Cycle 5 — 2026-03-04 (prompts.log #0001–#0008, 7 issues, 1 fixed)

**Artifacts audited:** prompts.log (elizaOS/eliza PR, verifier + model-rec + fix + judge, 8 entries)

**Findings:**
- **High:** (none)
- **Medium:** (M1) Verifier YES + "this is actually correct / comment is mistaken" contradiction not caught — issue_5 sent to fixer unnecessarily. (M2) Verifier NO for summary/meta-review comment (issue_7) with backwards reasoning ("table shows ❌ Still missing" = resolved?). Summary comments shouldn't be treated as fixable issues. (M3) Snippet unavailable for issue_3 (DATABASE_API_README.md) — wider-snippet fallback didn't produce content; fixer would get no code context.
- **Low:** (L1) Model recommendation truncates explanations at 120 chars, cutting off critical nuance ("this is actually correct"). (L2) Generic "Fixer made no edits" lesson doesn't specify which file/issue. (L3) Diff summary ~2500 chars for 1-issue D1 batch; could trim further or omit for single-issue.

**Improvements implemented:**
- (M1) YES→NO override: detect "already correct", "comment.*mistaken", "actually correct", "code is correct" in YES explanations and flip to NO.
- (L1) Increase model recommendation explanation snippet from 120 to 200 chars.
- (L3) Trim diff summary to 1500 chars (from 2500) for 1-issue batches.

**Deferred (later implemented in follow-up):**
- (M2) Summary/meta-comment detection — implemented: `isSummaryOrMetaReviewComment` in solvability (status table or "### Summary" + 3+ status phrases); dismiss as not-an-issue.
- (M3) Snippet unavailable when file not in workdir — implemented: `getFileContentFromRepo` in FindUnresolvedIssuesOptions (git show HEAD:path); used in batch analysis when snippet is "(file not found or unreadable)".
- (L2) File-specific no-changes lesson — implemented: single-issue no-changes add lesson with "Fix for path:line - ..."; batch keeps global with "(N issues in batch)".

**Flip-flop check:** N — Additive overrides and cap adjustments; no behavior reverted.

---

### Cycle 6 — 2026-03-04 (code audit of Cycles 4–5 changes)

**Artifacts audited:** All code changes from Cycles 4–5 and the exhausted-in-AAR/handoff feature: client.ts (verifier overrides), solvability.ts (summary detection), issue-analysis.ts (snippet fallback, model-rec snippet, buildSnippetFromRepoContent), prompt-builder.ts (diff trim), no-changes-verification.ts (file-specific lessons), reporter.ts (exhausted in AAR/handoff/summary), final-cleanup.ts (exhausted gating), resolver.ts + run-orchestrator.ts (DismissedIssue import/type).

**Findings:**
- **High:** (none)
- **Medium:** (M1) YES→NO override `\balready (?:implements?|addressed|handled|correct)\b` too broad — could false-positive on "already implements X but comment asks for Y too" (partial fix). (M2) `buildSnippetFromRepoContent` was a 55-line copy-paste of `getWiderSnippetForAnalysis` windowing logic — maintenance risk.
- **Low:** (L1) Dead variable `explanationLower` in client.ts (declared, never used). (L2) No-changes lessons produced `"Fix for path:null - ..."` when `comment.line` is null.

**Improvements implemented:**
- (M1) YES→NO override now has a `hasCounterSignal` guard: skip override when explanation also says "still needs/exists/missing" or "but/however ... missing/needs/lacks/doesn't".
- (M2) Extracted `buildWindowedSnippet(fileContent, line, commentBody)` shared helper; `getWiderSnippetForAnalysis` and `buildSnippetFromRepoContent` both delegate to it.
- (L1) Removed dead `explanationLower` variable.
- (L2) No-changes lessons now use `${path}${line != null ? `:${line}` : ''}` — omits line when null.

**Not changed (reviewed, correct):**
- `isSummaryOrMetaReviewComment`: second regex alternative is broader but not a bug (defense in depth).
- `getFileContentFromRepo` only wired in `main-loop-setup.ts`: confirmed that `processCommentsAndPrepareFixLoop` is the sole entry point for `findUnresolvedIssues` in both initial and push-iteration paths.
- Exhausted-in-AAR/handoff: `printAfterActionReport` derives exhausted from `stateContext` internally; `printHandoffPrompt` receives them as parameter. Both paths consistent.
- DismissedIssue imports in resolver.ts and run-orchestrator.ts: proper named imports, correct paths.

**Flip-flop check:** N — Refinements only; no behavior reverted.

---

### Cycle 7 — 2026-03-04 (output.log run elizaOS/eliza#6509)

**Artifacts audited:** output.log (full run), recovery.ts, llm-api injection, reporter, execute-fix-iteration, commit-and-push-loop, startup/CodeRabbit.

**Findings:**
- **High:** Single-issue focus had no file content injected when target file missing in workdir (sparse checkout) — fixer said "I don't see enough context". Wrong-file branch treated prior successful fix (component.test.ts) as "wrong" on next attempt, adding noisy lesson and reverting only new changes.
- **Medium:** Four exhausted entries for same reporting.py:395 bug (enumerate rank). Verifier YES with "snippet truncated/unavailable" not overridden to STALE. Disallowed-file lesson added as global, polluting prompts for unrelated files.
- **Low:** Commit message "misc: improve code quality" vague. Model recommendation reasoning truncated. CodeRabbit mode re-detected post-push (manual → unknown), redundant trigger messaging.

**Improvements implemented:**
- (M1) Single-issue prompt: when target file not in workdir, inject content via `git show HEAD:path` into prompt so fixer has code for search/replace.
- (M2) sessionChangedFiles tracks files fixed this run; "Do NOT edit these files (already fixed this run)" added to prompt; wrong-file branch only adds lesson/reverts when actuallyNewWrong (not in filesBeforeFix); successful verify adds file to sessionChangedFiles.
- (M3) dedupeExhaustedByLocation(filePath, line) in reporter; handoff, AAR, and final summary use deduped exhausted count/list.
- (M4) Batch override YES→STALE when explanation contains "snippet truncated", "snippet unavailable", "cannot verify.*truncated|unavailable".
- (M5) Disallowed-file lesson file-scoped: add "Fix for path:line - ..." per path in batch so lesson only appears when fixing that file.
- (L1) extractDescription: single file + comment mentions test/coverage → "add tests for &lt;base&gt;".
- (L2) Model recommendation prompt: "Give at least one full sentence of issue-specific reasoning".
- (L3) CodeRabbit mode cached from setup (codeRabbitMode); passed to handleCommitAndPush and triggerCodeRabbitIfNeeded(cachedMode) to avoid re-detection.

**Follow-up fixes (post-audit):**
- M2: sessionChangedFiles now tracks all changed-and-allowed files (changedExpected), not just the verified file, so auxiliary files (e.g. test) aren’t reverted on the next single-issue attempt.
- M4: Single snippet-unavailable regex; YES→STALE applied first, then STALE→YES only when explanation does not indicate truncated/unavailable (avoids double-override in logs).
- M5: Extracted addDisallowedFilesLessonsAndState(); both failure and success paths call it so state (wrongFileLessonCountByCommentId, test-file allowlist) is updated consistently.
- M1: MAX_INJECT_CHARS_TOTAL for total cap; removed dead typeof check; debug log in catch.
- L1: Word boundaries in commit-message regex: \btest\b|\bcoverage\b to avoid matching "latest".
- Strip audit-cycle comment markers (M1, M2, L3, etc.) from code comments.

**Flip-flop check:** N — Additive; no behavior reverted.

---

### Cycle 8 — 2026-03-04 (prompts.log audit: WRONG_LOCATION loops, lesson scope, model rec)

**Artifacts audited:** prompts.log (elizaOS/eliza PR, 6 issues verified, patchComponent + ast_evaluator/metrics/DOCUMENTATION_COMPLETE stuck in WRONG_LOCATION).

**Findings:**
- **Medium (M1):** Verifier got truncated snippets → YES → fixer got same truncated context in single-issue mode → repeated WRONG_LOCATION. No wider snippet on retry.
- **Medium (M2):** "Previous Failed Attempts" included global lessons from other issues (e.g. "Fixer attempted disallowed file(s): component.test.ts" when fixing ast_evaluator.py).
- **Medium (M3):** WRONG_LOCATION with "doesn't exist in current file" didn't trigger re-verify; fixer correctly refused but system kept retrying.
- **Low (L1):** Model recommendation didn't weight overall success rate; recommended gpt-4o-mini (10% success) over higher-rate models.

**Improvements implemented:**
- (M1) When WRONG_LOCATION detail matches "not visible|truncated|doesn't exist|not in the provided", set `state.widerSnippetRequestedByCommentId[commentId] = true`. On next single-issue build, resolver calls `getWiderSnippetForAnalysis(workdir, path, line, body)` and passes override to `buildSingleIssuePrompt`. Exported `getWiderSnippetForAnalysis` from issue-analysis.
- (M2) Added `getLessonsForSingleIssue(ctx, issueFilePath)`: file-scoped lessons for path + global lessons only if path-relevant (exclude globals that mention "TARGET FILE(S): other/path" for a different path). Single-issue prompt uses this instead of `getLessonsForFiles([issue.comment.path])`.
- (L1) Model recommendation prompt: added "Weight overall success rate heavily — a model with 50% success is much better than one with 10%..." and same in system prompt.

**Flip-flop check:** N — Additive state and filtering; no behavior reverted.

---

### Cycle 9 — 2026-03-04 (prompts.log full-run audit: file corruption loop, verifier stalemates, diff bloat)

**Artifacts audited:** prompts.log #0001–#0178 (full run, elizaOS/eliza "great database refactor" PR, ~1.8 MB, 178 entries across 5 models)

**Findings:**
- **High (H1):** Placeholder file corruption cascade. gpt-4o (#0050, 107K prompt) wrote literal `"COMPLETE FILE CONTENTS WITH FIXES"` into `stores/plugin.store.ts` and `component.test.ts`. Every subsequent fix attempt (10+ across 5 models, ~500K+ input chars) hit CANNOT_FIX on these corrupted files. No circuit breaker detected the repeated CANNOT_FIX pattern. gpt-4o (#0136, #0152) later hallucinated entire fake files instead of returning CANNOT_FIX, and qwen-3-14b verifier (#0154) approved the hallucinated code.
- **High (H2):** Verifier stalemate on already-fixed code. The `reporting.py` enumerate/rank bug was correctly fixed in #0020 but the verifier kept rejecting (7+ cycles through #0048), burning ~180K chars. Each retry corrupted the file further (duplicate blocks, syntax errors). The verifier saw only lines 1–50 of a 500-line file — the fix at line ~383 was never visible.
- **Medium (M1):** Diff summary bloat in batch prompts. Every batch fix prompt (#0049, #0105, #0111, #0115, #0123, #0125, #0133, #0135) included the full PR diffstat (~1,400 lines, ~60K chars listing 1,211 changed files). For 1–3 file fixes this is 100% noise. Total waste: ~480K chars across 8 prompts.
- **Medium (M2):** Approval/summary comments treated as fixable issues. Two of three "issues" in the late-run batch were approval comments: `component.test.ts` ("All critical issues addressed ✅") and `reporting.py` ("Approve. All critical issues have been resolved."). These survived dedup and existence checks and consumed 10+ fix cycles.
- **Medium (M3):** Verifier false positives from truncated snippets in existence checks (#0084, #0086, #0158, #0160). qwen-3-14b defaulted to YES when code was truncated, triggering unnecessary fix cycles for issues that may have been resolved.
- **Medium (M4):** gpt-4o-mini hallucinated search blocks (#0062) with fabricated code (`const someVariable = data as any;`, `function processItem`) when given placeholder files. gpt-4o (#0136, #0152) fabricated entire file implementations. No guard against writing hallucinated full-file content.
- **Low (L1):** Dedup response contradiction (#0002): `GROUP: 1,2,3 → canonical 3` then `NONE` on next line. System accepted both without detecting the conflict.
- **Low (L2):** Lesson extraction (#0012, #0174) produces lessons that restate the rejection verbatim rather than providing actionable insight.
- **Low (L3):** System accumulated lessons like "CANNOT_FIX: file content missing" but kept retrying with the same broken input — lessons were appended to prompts but never acted on by the orchestrator.

**Improvements implemented (prior conversation):**
- (H1 partial) `findLargerFileByBasename`: when injected content < 200 chars for a code file, search workdir by basename for the real file. Also handles missing files (fragment path doesn't exist).
- (H2 partial) `bugPatternAbsentInCode` + `AUTO_VERIFY_PATTERN_ABSENT_THRESHOLD=5`: after 5 verifier rejections, if the review's bug patterns (backtick code, enumerate(), range(), etc.) are absent from current code, auto-verify to break stalemates.
- (H2 partial) Escalation delay fix: `getEscalatedFiles` no longer delays full-file rewrite for simple issues when already over the failure threshold (was `isSimpleFile && overThreshold && !notInjected`, now `isSimpleFile && !overThreshold && !notInjected`).
- (L3 partial) Wrong-file single-issue cap: issues with 3+ wrong-file attempts skip `trySingleIssueFix` to avoid endless retries.

**Improvements implemented (this cycle):**
- (H1) Circuit breaker: `cannotFixMissingContentCountByCommentId` state counter + `CANNOT_FIX_MISSING_CONTENT_THRESHOLD=2` in constants. After 2 CANNOT_FIX citing "file content missing/placeholder", solvability check dismisses the issue as exhausted.
- (H1) File content validation: `isPlaceholderContent()` in llm-api detects "COMPLETE FILE CONTENTS", "[Previous content remains identical]", etc. and skips injection. Also skips injection when file doesn't exist and basename fallback finds nothing.
- (M1) Diff summary cap for batch prompts: extended from 2-issue cap to all batches. ≤1 issue: 1500 chars, ≤2: 2500, ≤5: 5000, >5: 10000. For medium+ batches, filters to only lines mentioning files in the batch before truncating.
- (M2) Approval comment filter: `isApprovalComment()` in solvability detects "Approve", "All issues addressed/resolved", "LGTM" and dismisses as not-an-issue.
- (M4) Hallucination guard for full-file rewrite: when `<file>` block output is < 15% the size of the original file (and original > 1000 chars), reject as likely hallucinated stub. Also rejects placeholder content in `<file>` blocks.
- (L1) Dedup contradiction: GROUP lines are now parsed first; NONE is only honored when no GROUP lines were found (fixes "GROUP: 1,2,3 → canonical 3" + "NONE" contradiction).

**Flip-flop check:** N — All changes are additive guards and circuit breakers; no behavior reverted.

**Notes:** This run had ~65% token waste rate (~230K input tokens wasted of ~350K total). The two dominant waste patterns (placeholder corruption cascade + verifier stalemate on already-fixed code) account for ~80% of the waste. The basename-fallback and auto-verify-pattern-absent fixes from the prior conversation address the root causes but the circuit breaker and validation guards are needed to prevent the cascade when those heuristics miss.

---

### Cycle 10 — 2026-03-04 (prompts.log audit: dedup, verifier strength, dismissal comments, multi-file)

**Artifacts audited:** prompts.log (BFCL/reporting.py run: grouping, triage, fix, verifier, model rec, dismissal-comment prompts)

**Findings:**
- **Medium (M1):** Dedup returned NONE for 4 comments on same file; comments [2] and [4] (different authors) described same async/caller mismatch — should have been grouped.
- **Medium (M2):** Verifier (qwen-3-14b) approved both fixes; Opus correctly rejected Fix 2 (print_results still calls generate_report() without await/args). Weak verifier missed call-site bug.
- **Medium (M3):** Dismissal-comment prompt sent for file with reason "File no longer exists: stores/task.store.ts" — LLM asked to write comment in missing file.
- **Low (L1):** Dismissal comments from gpt-4o-mini were generic ("extracts relevant metrics", "Adds section header") — narrating code, not design intent.
- **Low (L2):** Fix prompt had runner.py in TARGET FILE(S) but fixer only edited reporting.py; verifier caught missing call-site update. Multi-file nudge would help.

**Improvements implemented:**
- Skip dismissal-comment when reason matches "file no longer exists" / "file not found" (dismissal-comments.ts).
- Post-filter generated dismissal comment when it mostly restates surrounding code (words ≥4 chars, 2–8 words, ≥2 match code) → return needed: false (llm/client.ts).
- Heuristic dedup: same file + same primary symbol + same caller file (callerFileFromBody) → merge even when authors differ (issue-analysis.ts).
- Multi-file nudge in fix prompt: when allowedPaths.length > 1 and body mentions callers (calls/caller/await/file:line), add line "This issue requires changes in **all** listed files — update implementation and every call site so signatures match" (prompt-builder.ts).
- Verifier model floor: fixes whose comment mentions API/signature (async, await, caller, TypeError, method accepts/takes) verified with stronger model when available (fix-verification.ts commentMentionsApiOrSignature + split fixesApiSignature / fixesDefaultRest).

**Flip-flop check:** N — Additive filters and nudges; no behavior reverted.

**Notes:** Repeating themes across cycles: (1) verifier/snippet — weak model or truncated snippet leads to wrong YES/NO; (2) dedup — same issue from different authors or phrasings not merged; (3) dismissal/noise — wrong things get fix or comment attempts; (4) multi-file — fixer updates one file but not call sites. Cycle 10 addresses these with heuristic dedup, verifier strength for API fixes, dismissal skips and post-filter, and multi-file nudge.

---

### Cycle 11 — 2026-03-04 (prompts.log audit follow-up: M2, L1, L2, L4)

**Artifacts audited:** Same run as Cycle 10 (prompts.log #0001–#0020, output.log 20:50–20:52)

**Findings addressed:**
- **M2:** Verifier escalation sent same file twice in separate opus-4.5 calls (API/signature batch + previous-rejections batch) — batch them into one stronger-model call.
- **L1:** Dismissal comment generated for positive-feedback review ("✅ What's Good" / "no actionable issue") — skip when reason indicates positive feedback or no actionable issue.
- **L2:** Global lessons in fix prompt included generic retry advice ("Fixer made no edits… try another model") and file-unrelated lessons — filter out generic "try another model/strategy" lessons.
- **L4:** Full dismissed summary (by category + reasons) reprinted on push iteration 2 when analysis cache was reused — show one line only when reused.

**Improvements implemented:**
- (M2) fix-verification.ts: Combine `fixesApiSignature` and `fixesStronger` into a single `fixesForStronger` array when both use stronger model; one `batchVerifyFixes(fixesForStronger, { model: strongerModel })` call instead of two.
- (L1) dismissal-comments.ts: Skip dismissal comment when `issue.reason` matches `/positive feedback|no actionable issue|no issue to address/i`.
- (L2) prompt-building.ts: Filter global lessons with `isGenericRetry(lesson)` (try another model/strategy, fixer made no edits and gave no explanation) before path-relevance filter.
- (L4) analysis.ts: When `analyzeTime === 0` (reused cache), print only "Issues dismissed: N total (cached)"; skip per-category breakdown and dismissal reasons.

**Flip-flop check:** N — Additive batching and filters; no behavior reverted.

---

### Cycle 12 — 2026-03-05 (output.log + prompts.log audit: couldNotInject loop, new-comment solvability, ALREADY_FIXED re-queue, STALE overuse)

**Artifacts audited:** output.log (elizaOS/eliza-cloud-v2#373, ~2h session, 74 fix iterations, 22450 lines), prompts.log (same run, 260972 lines, 1386 entries), and code: push-iteration-loop, fix-loop-utils, fix-iteration-pre-checks, execute-fix-iteration, llm/client.ts.

**Findings:**
- **High:** (none)
- **Medium (M1):** couldNotInject threshold (3) only checked in findUnresolvedIssues (start of push iteration). Inside the fix loop, single-issue focus kept retrying the same 4 comments; count reached 11+ and they were never dismissed until exit — ~40–50 wasted iterations.
- **Medium (M2):** New bot comments added mid-loop (processNewBotReviews) were pushed into unresolvedIssues without assessSolvability. (PR comment), lockfiles, and other unsolvable paths entered the fix queue and burned 10+ iterations each with RESULT: UNCLEAR.
- **Medium (M3):** Batch fix prompt re-included issues the fixer had already said ALREADY_FIXED 2× in single-issue mode (e.g. server-wallets, topup/10, topup/100). Same issues sent again in 64k+ batch; fixer again returned ALREADY_FIXED — token waste.
- **Medium (M4):** Verifier returned STALE when explanation was "can't be evaluated", "code doesn't show", "only shows the beginning", "incomplete" — judge instructions say use YES when code/snippet not visible. 48 such STALE verdicts in prompts.log; override regex missed these phrasings.
- **Low (L1):** Duplicate `StateContext` import in fix-loop-utils (P1 change added redundant import). Dismissed new comments not added to existingCommentIds → would be re-fetched as "new" next time. "only shows" STALE→YES regex could false-positive on legitimate STALE ("file only shows re-export now").

**Improvements implemented:**
- **couldNotInject in-loop:** At start of each fix iteration, filter unresolvedIssues by couldNotInjectCountByCommentId >= threshold; dismiss and remove from queue; log count; if queue empty, set allFixed and break. Use Set for dismissed IDs. (push-iteration-loop.ts)
- **P1 (new-comment solvability):** processNewBotReviews accepts optional workdir + stateContext. When both present, run assessSolvability on each new comment before adding; dismiss unsolvable with Dismissed.dismissIssue; only add solvable comments to comments + unresolvedIssues. Add workdir to executePreIterationChecks signature and pass from push-iteration-loop. Track all new comment IDs in existingCommentIds before solvability so dismissed comments are not re-fetched. (fix-loop-utils.ts, fix-iteration-pre-checks.ts)
- **P2 (STALE→YES):** Expand override in llm/client.ts: can't evaluate, cannot assess/determine/verify, (code|snippet|excerpt|current code) doesn't show, only shows + (not|beginning|start|first|lines N), incomplete + (show|visible|implementation), not visible/shown/included in excerpt/code/snippet. Tighten "only shows" so it does not match legitimate STALE ("only shows re-export").
- **P3 (ALREADY_FIXED filter):** In execute-fix-iteration, exclude from issuesForPrompt any issue with consecutiveAlreadyFixedAnyByCommentId >= 2 (in addition to already-verified).
- **Audit follow-ups:** Removed duplicate StateContext import (fix-loop-utils). existingCommentIds.add(comment.id) before solvability loop so dismissed comments are tracked.

**Flip-flop check:** N — Additive in-loop dismissal, optional params for processNewBotReviews (backward compatible), and filter/override expansions; no behavior reverted.

**Notes:** Patterns assessed: (1) Mid-loop bypass — thresholds and solvability must apply inside the fix loop and to new comments, not only at push-iteration start. (2) STALE overuse — verifier phrasing often "can't evaluate / doesn't show" rather than literal "not visible in excerpt"; override regex expanded and tightened to avoid false positives. (3) ALREADY_FIXED re-queue — batch prompt builder had no visibility into fixer's prior ALREADY_FIXED count; filter at prompt build avoids re-sending. P8 (no-op search/replace) already implemented (noMeaningfulChanges skips verification).

---

### Cycle 13 — 2026-03-05 (output.log audit: same run as Cycle 12, post–Cycle 12 code)

**Artifacts audited:** output.log (elizaOS/eliza-cloud-v2#373, ~2h, 74 fix iterations, 8k+ lines sampled: start, queue/verification/dismissal lines, fixer failures, verifier "Changed but not verified" + lessons, couldNotInject/could not inject, AAR and RESULTS SUMMARY).

**Findings:**
- **High:** (none)
- **Medium (M1):** Basename fallback for short/fragment paths can inject the **wrong file**: e.g. comment path `10/route.ts` (garbage file at repo root) or `modelcontextprotocol/sdk/server/auto-top-up.ts` (nonexistent) resolved via `findLargerFileByBasename` to `lib/services/auto-top-up.ts` or `50/route.ts`. Fixer then gets content for a different file; S/R fails or edits wrong file; couldNotInject / chronic failure. Prefer candidate that shares path prefix with requested path, or skip substitution when fragment looks like repo-root (e.g. single-segment dir) and no exact match in workdir.
- **Medium (M2):** "Delete file" / "garbage file" / "remove from repo" issues repeatedly get fixer attempts that empty the file or add a comment; verifier correctly says "file needs to be deleted entirely". Discussion response was added ("need to be deleted via `git rm`") but the issue stays in queue. No runner support for file deletion; fixer can't express `git rm` via search/replace. Consider: dismiss after N verifier "delete entirely" verdicts, or add explicit "delete file" instruction / allowed path so runner can emit a delete action if supported later.
- **Low (L1):** AAR Summary says "Fixed 171" (unique comment IDs in Fixed bucket) while RESULTS block says "136 issues fixed and verified (from previous runs)". Different denominators (AAR uses comments + verification state; RESULTS uses state filtered by currentCommentIds + session note). Acceptable but could be clarified in RESULTS (e.g. "of which N this session") when both are shown.
- **Low (L2):** Server timeout/retry ("Server error or request timeout, retrying") observed once; recovery succeeded. No change needed; already in watchlist.
- **Low (L3):** Repeated "Changed but not verified" + lesson for same class (e.g. requireEnv/production validation, fee transparency, toFixed/string type, idempotency) — lessons are recorded but same issue types recur in batch. Optional: stronger prompt nudge when a lesson's path+topic matches current issue (e.g. "This matches a prior lesson: ...").

**Improvements implemented:**
- **M1 (basename fallback):** shared/runners/llm-api.ts — findLargerFileByBasename now takes optional `requestedPath`. When requestedPath has 2+ segments (fake directory like `10/route.ts`, `modelcontextprotocol/sdk/server/auto-top-up.ts`, `verify/route.ts`, `db/schemas/route.ts`), only accept a candidate that shares at least one path prefix segment with requestedPath; return null otherwise. A bare basename (1 segment) is a legitimate fragment and is not restricted. requestedPath is also prepended to pathHints so multi-candidate scoring prefers the same directory.

**Flip-flop check:** N — Audit only; no code changes.

**Notes:** Cycle 12 guards (couldNotInject in-loop, new-comment solvability, ALREADY_FIXED filter, STALE→YES) would have reduced wasted iterations in this run; this audit focuses on remaining patterns. Basename resolution lives in shared/runners/llm-api.ts (`findLargerFileByBasename`). File-deletion limitation is known (runner output is search/replace or full-file rewrite; no `git rm`). Recurring verifier themes: comment/code mismatch (review says "removed" but diff still shows), partial fix (schema updated but error message not), transparency/customer communication not addressed.

---

### Cycle 14 — 2026-03-05 (prompts.log audit: verifier NO when "not visible", judge format, LESSONs)

**Artifacts audited:** prompts.log (91k lines, same run as Cycle 12/13), sampled: batch verifier prompts/responses (#0001–#0023, #0145, model rec), single-issue verify/judge, fix prompts, LESSON lines, STALE/YES/NO patterns.

**Findings:**
- **High:** (none)
- **Medium (M1):** Verifier returned **NO** (issue resolved) with explanations that say code/excerpt is **not visible** or **can't confirm** (e.g. "The relevant code is not visible in the provided excerpt", "The file is missing from the provided excerpts, so I can't confirm whether the issue has been fixed"). Judge instructions say: if you would say "not in excerpt", say **YES** not STALE — so NO is wrong when the reason is inability to see the code. Those issues were incorrectly marked fixed and left the queue.
- **Medium (M2):** One verifier response (issue_5) said NO with "Line 299-300 shows ... without any mapping of editor" — explanation describes the issue still present (no editor mapping); contradictory NO. Optional: extend NO→YES to phrases like "without any mapping/handling" when the comment asked for that.
- **Low (L1):** Batch verifier responses sometimes use pipes between fields (e.g. `issue_1: YES I2 D2 | explanation`) instead of colons; parser tolerates both. No change needed.
- **Low (L2):** LESSON "Review asks for pre-call validation (line 32), not post-call error handling" repeated many times; same issue type recurring. Optional: lesson dedup or stronger nudge when lesson path+topic matches current issue.
- **Low (L3):** "Fix was incomplete" (no insight about why) appears in lesson output despite being in BAD examples; optional post-filter to reject or replace with generic.

**Improvements implemented:**
- **M1 (NO→YES when not visible/can't confirm):** llm/client.ts batch parsing — when verdict is NO and explanation indicates code/excerpt not visible or can't confirm (e.g. "relevant code is not visible in the provided excerpt", "can't confirm whether", "missing from the provided excerpts", "truncated portion would contain", "not visible in this excerpt"), override to YES (exists = true) so the issue is not incorrectly marked resolved.
- **Optional (Cycle 14 M2):** NO→YES when explanation says "without any/proper mapping/handling/validation" (contradictory NO — requested fix still missing). llm/client.ts.
- **Optional (Cycle 14 L3):** analyzeFailedFix post-filter: if lesson is generic ("Fix was incomplete", "no insight about why"), return `Fix rejected: ${rejectionReason}` instead. llm/client.ts.
- **Optional (Cycle 13 L1):** RESULTS summary — when mixed session/previous, show "of which N this session" instead of "N this session". reporter.ts.
- **Optional (Cycle 13 L3 / 14 L2):** When lessons include file-specific ("Fix for path..."), add nudge line: "One or more lessons below apply directly to the TARGET FILE(S) in this batch". prompt-builder.ts.

**Flip-flop check:** N — Additive override only; no behavior reverted.

**Notes:** STALE→YES override (Cycle 12) already handles STALE with "not visible"; this handles the symmetric mistake where the model said NO instead of STALE/YES. File-deletion LESSONs ("delete entirely", "git rm") recur — matches Cycle 13 M2 (runner can't do git rm). Follow-up: optional fixes (Cycle 14 M2, L3; Cycle 13 L1, L3/14 L2) implemented — NO→YES "without any mapping/handling", lesson post-filter for "Fix was incomplete", reporter "of which N this session", prompt-builder nudge when file-specific lessons exist.

---

### Cycle 15 — 2026-03-05 (output.log audit: BabylonSocial/babylon#1207)

**Artifacts audited:** output.log (babylon PR #1207: autobuild skills.md & test adjustments). Run: 30 comments → 20 dismissed → 6 in queue; iteration 1: 5 fixed (test-unit-isolated.ts, generate-skills-md.ts, packages/db); 1 failed verification (packages/engine/src/rate-limiting/index.ts — "debugLog workaround"; review asked to fix mocks in tests). Iterations 2–10: same issue only; fixer no-op or attempted error-handler-sentry.test.ts (not in TARGET FILE(S)); duplicate-prompt skip and rotation; bail-out after 1 cycle with zero progress.

**Findings:**
- **Medium (M1):** Stalemate on "fix in test, not production": review asked to fix logger mocks in tests; TARGET FILE(S) was only `index.ts`, so fixer either did nothing (identical S/R) or edited `error-handler-sentry.test.ts` and was blocked (disallowed or file-not-found). No path to apply the suggested fix.
- **Low (L1):** When all S/R fail and fixer attempted a file not in allowed paths, that path is only added to wrong-file lesson/state when runner returns `skippedDisallowedFiles`. If the runner skips for allowlist we do call addDisallowedFilesLessonsAndState in both success and failure branches; if failure was "file not found" (path in allowlist but file missing), we don't add — edge case.
- **Low (L2):** Tool-level failure (e.g. search_replace failed to match) is not recorded as a lesson — only "Fix for path:line - Search/replace failed to match" when we have result.failedFiles; tool_config-style failures may not set failedFiles.
- **Positive:** New behavior (verifier API/signature split, dismissal "file no longer exists" skip) behaved as intended.

**Improvements implemented:**
- **Fix-in-test allowed path:** When review body indicates "fix mocks in test" / "root cause in tests" (e.g. "fix logger mocks in tests"), `reviewSuggestsFixInTest(body)` returns true; `getTestPathForSourceFileIssue(issue, { forceTestPath: true })` then returns the co-located test path. That path is added to allowed paths in execute-fix-iteration, prompt-builder (batch), utils (single-issue), recovery, no-changes-verification, and at issue creation (getEffectiveAllowedPathsForNewIssue). Fixer can now edit the test file when the review suggests fix-in-test.

**Optional follow-ups:**
- Ensure when all change blocks are no-op or disallowed, runner still returns skippedDisallowedFiles and workflow calls addDisallowedFilesLessonsAndState so next iteration can include that file in TARGET FILE(S).

**Flip-flop check:** N — Audit only; no code changes.

**Notes:** Recurring theme: verifier/snippet and "fix in test" — when the review explicitly asks for a change in tests, allowed paths must include the test file or the fixer cannot comply. Pattern "Fix-in-test vs production" added to watch table.

---

### Cycle 16 — 2026-03-05 (prompts.log audit: babylon#1207 run)

**Artifacts audited:** prompts.log (~10k lines, 34 entries). Same run as Cycle 15 (babylon PR #1207). Phases: #0001 grouping, #0003–#0006 batch verifier + model rec, #0007 batch fix (66k chars), #0009–#0012 post-fix verifier, #0013–#0028 repeated single-issue fix (8× 20204 chars — rate-limiting debugLog), #0029–#0034 predict-bots + final batch verifier.

**Findings:**
- **Medium (M1):** Grouping #0001: LLM returned `GROUP: 2,5,7 → canonical 5` and `GROUP: 1,3 → canonical 3` but there were only 3 comments [1],[2],[3]. Indices 5,7 are out of range. Parser filters indices to valid range and skips canonical when out of range; for "1,3 → 3" it applied merge of comment 1 into 3 (may be wrong if they target different lines). **Improvement:** Reject an entire GROUP line when any index is out of range [1..N] or when canonical is not in the group list; avoid applying a subset the LLM did not intend.
- **Low (L1):** Verifier #0004 said issue_5: STALE ("code not visible"); model-rec prompt #0005 then showed issue_5 as YES I3 D3 — override behaved correctly so we didn't mark resolved. Good.
- **Low (L2):** Positive feedback correctly marked STALE in #0032 (issue_4/5: "positive feedback", "not an issue that needed fixing") — analysis treats STALE as non-fixable; no change needed.
- **Low (L3):** Predict-bots #0029 received a very small diff (only .gitignore in the snippet); response listed scripts/build-skills-docs.js and .gitignore. If predict-bots is meant to see a representative diff, ensure it gets one; otherwise acceptable.
- **Positive:** Fix-in-test would have added the test file to TARGET FILE(S) from the start; once the test file was in allowed paths (#0025 shows both index.ts and error-handler-sentry.test.ts), fixer #0028 returned RESULT: FIXED. Verifier format (FIX_1/FIX_2, colons) parsed correctly. Duplicate-prompt skip and rotation in place (same prompt+model skipped to rotation).

**Improvements implemented:**
- **Grouping validation (Cycle 16 M1):** In issue-analysis.ts dedup parser, when parsing GROUP lines: require all indices to be in [1, N]; require canonical to be in the group list; if any index or canonical is out of range, skip that entire GROUP line. Prevents applying merges the LLM did not intend when it hallucinates indices (e.g. "GROUP: 2,5,7" with only 3 comments).
- **Dedup prompt tightening:** The dedup prompt now explicitly states that valid comment indices are `1..N` for the current file and that the canonical index must be one of the indices in its GROUP line. This reduces out-of-range GROUP hallucinations before parsing.
- **Predict-bots guard/filter (Cycle 16 L3):** In `bot-prediction-llm.ts`, skip the LLM predictor for tiny meta-only diffs (e.g. `.gitignore` only with very few meaningful added/removed lines). When prediction does run, the prompt now lists the changed files and instructs the model to output only files present in that diff; parsed predictions are filtered to `changedFiles`. Prevents low-signal hallucinations like `scripts/build-skills-docs.js` when the commit diff only touched `.gitignore`.

**Optional follow-ups:**
- None from this audit.

**Flip-flop check:** N — Tightened validation and display-only bot-prediction guard/filter; no behavior change for valid GROUP lines or real fixes.

**Notes:** Same run as Cycle 15; prompts.log confirms the stalemate (repeated 20204-char single-issue prompts) and that once the test file was allowed, the fix succeeded. Grouping validation prevents wrong merges when the LLM returns out-of-range indices. Bot prediction is display-only, so the new tiny/meta-only diff guard is a safe token-saving improvement.

---

### Cycle 17 — 2026-03-05 (output.log follow-up: incorrect skips from truncated paths)

**Artifacts audited:** output.log from babylon PR #1207 after reviewing why not all needed comments were addressed.

**Findings:**
- **Medium (M1):** `assessSolvability()` used raw `comment.path` for existence checks, so shortened review paths like `generate-skills-md.ts`, `SKILL.md`, `sentry-bun.d.ts`, and `wallet/nfts/route.ts` were dismissed as `stale` / "File no longer exists" even though the real repo files existed at longer paths.
- **Medium (M2):** Single-issue and no-changes flows still inferred test paths without `pathExists`, so repos that use `__tests__/integration/...` could show the wrong TARGET FILE(S) in the prompt even when batch/recovery had the correct path.
- **Low (L1):** The disallowed-file retry learner only keyed off `issueRequestsTests()` and could miss reviews that say "fix mocks in tests" without explicitly requesting new tests.

**Improvements implemented:**
- **Tracked-path resolution before stale dismissal:** `workflow/helpers/solvability.ts` now resolves truncated review paths against `git ls-files` before file-existence and line-validity checks. Exact tracked path wins first; unique suffix match is accepted; ambiguous bare basename is rejected instead of guessed. This prevents incorrect stale dismissal for shortened bot paths.
- **Single-issue / no-changes `pathExists` alignment:** `buildSingleIssuePrompt` now accepts optional `pathExists`, and resolver/recovery pass it so test-path inference can choose the real integration-test path when present. `handleNoChangesWithVerification` also passes `pathExists` when persisting an inferred test path after UNCLEAR.
- **Fix-in-test retry learning:** `execute-fix-iteration.ts` now lets the disallowed-file learner treat "fix in tests" comments the same as explicit test-request comments when allowing an attempted test file on retry.

**Flip-flop check:** N — Additive path resolution and prompt alignment; no behavior changed for exact paths or already-correct test paths.

**Notes:** This is the main reason some comments that "needed to be addressed" were not addressed in the babylon run: they were filtered out before the fix loop on raw-path existence checks. The new resolution keeps dismissal conservative for ambiguous bare basenames while avoiding false stale dismissals for unique suffix matches.

---

### Cycle 18 — 2026-03-05 (prompts.log follow-up: dedup prompt contradiction, praise-only filtering)

**Artifacts audited:** prompts.log from babylon PR #1207 after Cycle 16/17 fixes.

**Findings:**
- **Low (L1):** Dedup prompt still showed an impossible example (`GROUP: 2,5,7 → canonical 5`) even when the prompt explicitly said valid indices were only `1..3`. The parser rejects malformed groups, but the example still teaches the wrong answer shape.
- **Low (L2):** Praise-only comments still reached batch verification, e.g. "The output looks clean and follows the AgentSkills spec. Nice work on the frontmatter structure." These were resolved correctly as NO, but they still consumed analysis/verifier tokens.

**Improvements implemented:**
- **Dedup example cleanup:** Replaced the invalid `2,5,7` example with an in-range example so the prompt no longer contradicts its own `1..N` rule.
- **Praise-only filter tightening:** `isCommentPositiveOnly()` now recognizes additional high-confidence praise/security-only phrasings observed in the run (looks clean/follows spec, nice work, no hardcoded credentials, no sensitive APIs, no security issues/concerns identified) while still requiring zero actionable language before dismissal.

**Flip-flop check:** N — Prompt/example cleanup and stricter non-actionable filtering only; valid actionable comments still go through normal analysis.

**Notes:** This does not solve the broader "tests requested but no tests added" verifier weakness; it only removes obviously non-actionable praise from the queue earlier and makes the dedup prompt internally consistent.

---

### Cycle 19 — 2026-03-05 (prompts.log follow-up: canonical path propagation, safer full-file rewrites)

**Artifacts audited:** prompts.log and output.log from babylon PR #1207 after Cycle 18.

**Findings:**
- **Medium (M1):** Truncated-path handling was still split across phases. Solvability resolved shortened review paths early, but `allowedPaths`, single-issue prompt reads, and direct-fix file operations could still use the raw `comment.path`, so later fix flows could target or allowlist the wrong file.
- **Low (L1):** The LLM runner could escalate a file to “output the COMPLETE fixed file” specifically because the file content was not injected into the prompt. That creates an internally contradictory prompt: rewrite the entire file without seeing the file.

**Improvements implemented:**
- **Canonical path propagation:** `issue-analysis.ts` now resolves tracked repo paths when creating `resolvedPath` and uses the canonical path when constructing `allowedPaths` for new issues. Resolver/recovery/direct-fix flows now prefer `resolvedPath` for snippet reads, full-file reads, git reset/diff/verify operations, and single-issue target display.
- **Safer full-file rewrite escalation:** `shared/runners/llm-api.ts` now skips full-file rewrite escalation when the file was not injected into the prompt. Those cases stay in normal search/replace mode so PRR does not ask the model to guess a full file from missing context.

**Flip-flop check:** N — The path change only makes later fix stages use the same canonical file chosen earlier; exact paths continue to behave the same. The rewrite change is conservative: it removes contradictory instructions rather than broadening edit scope.

**Notes:** This still leaves room for a future improvement where the runner explicitly injects full content for rewrite-eligible files when prompt budget permits. For now, the main goal is consistency and avoiding self-contradictory prompts.

---

*(Add new cycles below using the template.)*

---

## Detailed findings (consolidated from legacy audits)

Content below is the merged detail from earlier output.log, prompts.log, and code-audit work. Use it for rationale and edge cases when touching these areas.

---

### Output.log

- **Debug vs user output:** Log mixes `[DEBUG]` with user-facing messages. Optional: `PRR_LOG_LEVEL=info` for output.log without debug. Lower priority.
- **CodeRabbit “waiting”:** Fixed in startup.ts — “not waiting; will pick up new comments when they land.” Remove any remaining “waiting” paths.
- **Model recommendation reasoning:** Only print when real reasoning (not literal prompt phrase, length > 40). Implemented in issue-analysis.
- **Grammar “1 file(s)”:** Use pluralize: “1 file” / “N files”. Implemented in fix-verification, iteration-cleanup, repository, llm-api.
- **Timing summary:** Aggregate by phase with “(n×)” and total. Implemented in logger `printTimingSummary`.
- **Iteration summary:** “Fixed: 2 this iteration (4 total this fix loop)” and “+ N duplicate(s) auto-resolved” — already clear.
- **Lessons Learned block:** Appears twice in fix prompt section; redundant but helps visibility. Optional to collapse.
- **Disallowed file hint:** Fixed via getMigrationJournalPath. Optional: “(Add this file to TARGET FILE(S) if the fix requires it.)” when we skip a disallowed file.
- **AAR “### Summary”:** Use first meaningful line for “Fixed This Session” via `getFixedIssueTitle`. Implemented in reporter.
- **Run audit (elizaOS/eliza#6509):** CI line → “checks run; status: pending”; clone → “(Large repos may take a few minutes.)”; ElizaCloud → “fallback model … (rotation may use other models)”; stash before merge + “Stashed N local change(s)”.
- **Conflict resolution run:** Skip batch when prompt > 40 KB; hasConflictMarkers() in resolveConflict; 504/timeout → chunked retry; heartbeat every 30 s. Implemented.

---

### Prompts.log (verifier, judge, fixer)

- **Verifier “Code before fix” vs multiple fixes in same file:** Each fix gets same full-file diff; “Code before fix” from all removed lines. Add note: “When multiple fixes apply to the same file, 'Code before fix' may show removed lines from any part of the file. Decide whether the **review comment’s** specific concern is addressed in Current Code or in the diff.” Implemented. Optional later: per-fix “Code before fix” by line range.
- **Verifier LESSON for duplicate/shared-util:** LESSON sometimes said “use from user-service”; canonical is lib/utils/db-errors.ts. Verifier prompt: fix is remove duplicate from this file + import from shared module (lib/utils/...); do not suggest “use from [reference file]” in LESSON. Implemented.
- **LESSON only for NO:** “Do not include a LESSON line for YES responses.” Implemented.
- **Judge format:** Colons, one format; parsing tolerates both. Implemented.
- **Allowed paths for “remove duplicate in X”:** When issue is “consolidate duplicate in another file,” add that file to allowedPaths (getConsolidateDuplicateTargetPath). Do not add when comment only references the file (isReferencePathInComment). Implemented.
- **Full-file rewrite:** “Use this only for this file; do not rewrite other files.” Implemented in llm-api.
- **Migration journal:** allowedPaths must include `db/migrations/meta/_journal.json` when path is db/migrations/*.sql and body mentions journal. getMigrationJournalPath + Drizzle hint in fix prompt (“journal is JSON file … do not add SQL or table inserts”). Implemented.
- **Injected file content:** Raw code, no “N | ” prefixes; instruction not to add line prefixes in output. Implemented in llm-api.
- **CodeRabbit meta-comment:** Filter “ℹ️ Recent review info” / “Configuration used” + “Review profile” in getReviewComments (isCodeRabbitMetaComment). Implemented.
- **Judge NO citation:** “For NO, your explanation MUST cite specific code or line numbers; 'Fixed' or 'Done' alone is invalid.” Implemented.
- **Empty/artifact “Code before fix”:** “If 'Code before fix' is empty or shows only formatting/line-number artifacts, base your verdict on Current Code and the diff only.” Implemented.

---

### Wrong-file and allowed-path code audit

- **isReferencePathInComment (workflow/utils.ts):** True when comment mentions path and reference-style phrasing (“duplicate”, “existing in”, “same as”, “in <path>”). Do not add otherFile to wrongFileAllowedPathsByCommentId when true. Edge case: “correct code is in user-service.ts” treated as reference — conservative. No change. Optional: require “duplicate”/“existing”/“same as” for “in X” if we see false negatives.
- **No-changes-verification and recovery:** CANNOT_FIX and WRONG_LOCATION guard with `otherFile && !isReferencePathInComment(..., otherFile)` before merging. Recovery same guard before retrying with otherFile. Correct.
- **Fix prompts (batch + single):** “Do NOT edit the referenced file unless it is listed in TARGET FILE(S).” In prompt-builder and utils buildSingleIssuePrompt. Correct.
- **Wrong-file lesson (recovery):** expectedPaths from issue.allowedPaths or comment.path; wrongFiles = changedFiles not in expectedPaths; lesson “need to modify one of: <expectedStr>. Do NOT edit <wrongFiles>.” Single-issue: treat change as valid if touches any allowedPath; fileToVerify from changedExpected. Correct.
- **Revert after failed verification:** Revert all files changed in attempt; push issue.comment.path if not in list. Correct.
- **allowedPathsForBatch:** execute-fix-iteration and recovery pass union of allowed paths; llm-api skips change/newfile/file blocks not in set. normalizePathForAllow strips leading `./`. Backslash in paths not normalized — acceptable for now.

---

### Improvement batch (migration, consolidate, inject, UX)

- **Migration journal:** getMigrationJournalPath in prompt-builder and utils; Drizzle hint when journalPath set. Path regex strict. OK.
- **Consolidate-duplicate:** getConsolidateDuplicateTargetPath — first body match (lib|app|tools|src)/...; exclude comment.path and lib/utils/db-errors. OK. Optional: if first match is db-errors, take next non–db-errors match.
- **Injected content:** llm-api injects raw content; instruction not to add “N | ” in output. OK.
- **CodeRabbit filter:** isCodeRabbitMetaComment in github/api; getReviewComments filters. OK.
- **Judge/verifier:** NO citation + colons; verifier empty/artifact “Code before fix” + LESSON only for NO. OK.
- **Full-file rewrite:** “Use full-file rewrite ONLY for each listed file above.” OK.
- **Pluralize, timing, AAR, model reasoning:** logger pluralize and printTimingSummary; fix-verification, iteration-cleanup, repository, llm-api use pluralize; reporter getFixedIssueTitle; issue-analysis only show reasoning when real. OK. getFixedIssueTitle fallback when all lines generic — acceptable.

Future work from these audits (optional follow-ups) is in [docs/ROADMAP.md](../../docs/ROADMAP.md) under "Audit-derived follow-ups".
