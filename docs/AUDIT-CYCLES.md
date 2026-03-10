# Audit cycles

**Last updated:** 2026-03-10 · **Recorded cycles:** 28 · **Historical (legacy):** 4

Single audit log for output.log, prompts.log, and code changes. Use it to spot recurring patterns and avoid flip-flopping.

---

## How to use this doc

1. **Before an audit:** Skim "Recurring patterns" and "Regression watchlist" so you know what to watch for.
2. **After an audit:** Add a new cycle using the template below. Fill findings, improvements, and flip-flop check.
3. **Periodically:** Update "Recurring patterns" if a new theme appears in 2+ cycles; add regression checks if we keep fixing the same class of bug.

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
| **Fix-in-test vs production** | 15 | Review says "fix mocks in tests" / "root cause in tests" but TARGET FILE(S) only lists production file → fixer edits production (no-op or workaround) or tries test file and is blocked. Guard: when review body indicates fix-in-test, add co-located test file to allowed paths so fixer can edit it. |
| **Canonical path propagation / rename targets** | 19, 20 | Early phases resolve basename/truncated review paths, but later cleanup/commit/reporting paths still use raw fragments or extension words like `test.ts` → successful fixes crash on `git add`/hashing or the real rename target is blocked as disallowed. Guard: use canonical primary path everywhere after issue creation; infer explicit rename destinations for filename-review issues. |

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
| **File injection** | Basename fallback for short/fragment paths; placeholder detection before injection; hallucination guard for full-file rewrite output (< 15% of original = reject). |
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

---

## Regression watchlist

Quick checks each audit. Drill into the category that matches what you changed.

**Prompt quality**
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

**Notes:** (optional)
```

---

## Recorded cycles

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

Future work from these audits (optional follow-ups) is in [ROADMAP.md](ROADMAP.md) under "Audit-derived follow-ups".
