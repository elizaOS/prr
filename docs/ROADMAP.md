# Future / roadmap (exploration ideas)

Items here are potential directions to explore, not committed plans. Each idea includes **why** it would help, so we can revisit tradeoffs later.

**Completed work belongs in [CHANGELOG](../CHANGELOG.md), not here.** When an item is done, add it to CHANGELOG and remove it from this file. See `.cursor/rules/roadmap-vs-changelog.mdc`.

## Thread replies: single batch GraphQL for idempotency (optional)

**Idea:** Today we call `getThreadComments` once per candidate thread in parallel (`Promise.all`). A possible optimization is one batched GraphQL request (e.g. multiple `node(id: $id)` aliases in a single query) to fetch all thread comment authors in one round-trip.

**WHY:** Would reduce API round-trips when many threads are reply candidates; current parallel approach is already fast, so this is low priority unless we see latency issues on very large PRs.

## Single-issue focus: allowedPaths must include issue target

**Idea:** Ensure single-issue focus mode always includes the issue's own target file (`comment.path` / `resolvedPath`) in the allowed set passed to the runner. When `allowedPaths` is empty or filtered to empty (e.g. path under a top-level not in `REPO_TOP_LEVEL`), the runner rejects every change and wrong-file counter can fire falsely, leading to premature dismissal.

**WHY:** Pill audit (output.log) showed `expectedPaths: []` for single-issue fixes; the fixer correctly edited the target file but the runner rejected edits. We now add `plugins` and `benchmarks` to `REPO_TOP_LEVEL`, fallback to `[primaryPath]` when filter yields empty in recovery, and do not count edits to the issue's target as wrong-file. Tracked here so the fix stays thorough and tested across runners.

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

**Idea:** Detect when a file-specific lesson contradicts the issue's target file (e.g. "Do NOT edit benchmarks/bfcl/reporting.py" for an issue on that same file) and either clear it, flag it for human review, or normalize it so the fixer is not permanently blocked from editing the correct file.

**WHY:** Pill audit showed wrong-file lessons with an empty "need to modify one of:" list caused the fixer to refuse to edit the target file; we now prevent creating such lessons and normalize/reject them on load. A design-level solution would detect any lesson that forbids editing the issue's primary path and downgrade or remove it so batch mode can succeed without relying only on single-issue injection.

## Blast radius and focus masking

**Idea:** Use the PR diff to compute a "blast radius" (changed files plus their upstream dependencies and downstream dependents), then focus the fix loop on that set and effectively ignore or deprioritize the rest.

- **Upstream:** files that changed files import/depend on.
- **Downstream:** files that import/depend on changed files.
- **Use:** Restrict which issues we process and which files appear in the fix prompt so the model and tooling focus on the scope of the PR; mask off out-of-scope code.

**WHY:** Audits show waste when the fix loop processes comments on files outside the PR's logical scope or when the prompt is diluted by many unrelated files. Focusing on blast radius reduces prompt size, improves fix accuracy, and avoids cross-file confusion (e.g. wrong-file exhaust). Tradeoff: some valid cross-file fixes might be deprioritized; depth limit and "changed files only" fallback keep scope reasonable.

Would require: PR changed-file list (`git diff base...HEAD --name-only`), a dependency graph (e.g. TS/JS import/require parsing), radius computation (depth limit), and integration into issue filtering and prompt building. Start with TS/JS; fallback to "changed files only" when no graph is available.

## Final audit: deleted files and outdated threads

**Idea:** Improve final-audit handling when the issue's file was deleted by the fixer or the GitHub thread is marked "outdated". Today the audit may return UNFIXED (no file content to check); L1 (trust existing verification) overrides that, but the audit prompt should explicitly handle these cases so we don't depend on the override.

- **Deleted file:** When the snippet is "(file not found or unreadable)" or the file was removed in a fix, the audit should mark FIXED with explanation "File deleted; issue was resolved by removal" (or similar) instead of UNFIXED.
- **Outdated thread:** When GitHub marks the thread outdated (diff hunk moved), the audit should still have context (e.g. "thread outdated" in the prompt) so it can mark FIXED when the fix is present in current code.

**WHY:** pill-output.md (eliza run) showed final audit returning UNFIXED for all 3 issues (two on a deleted file), overridden only by L1. Without the override, the run would re-enter the fix loop incorrectly. Teaching the audit about deletions and staleness reduces reliance on L1 and makes behavior auditable.

## Audit-derived follow-ups (optional)

From [tools/prr/AUDIT-CYCLES.md](../tools/prr/AUDIT-CYCLES.md) consolidated findings; not committed, low priority.

- **getConsolidateDuplicateTargetPath:** Iterate all path matches in comment body and return the first that is not `comment.path` and not `lib/utils/db-errors.(ts|js)` (today we use first match only, so if db-errors is mentioned first we return null). **WHY:** When the canonical duplicate file is listed after db-errors, fixer could get allowed path for the right file.
- **pathExists for single-issue prompt:** **Done** (see CHANGELOG) — resolver/recovery pass `pathExists` into `buildSingleIssuePrompt` and no-changes verification.
- **Path normalization:** In runner `allowedSet`, add `.replace(/\\/g, '/')` so Windows-style paths match. **WHY:** Avoid cross-platform mismatches when comparing paths.
- **Tests:** Unit tests for `getMigrationJournalPath`, `getConsolidateDuplicateTargetPath`, `getFixedIssueTitle`, `pluralize`, `shared/path-utils.ts` (e.g. `isPathAllowedForFix`, `filterAllowedPathsForFix`), and optionally `isCodeRabbitMetaComment`. **WHY:** Future refactors don't break behavior.

## Dismissal feedback loop (generator-judge learning)

**Idea:** Use the structured `dismissedIssues` data (already persisted in state) to close the loop between the issue generator (review bots) and the judge (fixer/verifier), so the system learns which issues are false positives and stops re-flagging them.

- **Export dismissed issues** in machine-readable format for generator training.
- **Pattern analysis** to identify common false positive types (e.g. "TypeScript types prevent this" shows up repeatedly — stop flagging null checks in typed code).
- **Dismissal rate metrics** per issue type / per bot, surfaced in run summary.
- **Automatic generator tuning** — feed dismissal patterns back into analysis prompts so the batch checker is less likely to say YES for known false-positive shapes.
- **Confidence scoring** — generator indicates uncertainty, judge can teach ("I'm 60% sure this is an issue" — judge confirms or dismisses with evidence).

**WHY:** Current runs show high dismissal rates (e.g. 62% EXISTING for already-fixed, many stale/file-unchanged). That implies the generator often flags issues that the judge then dismisses. Closing the loop would reduce tokens (fewer issues to analyze/fix), improve signal-to-noise for humans, and make PRR's behavior more predictable. Tradeoff: requires generator support or a separate "dismissal → analysis prompt" pipeline; we already persist dismissal reasons, so export and pattern analysis are low-hanging first steps.
