# Future / roadmap (exploration ideas)

Items here are potential directions to explore, not committed plans. Each idea includes **why** it would help, so we can revisit tradeoffs later.

**Completed work belongs in [CHANGELOG](../CHANGELOG.md), not here.** When an item is done, add it to CHANGELOG and remove it from this file. See `.cursor/rules/roadmap-vs-changelog.mdc`.

## Thread replies: single batch GraphQL for idempotency (optional)

**Idea:** Today we call `getThreadComments` once per candidate thread in parallel (`Promise.all`). A possible optimization is one batched GraphQL request (e.g. multiple `node(id: $id)` aliases in a single query) to fetch all thread comment authors in one round-trip.

**WHY:** Would reduce API round-trips when many threads are reply candidates; current parallel approach is already fast, so this is low priority unless we see latency issues on very large PRs.

## Blast radius: optional follow-ups

**Status:** **Shipped** — regex import/include graph + directory + filename proximity, BFS both directions, issue annotation, optional dismiss, injection subset. See **CHANGELOG [Unreleased]** and **DEVELOPMENT.md** (Architecture — Blast radius).

**Remaining (exploration only):**

- **Parallel specifier resolution per file:** **`Promise.all`** over **`extractImports`** results for one source file could cut wall time; **trade-off:** burst of concurrent **`access`** / **`stat`** calls (FD pressure, noisy on slow/network FS). **WHY consider:** Very large monorepos with dense import lists.
- **Cooperative yield:** **`setImmediate`** (or batch **`await`**) every N scanned files so a single graph build cannot monopolize the microtask queue end-to-end. **WHY:** Marginal for typical sizes; helps if **`PRR_BLAST_RADIUS_MAX_FILES`** is raised sharply.
- **Recall without parsers:** e.g. read **`composer.json`** / **`tsconfig`** paths only if audits show systematic false negatives — **trade-off:** more config surface and maintenance; current design prefers regex + proximity over toolchain coupling.

**WHY this section:** Operators and agents asked “what’s next” after the feature landed; these are **not** commitments — safe defaults and graceful degradation already cover most runs.

## Single-issue focus + fixer allowed paths (non-standard repo roots)

**Status:** **Done** (see **CHANGELOG [Unreleased]** — open allowed-path policy, Cycle 72). **`isPathAllowedForFix`** defaults to **open**: hard deny only (absolute, `node_modules`, `dist/`, `.cursor`, `.prr`, `root/` segment). **`PRR_STRICT_ALLOWED_PATHS=1`** restores the legacy first-segment heuristic; **`setDynamicRepoTopLevelDirs`** (from PR **`git diff --name-only`**) still extends **`REPO_TOP_LEVEL`** in strict mode. **`trySingleIssueFix`** continues to mirror **`getAllowedPathsForIssues`** for rename targets, tests, etc.

**WHY (original pain):** Output.log audits showed **`expectedPaths: []`** / injection filtered when the primary path lived under a top-level dir not in the static list — runner rejected edits even though the issue targeted a real file. Open default plus docs removes the need to grow **`REPO_TOP_LEVEL`** for every customer layout; adjacent files in reviews remain editable without being in the PR diff’s first segment set.

**Remaining (optional):** If strict mode users still see edge cases, consider logging when strict mode drops a path (debug-only) to tune **`REPO_TOP_LEVEL`** without flipping default behavior.

## State consistency: verifiedFixed vs dismissedIssues (mutual exclusivity)

**Status:** **Done** for the write path — all comment lifecycle mutations that add/remove verified or dismissed rows go through **`transitionIssue`** (`tools/prr/state/state-transitions.ts`); **`markVerified`**, **`dismissIssue`**, **`StateManager`** helpers delegate there so **`verifiedThisSession`**, **`commentStatuses`**, and apply-failure fields stay aligned. Load paths still repair legacy overlap; **`already-fixed`** dismissals clear on HEAD change. See **CHANGELOG [Unreleased]** and **DEVELOPMENT.md**.

**Remaining (optional):** Broader “clear all dismissals on HEAD change” (trade-off vs. stable not-an-issue dismissals); explicit migration notes for very old state files; extra tests if new edge cases appear.

**WHY (original):** Pill audit noted overlap can confuse summaries and re-runs.

