# Audit Improvements (Token Savings & Exit Logic)

This document describes the changes made after auditing `prompts.log` and the fix/verification workflow. Each change includes **why** it was made so future edits don’t regress behavior.

---

## 1. Think-tag stripping and suppression

**What:** In the OpenAI/ElizaCloud code path we (1) strip `<think>…</think>` blocks from LLM responses and (2) add a system-prompt suffix for Qwen models asking them not to emit `<think>` tags.

**Where:** `src/llm/client.ts` — `completeOpenAI()`.

**Why:**
- Models like Qwen 3 14B emit long `<think>` reasoning before the actual answer. That text is never used by our parsers (batch verification looks for `issue_N: YES/NO:`, single-check for `YES`/`NO`/`STALE` at start of line).
- Audit showed 27+ responses with 1000–2000 extra output tokens of reasoning, and responses starting with `<think>` broke `content.startsWith('YES')` in single-issue checks.
- Stripping after the fact fixes parsing and saves downstream confusion; asking Qwen not to emit tags reduces output tokens and latency at the source.

---

## 2. Verifier rejection tracking and auto-dismiss

**What:** We count how many times the verifier has rejected a fix or an ALREADY_FIXED claim per comment. When that count reaches `VERIFIER_REJECTION_DISMISS_THRESHOLD` (2), we mark the issue unsolvable and dismiss it as "exhausted."

**Where:**
- `src/constants.ts`: `VERIFIER_REJECTION_DISMISS_THRESHOLD = 2`
- `src/state/types.ts`: `verifierRejectionCount?: Record<string, number>` on `ResolverState`
- `src/workflow/helpers/solvability.ts`: Check 0e — if `rejectionCount >= threshold`, return unsolvable with `dismissCategory: 'exhausted'`
- `src/workflow/fix-verification.ts`: When verification fails for an issue, increment `state.verifierRejectionCount[issue.comment.id]`
- `src/workflow/no-changes-verification.ts`: When the no-changes path verifies and the verifier says "still exists," increment the same counter

**Why:**
- Fixer/verifier stalemates (fixer says ALREADY_FIXED, verifier says "issue still exists") were retried indefinitely, burning tokens and time.
- Capping at two rejections per issue stops the loop, records a clear "exhausted" dismissal, and defers to human follow-up. State is persisted so the count survives restarts.

---

## 3. Exit after two push iterations with zero verified fixes

**What:** The run orchestrator tracks whether **this** push iteration added any new verified fixes. After two consecutive push iterations with zero new verified fixes, it exits with `exitReason: 'no_verified_progress'`.

**Where:** `src/workflow/run-orchestrator.ts` — `progressBeforePushIteration` snapshot and `progressDelta = updatedProgressThisCycle - progressBeforePushIteration`.

**Why:**
- `progressThisCycle` is a **cumulative** counter across all push iterations and is never reset. Comparing `updatedProgressThisCycle > 0` would always be true after the first successful fix, so the "consecutive zero verified" exit never triggered.
- Using the **delta** between the start and end of each push iteration correctly detects "this cycle added zero verified fixes" and allows the exit after two such cycles.

---

## 4. Dismissal-comment pre-check radius

**What:** Before calling the LLM to generate a dismissal comment, we check whether a "Review:" comment already exists near the target line. The check radius was increased from 3 to 7 lines.

**Where:** `src/workflow/dismissal-comments.ts` — `hasExistingReviewComment()`.

**Why:**
- The LLM is given ±7 lines of context (`contextBefore`/`contextAfter` = 7). With a ±3 line pre-check, we sometimes didn’t see an existing "Review:" that the LLM could see, so we still called the LLM and got "EXISTING" every time.
- Audit showed 12 consecutive such calls. Matching the pre-check radius to the LLM context (7) avoids those redundant calls and saves input tokens.

---

## 5. No-op search/replace skip

**What:** When applying `<change>` blocks from the llm-api fixer, if the trimmed `<search>` and `<replace>` content are identical, we skip the change (no file read/write, no fuzzy match).

**Where:** `src/runners/llm-api.ts` — `applyFileChanges()`.

**Why:**
- LLMs sometimes output a change block that is effectively "no change" (e.g. they claim ALREADY_FIXED but still emit search/replace with the same text). Applying it would write the same content and trigger verification on unchanged code.
- Skipping keeps `filesModified` accurate and avoids pointless verification work.

---

## 6. Fix prompt lesson caps for large batches

**What:** When there are more than 10 issues in the batch, we cap global lessons at 5 (instead of 15) and per-file inline lessons at 1 per file (instead of 3). The console "Lessons Learned" summary uses the same cap.

**Where:** `src/analyzer/prompt-builder.ts` — `lessonCap`, `maxInline`, and the lessons-section display count.

**Why:**
- Audit showed 278k+ character fix prompts when many issues and many lessons were combined, leading to gateway timeouts and wasted tokens.
- Smaller caps for large batches keep prompts under ~100k chars while still surfacing recent failure lessons. Using the same cap in the console keeps the log aligned with what the fixer actually sees.

---

## 7. LLM dedup only for files with 3+ issues

**What:** The LLM dedup step (which asks "which of these comments describe the same problem?") runs only for files that have at least **3** remaining issues after heuristic dedup (previously 2).

**Where:** `src/workflow/issue-analysis.ts` — filter `items.length >= 3`.

**Why:**
- For exactly two comments on a file, heuristic grouping (same file, line proximity, author) is usually sufficient to decide whether to merge. The LLM call added cost with little extra value.
- Skipping the LLM for 2-comment files saves tokens without meaningfully reducing dedup quality.

---

## 8. Commit message duplicate pattern

**What:** The commit message pattern that matches "duplicate" in the diff or comments now produces the description "consolidate duplicate logic" instead of "remove duplicate code."

