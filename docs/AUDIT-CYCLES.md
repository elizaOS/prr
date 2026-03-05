# Audit cycles

**Last updated:** 2026-03-04 · **Recorded cycles:** 11 · **Historical (legacy):** 4

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

---

## Recurring patterns

Improvements should reinforce these, not reverse.

| Pattern | What we keep doing |
|--------|---------------------|
| **Prompt size / noise** | Cap lessons, trim diff for tiny batches, filter global lessons by path relevance. |
| **Snippet visibility** | Quality gate (too-short note), wider fallback for analysis batch, anchor-aware expansion. |
| **Queue / log clarity** | One clear "still in queue" line, queue subtitle (to-fix vs already-verified), no contradictory "No issues" vs "N in queue". |
| **Allow-path / test path** | Expand for test-coverage, plausible-path checks, test path at issue build; migration journal in allowedPaths when review mentions it; consolidate-duplicate "other file" when refactor issue. Do *not* add a file when comment only *references* it — use isReferencePathInComment before persisting otherFile from CANNOT_FIX/WRONG_LOCATION. |
| **Loop prevention** | Counters and thresholds (WRONG_LOCATION/UNCLEAR, wrong-file, verifier rejection, CANNOT_FIX missing content); exhaust and dismiss instead of burning models. Auto-verify when bug pattern absent after N verifier rejections. |
| **File injection** | Basename fallback for short/fragment paths; placeholder detection before injection; hallucination guard for full-file rewrite output (< 15% of original = reject). |
| **Approval/noise filter** | Summary/meta-review tables, approval comments ("Approve", "LGTM", "All issues resolved"), PR metadata requests — all dismissed in solvability. |
| **Judge / verifier** | Judge NO must cite specific code or line numbers; format colons. Verifier: LESSON only for NO; for duplicate/shared-util steer to canonical lib/utils/..., not reference file; "Code before fix" empty/artifact → base verdict on Current Code and diff; multi-fix same file → judge by review comment. |
| **Output / UX** | Pluralize (1 file / N files); timing aggregated by phase; model recommendation only when real reasoning; AAR title from first meaningful line. Exhausted issues appear in AAR and handoff until resolved (fix, conversation, or other). |
| **Conflict resolution** | Skip batch when prompt > 40 KB; hasConflictMarkers(); 504/timeout → chunked fallback; heartbeat every 30 s. |
| **Dedup across authors** | Same file + same primary symbol + same caller file (e.g. runner.py) → heuristic merge even when authors differ. LLM dedup still runs for 3+ issues per file; GROUP lines take priority over NONE. |
| **Verifier strength** | Escalation for previous rejections; stronger model for API/signature-related fixes (async, await, caller, TypeError). Weak default verifier kept approving call-site bugs. |
| **Dismissal comments** | Skip when reason says "file no longer exists" / "file not found"; skip when file missing in workdir; post-filter comments that only restate code (e.g. "extracts metrics"). |
| **Multi-file / call sites** | When TARGET FILE(S) has multiple files and review mentions callers (await, file:line), nudge: update implementation and every call site so signatures match. |

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
- [ ] Summary/meta-review comments (status recap tables, "### Summary" with 3+ status phrases) dismissed as not-an-issue (solvability).
- [ ] When snippet is "(file not found or unreadable)", batch analysis tries getFileContentFromRepo (git show HEAD:path) before sending to verifier.
- [ ] No-changes lessons: single-issue uses "Fix for path:line - ..."; batch uses "(N issues in batch)" in global lesson.
- [ ] Multi-file fix: when allowedPaths.length > 1 and body mentions callers (calls/caller/await/file:line), prompt includes nudge to update all listed files and call sites.

**File injection / circuit breakers**
- [ ] Placeholder content ("COMPLETE FILE CONTENTS", "[Previous content remains identical]") never injected into fix prompts.
- [ ] CANNOT_FIX missing content counter increments and solvability dismisses after threshold.
- [ ] Hallucination guard rejects `<file>` blocks < 15% of original size.
- [ ] Basename fallback triggers for short/missing code files; skips .git and node_modules.
- [ ] Approval comments ("Approve", "LGTM", "All issues resolved") dismissed in solvability.
- [ ] Dedup: GROUP lines take priority over NONE in LLM response; heuristic merges same file + same symbol + same caller file (callerFileFromBody) across authors.
- [ ] Diff summary capped for all batch sizes (not just ≤2 issues); filters to batch-relevant files.
- [ ] Dismissal comments: skip when reason matches "file no longer exists" / "file not found"; skip when file missing in workdir; post-filter COMMENT that only restates code (words from comment in surroundingCode).

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