## Pill-output follow-ups (this repo)

From root **`pill-output.md`** triage — **prr** scope only:

- **Docs:** **DEVELOPMENT.md** lessons example JSON now uses **`tools/prr/`** / **`shared/`** paths; broader **`src/`** grep cleanup remains optional where examples mean “generic target repo”.
- **`autoVerifiedFrom`:** **Done** — **`recoverVerificationState`** sets **`PRR_GIT_RECOVERY_VERIFIED_MARKER`** on recovered IDs (see **`types.ts`** / **CHANGELOG**).
- **Git utilities:** **`checkForConflicts`** JSDoc + **debug** line clarify fetch-only vs in-progress conflicts; **`fetchOriginBranch`** timeout/clear documented in **CHANGELOG**.
- **CodeRabbit SHA vs HEAD:** **Partial** — startup warns when **`botReviewCommitSha`** ≠ PR HEAD (review **`commit_id`**, or **40-char SHA** in latest bot issue comment if no review row). Optional future: deprioritize stale threads or wait (trade-off vs speed).
- **Skip list ops:** Refresh **`ELIZACLOUD_SKIP_MODEL_IDS`** in **`shared/constants/models.ts`** (barreled as **`shared/constants.js`**) when Model Performance tables show new 0% models (**WHY:** static list drifts vs. gateway reality).
- **`determineScope`:** **Done** — falls back to first directory segment (e.g. `src`) when “meaningful” segments are empty.

## Lesson staleness / conflict detection

**Status (partial):** **`lessonForbidsEditingIssuePath`** in **`tools/prr/state/lessons-retrieve.ts`** — **`getLessonsForIssue`** drops lessons whose text forbids editing the issue path in the same negated clause (path must appear in the `do not edit …` span before `,` / `;` / `—`, so “don’t edit **bar**; bug is in **foo**” does not drop lessons for **foo**). **`pruneLessonsForbiddingOwnTargetPath`** on lesson load removes file-scoped rows that forbid editing their own key. **`tests/lesson-forbid-path.test.ts`**.

**Remaining (optional):** Lessons that forbid **`allowedPaths`** alternates without matching the primary path; richer NLP for “this file” without a literal path.

**WHY (original):** Wrong-file lessons keyed under the same path blocked the fixer; load-time prune + prompt-time filter reduce reliance on single-issue-only workarounds.

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

## Prompt / snippet budgeting (consolidation)

**Status:** **Done** for the shared layer — **`shared/prompt-budget.ts`** (`computeBudget`, `fitToBudget`, verify-batch helpers) replaces ad hoc per-call char caps for windowed snippets, full-file audit excerpts, and batch-verify “current code” truncation. **WHY:** One place to tune model limits vs reserved prompt overhead; reduces audit-cycle drift between paths.

**Remaining (optional):** Thread an explicit **`modelId`** through every **`getCodeSnippet`** call site if we want fix-loop snippets to track the active fixer model (today some paths default to the generic ceiling).

## Further structural follow-ups (optional)

**Idea A — Slim `LLMClient`:** **Partial** — **`llm-client-transport.ts`** and **`llm-client-types.ts`** split transport/types from **`client.ts`**; final-audit batching, conflict prompts, and other large builders may still move to dedicated modules. **WHY (remaining):** `client.ts` is still a hot file; smaller units reduce review load. **Tradeoff:** Further splits need careful re-export or import churn.

**Idea B — `shared/` GitHub + LLM surfaces:** Move a stable **`GitHubAPI`** (or narrower port) to **`shared/github/`** and core **`LLMClient`** (transport + **`complete`**) to **`shared/llm/`** (names TBD) so **split-plan**, **split-exec**, and **story** depend only on **`shared/`** instead of **`tools/prr/`**. **WHY:** Clear package boundaries and fewer accidental PRR→tool cycles. **Tradeoff:** Large migration; wait until GitHub/LLM module APIs stop churning (see **AGENTS.md** — *Future shared migration*).

**Idea C — Direct imports vs barrels:** Optionally migrate call sites from **`import { … } from '…/llm/client.js'`** to submodule paths where it improves tree-shaking or clarity; keep **`client.ts`** as the documented public surface until then. **WHY:** Barrels are convenient but can imply “everything lives in one file” to new readers.