**Where:** `src/git/git-commit-message.ts` — pattern for `duplicate`.

**Why:**
- Some review bots or conventions treat "remove duplicate code" as a forbidden or discouraged phrase. The new wording preserves intent (we consolidated duplicates) without triggering those filters.

---

## 9. maxFixIterations 0 = unlimited

**What:** The fix loop now treats `--max-fix-iterations` value `0` (and `null`/`undefined`) as *unlimited*: we compute `effectiveMaxFixIterations = (value == null || value === 0) ? Infinity : value` and use that in the loop condition and in the "max iterations reached" message.

**Where:** `src/workflow/push-iteration-loop.ts` — initialization of `effectiveMaxFixIterations`, loop condition, and post-loop exit block.

**Why:**
- The CLI documents the default as `0` meaning "unlimited," but the previous code used the raw option. With default `0`, the condition `fixIteration < maxFixIterations` was `0 < 0` → false, so the loop never ran a single iteration.
- Audit of a run showed "Fix loop exit: max_iterations" with zero fix attempts. Mapping 0 to Infinity makes the default behave as documented.

---

## 10. Empty / missing code snippets in verification prompts

**What:**
- **Judge (batch "do issues still exist")**: When `issue.codeSnippet` is empty or whitespace, we no longer emit an empty code block. We emit an explicit placeholder: "(snippet unavailable — do NOT respond STALE; if you cannot verify from the comment alone, respond YES with explanation that code was not visible)."
- **Fix-verification (post-fix batch)**: When `fix.currentCode` is empty or whitespace-only we treat it as missing and add the line "Current Code: (unavailable — verify from diff only)" instead of an empty ``` block.

**Where:** `src/llm/client.ts` — `buildIssueText` inside `batchCheckIssuesExist`, and `buildBatchVerifyPrompt`.

**Why:**
- Audit of `prompts.log` found issues (e.g. issue_8, issue_12) where the "Current code:" block was literally empty. The verifier had no context and guessed (e.g. STALE or YES/NO without evidence). Explicit placeholder text (1) instructs the model not to use STALE when code isn’t visible, (2) steers toward YES-with-explanation when verification isn’t possible, and (3) makes "unavailable" visible so the model doesn’t invent conclusions from an empty block.

---

## 11. Comment grouping rule: same method, different fix

**What:** The LLM dedup grouping prompt now includes an explicit rule and example: "Same method/symbol but DIFFERENT fix = do NOT group. Example: 'Method X doesn't exist' (fix: add the method) and 'Method X called with wrong cast' (fix: change the call site) are two different fixes — do not group."

**Where:** `src/workflow/issue-analysis.ts` — prompt string for `requestDedupGroups`, plus a short code comment explaining the audit finding.

**Why:**
- Audit found a bad merge: two comments about the same method (e.g. `isAvailable`) were grouped, but one required adding the method and the other required changing the call site. Merging them into one canonical issue caused the fixer to address only one of the two or to lose nuance. The new rule reduces false groupings in this class.

---

## 12. Dead code removal in commit-and-push-loop (bot wait)

**What:** The condition for "should we wait for bot reviews after push" was simplified from `(maxPushIterations === 0 || pushIteration < maxPushIterations)` to `pushIteration < maxPushIterations`.

**Where:** `src/workflow/commit-and-push-loop.ts` — `shouldWaitForBots`.

**Why:**
- By the time this code runs, `maxPushIterations` has already been normalized in the orchestrator: 0 is converted to Infinity. So `maxPushIterations === 0` is never true here; the branch was dead code. Removing it avoids confusion. Behavior is unchanged (when unlimited, `pushIteration < Infinity` is true for any finite iteration count).

---

## 13. Verification model note (in-code)

**What:** A short comment was added above the batch verify loop: verification accuracy affects fix-loop decisions; if many false YES/NO occur, use a stronger model (e.g. via tool config).

**Where:** `src/llm/client.ts` — just before `MAX_VERIFY_RETRIES` in `batchVerifyFixes`.

**Why:**
- Audit showed roughly 30% wrong verifier verdicts with a small model (e.g. Qwen-3-14B). Documenting the lever (stronger model via tool/runner config) helps operators tune without code changes.

---

## Summary table

| Change | File(s) | Goal |
|--------|--------|------|
| Think-tag strip + suppress | `llm/client.ts` | Save output tokens, fix parsing |
| Verifier rejection count | `constants.ts`, `state/types.ts`, `solvability.ts`, `fix-verification.ts`, `no-changes-verification.ts` | Stop stalemate retries |
| No-verified-progress exit | `run-orchestrator.ts` | Exit when no progress for 2 push cycles |
| Dismissal pre-check radius 7 | `dismissal-comments.ts` | Skip redundant dismissal LLM calls |
| No-op change skip | `runners/llm-api.ts` | Skip no-op edits, accurate file counts |
| Lesson caps (large batch) | `analyzer/prompt-builder.ts` | Keep prompts under ~100k chars |
| Dedup 3+ issues | `workflow/issue-analysis.ts` | Save dedup tokens for 2-comment files |
| Commit "duplicate" wording | `git/git-commit-message.ts` | Avoid forbidden phrase |
| maxFixIterations 0 = unlimited | `workflow/push-iteration-loop.ts` | Fix loop runs with default 0 |
| Empty snippet handling | `llm/client.ts` | No empty code blocks; explicit placeholder for judge + verifier |
| Grouping: same method, different fix | `workflow/issue-analysis.ts` | Reduce false merges in dedup |
| Bot wait dead code removal | `workflow/commit-and-push-loop.ts` | Clarity; behavior unchanged |
| Verification model note | `llm/client.ts` | Document tuning lever for verifier accuracy |

---

*Last updated: 2026-02*
