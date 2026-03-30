# Future / roadmap (exploration ideas)

Items here are potential directions to explore, not committed plans. Each idea includes **why** it would help, so we can revisit tradeoffs later.

**Completed work belongs in [CHANGELOG](../CHANGELOG.md), not here.** When an item is done, add it to CHANGELOG and remove it from this file. See `.cursor/rules/roadmap-vs-changelog.mdc`.

## Thread replies: single batch GraphQL for idempotency (optional)

**Idea:** Today we call `getThreadComments` once per candidate thread in parallel (`Promise.all`). A possible optimization is one batched GraphQL request (e.g. multiple `node(id: $id)` aliases in a single query) to fetch all thread comment authors in one round-trip.

**WHY:** Would reduce API round-trips when many threads are reply candidates; current parallel approach is already fast, so this is low priority unless we see latency issues on very large PRs.

## Single-issue focus: allowedPaths must include issue target

**Status:** **Improved** — **`trySingleIssueFix`** mirrors **`getAllowedPathsForIssues`** for **`getRenameTargetPath`** and **`issueRequestsTests` → `__tests__/…`** (same as batch). **`REPO_TOP_LEVEL`** includes common e2e roots (`e2e`, `playwright`, `cypress`, `fixtures`, `integration`, `wdio`). Empty-after-filter still falls back to **`[primaryPath]`**.

**Idea (ongoing):** Ensure single-issue focus always passes a runner-compatible allow set. When `allowedPaths` is empty or filtered to empty (e.g. path under a top-level not in `REPO_TOP_LEVEL`), the runner rejects every change and wrong-file counter can fire falsely.

**WHY:** Pill audit (output.log) showed `expectedPaths: []` for single-issue fixes; the fixer correctly edited the target file but the runner rejected edits. We add top-level dirs as audits surface them, fallback to `[primaryPath]` when filter yields empty in recovery, and do not count edits to the issue's target as wrong-file.

## State consistency: verifiedFixed vs dismissedIssues (mutual exclusivity)

**Status:** Largely **done** — `markVerified` / `dismissIssue` and load paths enforce mutual exclusivity; `verifiedComments` included in overlap cleanup; `already-fixed` dismissals clear on HEAD change. **CHANGELOG [Unreleased]** has the full list.

**Remaining (optional):** Broader “clear all dismissals on HEAD change” (trade-off vs. stable not-an-issue dismissals); explicit migration notes for very old state files; extra tests if new edge cases appear.

**WHY (original):** Pill audit noted overlap can confuse summaries and re-runs.

## Pill-output follow-ups (this repo)

From root **`pill-output.md`** triage — **prr** scope only:

- **Docs:** **DEVELOPMENT.md** lessons example JSON now uses **`tools/prr/`** / **`shared/`** paths; broader **`src/`** grep cleanup remains optional where examples mean “generic target repo”.
- **`autoVerifiedFrom`:** **Done** — **`recoverVerificationState`** sets **`PRR_GIT_RECOVERY_VERIFIED_MARKER`** on recovered IDs (see **`types.ts`** / **CHANGELOG**).
- **Git utilities:** **`checkForConflicts`** JSDoc + **debug** line clarify fetch-only vs in-progress conflicts; **`fetchOriginBranch`** timeout/clear documented in **CHANGELOG**.
- **CodeRabbit SHA vs HEAD:** **Partial** — startup warns when **`botReviewCommitSha`** ≠ PR HEAD (review **`commit_id`**, or **40-char SHA** in latest bot issue comment if no review row). Optional future: deprioritize stale threads or wait (trade-off vs speed).
- **Skip list ops:** Refresh **`ELIZACLOUD_SKIP_MODEL_IDS`** in **`shared/constants.ts`** when Model Performance tables show new 0% models (**WHY:** static list drifts vs. gateway reality).
- **`determineScope`:** **Done** — falls back to first directory segment (e.g. `src`) when “meaningful” segments are empty.

## Lesson staleness / conflict detection

**Status (partial):** **`lessonForbidsEditingIssuePath`** in **`tools/prr/state/lessons-retrieve.ts`** — **`getLessonsForIssue`** drops lessons whose text forbids editing the issue path in the same negated clause (path must appear in the `do not edit …` span before `,` / `;` / `—`, so “don’t edit **bar**; bug is in **foo**” does not drop lessons for **foo**). **`pruneLessonsForbiddingOwnTargetPath`** on lesson load removes file-scoped rows that forbid editing their own key. **`tests/lesson-forbid-path.test.ts`**.

**Remaining (optional):** Lessons that forbid **`allowedPaths`** alternates without matching the primary path; richer NLP for “this file” without a literal path.

**WHY (original):** Wrong-file lessons keyed under the same path blocked the fixer; load-time prune + prompt-time filter reduce reliance on single-issue-only workarounds.

## Blast radius and focus masking

**Idea:** Use the PR diff to compute a "blast radius" (changed files plus their upstream dependencies and downstream dependents), then focus the fix loop on that set and effectively ignore or deprioritize the rest.

- **Upstream:** files that changed files import/depend on.
- **Downstream:** files that import/depend on changed files.
- **Use:** Restrict which issues we process and which files appear in the fix prompt so the model and tooling focus on the scope of the PR; mask off out-of-scope code.

**WHY:** Audits show waste when the fix loop processes comments on files outside the PR's logical scope or when the prompt is diluted by many unrelated files. Focusing on blast radius reduces prompt size, improves fix accuracy, and avoids cross-file confusion (e.g. wrong-file exhaust). Tradeoff: some valid cross-file fixes might be deprioritized; depth limit and "changed files only" fallback keep scope reasonable.

Would require: PR changed-file list (`git diff base...HEAD --name-only`), a dependency graph (e.g. TS/JS import/require parsing), radius computation (depth limit), and integration into issue filtering and prompt building. Start with TS/JS; fallback to "changed files only" when no graph is available.

## Final audit: deleted files and outdated threads

**Status (partial):** **`runFinalAudit`** now (1) skips the adversarial LLM when the full-file snippet is **`(file not found or unreadable)`** and **`git ls-tree HEAD -- path`** shows the path is **not** at HEAD — synthetic **FIXED (git check)**; (2) **L1 tie-break:** if the model still says **UNFIXED** for a previously verified comment in that situation, we **keep verified** instead of re-queueing; (3) **Rule 6** post-check uses the same **`pathTrackedAtGitHead`** helper (non-empty `ls-tree` output = still tracked) instead of relying on `ls-tree` throwing; (4) **outdated** threads: a short **`[GitHub: thread OUTDATED …]`** prefix is prepended to the review text in the audit prompt. **`tools/prr/workflow/helpers/git-path-at-head.ts`**, **`tests/git-path-at-head.test.ts`**.

**Remaining (optional):** Richer “outdated” handling (e.g. cross-hunk verification), and further prompt tuning if audits still parrot **UNFIXED** when the file exists but the anchor line moved.

**WHY (original):** Runs showed final audit **UNFIXED** on deleted files, relying on overrides; git-backed shortcuts make the behavior explicit in **`output.log`** / state.

## Audit-derived follow-ups (optional)

From [tools/prr/AUDIT-CYCLES.md](../tools/prr/AUDIT-CYCLES.md) consolidated findings; not committed, low priority.

- **Ambiguous basename + PR diff / bug-repopulate / duplicate-cluster ALREADY_FIXED:** **Done** (see CHANGELOG [Unreleased], **DEVELOPMENT.md** path accounting, **Cycle 70** in AUDIT-CYCLES) — **`resolveTrackedPathWithPrFiles`** ties bare filenames to the unique path in the PR diff when possible; **`checkEmptyIssues`** restores **`resolvedPath`** on repopulate; **`ALREADY_FIXED`** dismisses full LLM dedup clusters; AAR suppresses boilerplate duplicate lines. **WHY:** Prevents wrong-file skips, “empty queue but 1 unaccounted comment”, and misleading handoff text (audited milady-style run).

- **pathExists for single-issue prompt:** **Done** (see CHANGELOG) — resolver/recovery pass `pathExists` into `buildSingleIssuePrompt` and no-changes verification.
- **Path normalization (runner allowlist):** **Already covered** — **`normalizePathForAllow`** applies **`normalizeRepoPath`** in **`shared/runners/llm-api.ts`** (backslashes and repo-relative form align with allow checks).
- **Tests:** **`getMigrationJournalPath`:** **`tests/migration-journal-path.test.ts`**. **`getFixedIssueTitle`:** **`tests/fixed-issue-title.test.ts`** (exported from **`tools/prr/ui/reporter.ts`**). **`pluralize`:** **`tests/pluralize.test.ts`**. **`isCodeRabbitMetaComment`:** **`tests/coderabbit-meta-comment.test.ts`** (exported from **`tools/prr/github/api.ts`**). **`shared/path-utils.ts`** (`isPathAllowedForFix`, `filterAllowedPathsForFix`): **`tests/path-utils.test.ts`**. **`getConsolidateDuplicateTargetPath`:** **`tests/consolidate-duplicate-path.test.ts`**. **Remaining (optional):** `getFixedIssueTitle` / meta-comment edge cases as audits surface them. **WHY:** Future refactors don't break behavior.

## Dismissal feedback loop (generator-judge learning)

**Idea:** Use the structured `dismissedIssues` data (already persisted in state) to close the loop between the issue generator (review bots) and the judge (fixer/verifier), so the system learns which issues are false positives and stops re-flagging them.

- **Export dismissed issues** in machine-readable format for generator training.
- **Pattern analysis** to identify common false positive types (e.g. "TypeScript types prevent this" shows up repeatedly — stop flagging null checks in typed code).
- **Dismissal rate metrics** per issue type / per bot, surfaced in run summary.
- **Automatic generator tuning** — feed dismissal patterns back into analysis prompts so the batch checker is less likely to say YES for known false-positive shapes.
- **Confidence scoring** — generator indicates uncertainty, judge can teach ("I'm 60% sure this is an issue" — judge confirms or dismisses with evidence).

**WHY:** Current runs show high dismissal rates (e.g. 62% EXISTING for already-fixed, many stale/file-unchanged). That implies the generator often flags issues that the judge then dismisses. Closing the loop would reduce tokens (fewer issues to analyze/fix), improve signal-to-noise for humans, and make PRR's behavior more predictable. Tradeoff: requires generator support or a separate "dismissal → analysis prompt" pipeline; we already persist dismissal reasons, so export and pattern analysis are low-hanging first steps.
