# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (2026-03) — Pill integration: circular import, error handling, double-init, dead code

**Circular import removed**
- `tools/pill/orchestrator.ts` no longer imports `formatNumber` from `shared/logger.js`. It uses `n.toLocaleString()` for user-facing counts (e.g. improvement counts in the summary entry).
- **WHY**: `shared/logger.ts` dynamically imports the pill orchestrator in `closeOutputLog()` to run the pill hook. The orchestrator previously imported from logger, creating a cycle (logger → orchestrator → logger). Breaking the dependency in the orchestrator keeps the hook safe and allows the main process to load without pulling in pill.

**runPillAnalysis no longer swallows errors**
- The top-level `try { ... } catch { return null }` was removed from `runPillAnalysis`. LLM, parse, and file-write errors now propagate to the caller.
- **WHY**: When pill is run from the CLI, users need to see real failures (e.g. missing API key, network error). The shared logger’s `closeOutputLog()` still wraps the call in try/catch so the hook never throws and shutdown always completes; only the CLI path sees thrown errors.

**Dead prompt removed**
- `VERIFY_SYSTEM_PROMPT` was removed from `tools/pill/llm/prompts.ts`. It was unused after the fixer/verify flow was removed from pill.
- **WHY**: Dead code adds noise and can confuse future changes; the audit prompt is the only one pill uses.

**Double-init guard in initOutputLog**
- In `shared/logger.ts`, the original console refs (`origLogRef`, `origWarnRef`, `origErrorRef`) are only set when they are still null. On re-entry we use `origXxxRef ?? console.Xxx.bind(console)` and assign to the refs only if they are null.
- **WHY**: If `initOutputLog` is called twice, the second time the current `console.log` is the *patched* function from the first init. Overwriting the refs with that would make the pill hook log to a closed or wrong stream. Keeping the first capture preserves the real console for the hook.

**pillAnalysisEnabled reset before await**
- In `closeOutputLog()`, `pillAnalysisEnabled = false` is set at the start of the `if (pillAnalysisEnabled && outputLogPath)` block, before any dynamic import or await.
- **WHY**: So the hook runs at most once even if `runPillAnalysis` or a later step throws; the flag is cleared before async work so a subsequent close doesn’t re-run pill.

- Docs: [tools/pill/README.md](tools/pill/README.md) (pill documentation with WHYs).

### Added (2026-03) — story tool (PR and branch narrative & changelog)

**New CLI: story**
- `story <pr-or-branch> [--compare <branch>] [--output <file>]` builds a narrative, feature catalog, and changelog (Added/Changed/Fixed/Removed) from a GitHub PR or branch. Modes: PR (title/body + commits + files), single branch (commit history only via List Commits API), two branches (`--compare`; compare API, primary branch preferred as “newer” when diverged).
- **WHY single-branch uses commit history only:** A branch may be behind default (e.g. v2-develop behind develop); comparing to default would yield 0 commits. Listing the branch’s commits always gives a story without requiring a base ref.
- **WHY prefer primary branch in two-branch mode:** The first argument is the branch the user cares about. When both directions have commits (diverged), we use the direction where that branch is the “newer” ref so the narrative describes what happened on it.
- **WHY story-output.log / story-prompts.log prefix:** Shared logger supports `initOutputLog({ prefix: 'story' })` so story and prr don’t overwrite each other’s logs when run from the same directory (same pattern as pill’s pill-output.log).
- **WHY normalize --compare to branch name:** The GitHub compare API expects ref names; passing a tree URL causes 404. We parse tree URL or owner/repo@branch and pass only the branch name; same-repo check when owner/repo provided.
- **WHY buildCommitSummary avoids overlap:** When total commits ≤ maxCommits we show all; when total > maxCommits we use non-overlapping first/last halves (`half = min(maxCommits/2, total/2)`). Previously first+last could overlap and duplicate ~50 commits in the prompt.
- **Changelog prompts** include optional “### Removed” section so the model can document removals (e.g. pnpm, legacy characters) without inventing a new heading.
- Docs: [tools/story/README.md](tools/story/README.md). GitHub API additions: getPRFiles, getDefaultBranch, getBranchComparison, getBranchCommitHistory, getBranchComparisonEitherDirection, getBranchComparisonWithFallback; types: parseBranchSpec, normalizeCompareBranch.

### Added (2026-03) — GitHub Actions caller token and null-safe review path handling

**GitHub Actions: use caller's token and avoid reserved secret name**
- Reusable workflow `run-prr-server.yml` now declares the token secret as `PRR_GITHUB_TOKEN` instead of `GITHUB_TOKEN`. The client workflow passes `PRR_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` so the **caller repo's** default token is used end-to-end; no separate PAT or new secret is required for normal use.
- **WHY (PRR_GITHUB_TOKEN name)**: GitHub does not allow a secret named `GITHUB_TOKEN` in `workflow_call` because it collides with the system-reserved name. Using a different input name (e.g. `PRR_GITHUB_TOKEN`) and mapping it to `GITHUB_TOKEN` in the job env avoids the collision while keeping the tool's expectations unchanged.
- **WHY (caller token)**: Passing `secrets.GITHUB_TOKEN` from the caller gives the job the same permissions as the repo that triggered the run, so PRR can read/write the same PR and push commits without configuring an extra PAT. Use a PAT only when you need cross-repo access or higher rate limits.

**Null-safe review comment path handling**
- `tools/prr/github/api.ts`: When building review comments from GraphQL threads, bot-issue parsing, or markdown parsing, `path` is never left null or undefined. Fallbacks: `(unknown file)` for GraphQL threads, `(PR comment)` for parsed/bot issues when the parser does not extract a path.
- `tools/prr/workflow/helpers/solvability.ts`: Comments with null or empty `comment.path` are dismissed early with reason "Comment has no file path — cannot target a fix"; path traversal and normalization no longer run on null.
- **WHY**: Runs were failing with `TypeError: null is not an object (evaluating 'file...')` when parsing claude[bot] (and other) issue comments. The GraphQL API can return `path: null` for some review threads, and the markdown parser can yield undefined path when a regex capture is missing. Downstream code (e.g. `join(workdir, comment.path)`, `comment.path.replace`) then threw. Guaranteeing a string path everywhere and dismissing path-less comments in solvability keeps the pipeline safe and avoids losing thread comments when bot parsing hits an edge case.

### Added (2026-03) — Hedged visibility patterns and weak-identifier stale retargeting

**Hedged “truncated snippet/excerpt” explanations keep issues open**
- `tools/prr/llm/client.ts` now treats explanations that hedge on truncated context (e.g. “the truncated snippet suggests…”, “appears to… truncated snippet”, “the truncated excerpt suggests…”) as missing-code visibility, so those verdicts are overridden to keep the issue open instead of accepting low-confidence STALE/NO.
- A dedicated pattern for “truncated excerpt” (without “snippet”) allows tests to pin this behavior without overlapping older snippet-only patterns.
- **WHY**: Audits showed STALE dismissals driven by “truncated snippet suggests…”-style reasoning, which is uncertainty rather than true staleness. Treating hedged language as “I couldn’t see enough” keeps PRR conservative and avoids false dismissals.

**Stale retargeting ignores weak built-in/type identifiers**
- `tools/prr/workflow/helpers/solvability.ts` now splits backtick-extracted identifiers into “strong” (e.g. function/var names) and “weak” (built-ins and type names such as `BigInt`, `bigint`, `symbol`, `Map`, `string`). When a comment’s line is out of range and the only extracted identifiers are weak, PRR keeps the issue solvable with a context hint instead of dismissing as stale.
- **WHY**: Line-drift stale cases were being driven by incidental tokens like `BigInt` that appear in many files; using them as “identifier not found” evidence produced incorrect stale dismissals. Weak identifiers are poor anchors for “code moved or was removed.”

**Targeted tests**
- `tests/llm-issue-existence.test.ts` covers hedged truncated-snippet and truncated-excerpt explanations.
- `tests/non-actionable-comments.test.ts` covers line-drift with only weak identifiers (e.g. `BigInt`) remaining open.

### Added (2026-03) — Path-resolution categories, create-file test issues, and recap-comment filtering

**Path resolution now distinguishes missing files from unresolved paths**
- `tools/prr/workflow/helpers/solvability.ts` now uses structured tracked-path resolution instead of a single "exists / does not exist" outcome. Comments can now resolve as exact, suffix, body-hinted, ambiguous, or missing, and dismissed issues can be categorized as `missing-file` or `path-unresolved` instead of always `stale`.
- Downstream workflows now carry `resolvedPath` forward when a truncated/basename review path is mapped to a canonical tracked repo file.
- **WHY**: Output from PR #6562 showed many comments being labeled "File no longer exists" when the real problem was different: basename ambiguity (`logger.ts`), path fragments from recap prose (`banner.ts`), or a path that was valid only after expanding it to the real repo path. Splitting these cases makes the debug table and dismissal reasons match reality.

**Missing test/spec paths stay fixable as create-file issues**
- Missing paths that look like test/spec files and are requested by the review now remain solvable instead of being dismissed. PRR treats them as create-file issues, preserves the target path, and provides create-file snippet guidance during issue analysis.
- `workflow/analysis.ts` also preserves the resolved/create-file path for new comments added mid-run so those issues enter the queue with the same behavior.
- **WHY**: "Missing tests" comments were being thrown away as stale because the target file did not exist yet, even though the correct action was to create that file. For test coverage issues, absence is often the fix target, not proof the comment is obsolete.

**Shared test-path inference and explicit test-path preservation**
- Test-target inference now lives in `tools/prr/analyzer/test-path-inference.ts` and is reused by both prompt building and solvability. This keeps create-file inference, allowlists, and retry handling on the same path-selection rules.
- The shared helper now preserves explicit existing test/spec paths before applying the text-based "is this asking for tests?" gate, so coverage-only wording on a missing `*.test.ts` path still stays in the create-file flow.
- **WHY**: The first create-file fix solved the broad problem but left two smaller gaps: prompt-building and solvability could still drift apart on explicit test-file naming, and the shared helper briefly regressed the case where the review path itself was already a test file. Unifying the logic removes both classes of mismatch.

**Missing-code visibility now re-opens `NO` verdicts too**
- `tools/prr/llm/client.ts` now uses `explanationMentionsMissingCodeVisibility()` for `NO -> YES` as well as `STALE -> YES`, so explanations like "the truncated snippet doesn't show enough code" never mark an issue fixed just because the model answered `NO`.
- **WHY**: The earlier visibility fix only rescued `STALE` verdicts. A model could still answer `NO` while admitting it had not seen enough code, which is equally unsafe. If the code was not visible, PRR should keep the issue open regardless of whether the model said `NO` or `STALE`.

**Summary / recap parsing is stricter about bare filenames**
- `tools/prr/github/api.ts` now skips summary/status recap blocks earlier and only accepts bare filenames like `reply.ts` or `banner.ts` when they appear in stronger actionable contexts (for example backticks or phrases like "add tests for `reply.ts:106`").
- Inline dismissal-comment insertion now reuses the shared path resolver instead of maintaining a second looser suffix matcher.
- **WHY**: The old parser would happily treat recap tables and prose bullets as file-local issues, which then produced fake stale dismissals. Tightening bare-filename parsing reduces review-summary leakage without losing explicit actionable bare-file comments.

**Targeted regression tests**
- `tests/non-actionable-comments.test.ts` now covers ambiguous basename dismissal and missing test-file create-file handling.
- `tests/issue-analysis.test.ts` covers the create-file snippet path for missing tests.
- `tests/github-api-parser.test.ts` covers recap-table filtering and explicit actionable bare-file parsing.
- **WHY**: These failures are easy to reintroduce because they live in heuristics at the parser/solvability boundary. Tests keep the new categories and create-file bias intentional.

### Added (2026-03) — Conservative issue detection and debug issue tables

**Conservative analysis context for lifecycle/order-sensitive issues**
- `tools/prr/workflow/issue-analysis.ts` now classifies lifecycle/cache/leak comments and ordering/history comments (for example `sliceToFitBudget` / `fromEnd` newest-vs-oldest issues) as needing broader analysis context before the fixer runs.
- Lifecycle issues reuse `buildLifecycleAwareVerificationSnippet()` so analysis sees declaration plus usage/cleanup sites across the file, not just a local anchor window.
- Ordering/history issues now use a multi-range `buildOrderingAwareAnalysisSnippet()` that pulls together the ordering source and the later selection/trimming sites when the full file is too large to embed.
- **WHY**: PRR was still dismissing some real issues during the *analysis* phase, before verification ever got a chance to be conservative. Narrow local snippets made distributed bugs look already fixed when the real failure lived in distant cleanup or retention code.

**Safer "already correct" override in issue existence checks**
- `tools/prr/llm/client.ts` now treats lifecycle/order-sensitive comments as conservative issue-existence checks and requires concrete evidence before flipping a model's `YES` verdict to `NO` based on "already correct" language.
- **WHY**: The old override could accept vague explanations like "already correct" and silently downgrade real issues to resolved. For the risky bug classes, conservative false negatives are cheaper than false positives that hide real defects.

**Human-readable debug issue tables**
- `tools/prr/workflow/debug-issue-table.ts` adds a verbose-mode table printed after analysis and again at final cleanup. It shows each comment's location, PRR status, reason, and short comment preview.
- The table now prefers the actual decision category order: `open` -> `dismissed/<category>` -> `verified` -> cached status.
- **WHY**: When PRR says "all fixed" but the PR still shows open comments, operators need a direct side-by-side view of what PRR thinks each thread is. The table is meant to make classification mistakes obvious, not hide them behind aggregate counts.

**Targeted tests for conservative analysis**
- `tests/issue-analysis.test.ts` now covers lifecycle-aware analysis snippets and ordering-aware multi-range snippets for large files.
- `tests/llm-issue-existence.test.ts` covers conservative existence-check classification and the requirement for concrete evidence in "already correct" explanations.
- **WHY**: Prompt/snippet heuristics are easy to regress. These tests lock in the conservative bias and the new debug-facing behavior so future tuning does not quietly reintroduce the same false dismissals.

### Added (2026-03) — Conservative verification for lifecycle/cache/leak issues

**Lifecycle-aware verifier context**
- `tools/prr/workflow/fix-verification.ts` now classifies leak/cache/cleanup comments with `commentNeedsLifecycleContext()` and builds broader verification snippets with `buildLifecycleAwareVerificationSnippet()`. Instead of checking only the anchor line, the verifier now sees the tracked symbol's declaration plus key usage and cleanup sites across the file.
- **WHY**: Output.log showed PRR marking a `latestResponseIds` leak as fixed after seeing a narrow declaration-area snippet, even though the real failure lived in distant early-return and cleanup paths. Leak/lifecycle issues are whole-flow problems, not local-line problems.

**Safer verification policy for stateful issues**
- Lifecycle/cache/leak issues now use the stronger verifier lane alongside API/signature issues, and they are excluded from the "pattern absent after N rejections" auto-verify shortcut.
- `tools/prr/llm/client.ts` batch verification prompt now explicitly tells the verifier that declaration-only tweaks are not sufficient for lifecycle/cache/leak issues; the relevant creation, replacement, and cleanup paths must be safe together before answering `YES`.
- **WHY**: When we are unsure, PRR should leave an issue open rather than prematurely dismiss it as fixed. False negatives cost another iteration; false positives leave bugs in the PR and make the review state look deceptively clean.

**Targeted verifier tests**
- Added `tests/fix-verification.test.ts` to cover lifecycle-comment detection and lifecycle-aware snippet extraction.
- **WHY**: This behavior is easy to regress during future prompt/snippet tuning. Tests keep the conservative verification bias intentional and visible.

### Added (2026-03) — Output.log + prompts.log follow-up: finish canonical paths, commit gating, rename targets

**Canonical paths now reach cleanup / refresh / verification / commit flows**
- `iteration-cleanup.ts`, `fix-loop-utils.ts`, `fix-verification.ts`, `no-changes-verification.ts`, `push-iteration-loop.ts`, and both commit helpers now consistently prefer the issue's canonical primary path (`resolvedPath ?? comment.path`) for file hashing, snippet refresh, dismissal records, verification failure escalation, lesson cleanup, and commit-message file matching.
- `tools/prr/analyzer/types.ts` now exports `getIssuePrimaryPath()` so later workflow stages do not silently fall back to the raw truncated review path.
- **WHY**: The earlier canonical-path work fixed issue creation and prompt building, but later phases still used bare review fragments like `sentry-bun.d.ts` or `test-unit-isolated.ts`. That let the fixer succeed on the real file and then crash in cleanup/commit/reporting with `fatal: pathspec ... did not match any files`.

**Do not commit or push leftover workspace changes when this iteration verified nothing new**
- `push-iteration-loop.ts` now skips the final commit/push phase when the worktree is dirty but this push iteration produced no newly verified, uncommitted fixes.
- `commit.ts` and `commit-and-push-loop.ts` now scope commit messages to comments verified in the current session and resolve their paths against tracked files before matching them to staged files.
- **WHY**: Output.log showed PRR skipping the fixer because everything in queue was already verified, then still creating a commit from unrelated leftover changes in the worktree. Commits must be tied to fixes actually verified in the current iteration, not whatever happens to be dirty.

**Rename-target inference for test-file naming issues**
- `prompt-builder.ts` now infers rename destinations like `foo.test.ts` from review comments, includes them in TARGET FILE(S), and ignores fake sibling matches such as bare `test.ts` extracted from phrases like "`.test.ts` extension".
- Issue creation, batch allowed-path calculation, and single-issue prompt building now all include the inferred rename target so the fixer may rename the file instead of being trapped on the old path.
- **WHY**: Naming comments about missing `.test.ts` suffixes were generating bogus allowlists like `.../test.ts` while rejecting the real renamed destination as disallowed. Explicit rename-target inference fixes the allowlist and removes the misleading extension fragment path.

**Batch prompts must account for skipped issues explicitly**
- Multi-issue fix prompts now instruct the fixer to emit per-issue `ISSUE N RESULT: ...` lines whenever any issue in the batch is left untouched, instead of hiding behind a batch-level `RESULT: FIXED`.
- **WHY**: Prompts.log showed partial batch successes where one issue was silently skipped while the overall response still claimed `RESULT: FIXED`. Requiring explicit per-issue accounting makes silent skips much easier to detect and reason about.

### Added (2026-03) — Prompts.log follow-up: canonical path propagation and safer full-file rewrite escalation

**Canonical path propagation into fix flows**
- `issue-analysis.ts` now resolves truncated review paths against tracked repo files when constructing `resolvedPath`, and it uses that canonical path when building `allowedPaths` for new unresolved issues.
- Single-issue prompt building, recovery flows, and direct-fix file reads now prefer `resolvedPath` over the raw review path when fetching snippets, reading full files, resetting files, diffing, and verifying.
- **WHY**: Prompts.log/output.log still showed issues like `generate-skills-md.ts` entering later fix flows with the bare/truncated path even after early stale-dismissal resolution. That left prompts, allowlists, and git/file operations out of sync, so the fixer either missed the real file or had the correct file blocked as disallowed.

**Skip contradictory full-file rewrite escalation when file content was not injected**
- In `shared/runners/llm-api.ts`, files that were not injected into the prompt no longer auto-escalate to “Use `<file path=...>` to output the COMPLETE fixed file”.
- **WHY**: Prompts.log showed PRR asking for full-file rewrites while also omitting the file content from the prompt. That is internally contradictory: the model is told to rewrite the entire file without seeing the file. Keeping those cases in search/replace mode avoids teaching the model to guess whole files from incomplete context.

### Added (2026-03) — Prompts.log follow-up: dedup prompt cleanup and stronger praise filtering

**Dedup prompt examples use valid indices**
- The dedup prompt in `issue-analysis.ts` now uses in-range example groups only (`GROUP: 1,2 → canonical 2`, `GROUP: 1,3 → canonical 3`) instead of showing impossible indices like `2,5,7` in a 3-comment prompt.
- **WHY**: Prompts.log showed that even after adding the `1..N` rule, the prompt still contained an out-of-range example. That contradictory example teaches the wrong output shape and likely contributes to malformed GROUP lines.

**Positive-only review filtering tightened**
- `isCommentPositiveOnly()` in `issue-analysis.ts` now also catches high-confidence praise/security-only phrasings seen in the audit, including "looks clean and follows ... spec", "nice work on the frontmatter structure", "no hardcoded credentials", "doesn't expose any sensitive APIs", and "no security issues/concerns identified" so long as the comment contains no actionable language.
- **WHY**: Prompts.log showed praise-only comments still reaching the verifier (for example, "The output looks clean and follows the AgentSkills spec. Nice work on the frontmatter structure."). Filtering them earlier saves tokens and keeps the fix queue focused on actionable issues.

### Added (2026-03) — Output.log follow-up: avoid incorrect skips from truncated paths

**Resolve truncated review paths before stale dismissal**
- In `workflow/helpers/solvability.ts`, file-existence and line-validity checks now resolve possibly truncated review paths against tracked repo files before dismissing as `stale` / "File no longer exists". Exact matches win first; unique suffix matches are allowed; ambiguous bare basenames are rejected rather than guessed.
- **WHY**: Babylon #1207 output.log showed comments for `generate-skills-md.ts`, `SKILL.md`, `sentry-bun.d.ts`, and `wallet/nfts/route.ts` being dismissed as missing even though the real repo files existed under longer paths. Resolving review paths before dismissal avoids skipping actionable comments incorrectly.

**Single-issue and no-changes pathExists alignment**
- `buildSingleIssuePrompt` now accepts optional `pathExists`, and resolver/recovery pass it so single-issue prompts can choose the real test path (`__tests__/integration/...`) instead of always guessing a co-located `*.test.ts`.
- `handleNoChangesWithVerification` now also passes `pathExists` when persisting a test path after UNCLEAR.
- **WHY**: Batch/recovery already used `pathExists`, but single-issue/no-changes paths could still mention the wrong test file in repos that use integration-test layouts, recreating the same wrong-target behavior in a different branch of the workflow.

**Disallowed test-file retry learning**
- In `execute-fix-iteration.ts`, the "fixer attempted disallowed test file" fallback now also triggers when the review says to fix the root cause in tests (not just explicit "add/update tests" wording), and it checks whether the inferred test path is already in `allowedPathsForBatch` before adding a retry allowance.
- **WHY**: Reviews like "fix logger mocks in tests" should teach the retry loop to allow the attempted test file. The previous gate only looked at `issueRequestsTests()` and could miss this class of comments.

### Added (2026-03) — Prompts.log audit (Cycle 16): grouping validation

**Dedup GROUP line validation**
- In `issue-analysis.ts`, when parsing LLM dedup GROUP lines (e.g. `GROUP: 1,3 → canonical 3`), we now require every index to be in [1, N], require the canonical index to be in the group list, and skip the entire line if any index is out of range. Previously we filtered to valid indices and could apply a subset (e.g. "GROUP: 2,5,7" with 3 comments yielded indices [1] and we skipped due to canonical 5 out of range; "GROUP: 1,3 → 3" merged 1 into 3 even when the LLM meant something else). **WHY**: Prompts.log audit (Cycle 16) — grouping #0001 returned "GROUP: 2,5,7" and "GROUP: 1,3" with only 3 comments; rejecting invalid lines avoids wrong merges when the model hallucinates indices.
- The dedup prompt now explicitly says valid comment indices are `1..N` for the current file and that the canonical index must be one of the indices in its GROUP line. **WHY**: Tightening the prompt reduces malformed GROUP responses before they reach the parser.

**Bot prediction changed-files guard**
- In `bot-prediction-llm.ts`, skip the display-only bot-prediction LLM call for tiny meta-only diffs (e.g. `.gitignore`-only commit with very few meaningful added/removed lines).
- When prediction does run, the prompt now lists the changed files and instructs the model to output only files present in that diff; parsed predictions are also filtered to `changedFiles`.
- **WHY**: Prompts.log audit (Cycle 16) — predict-bots ran on a tiny `.gitignore` diff and hallucinated `scripts/build-skills-docs.js`. The predictor is only for UX, so skipping low-signal diffs and filtering to the actual changed files saves tokens and removes noisy output.

### Added (2026-03) — Output.log audit (Cycle 15): fix-in-test allowed path

**Fix-in-test allowed path**
- New `reviewSuggestsFixInTest(body)` in `prompt-builder.ts` detects when the review says to fix the root cause in tests (e.g. "fix logger mocks in tests", "root cause in tests", "update the test mocks", "rather than workaround in production").
- `getTestPathForSourceFileIssue` now accepts optional `forceTestPath`. When true, the co-located test path is returned even when the issue does not explicitly "request tests", so TARGET FILE(S) includes the test file when the review suggests fixing there.
- Allowed paths (batch, single-issue, recovery, no-changes verification, and at issue creation in `getEffectiveAllowedPathsForNewIssue`) now add the co-located test file when `reviewSuggestsFixInTest(comment.body)` is true.
- **WHY**: Cycle 15 (babylon#1207) — The run stalled because the review asked to "fix logger mocks in tests" but TARGET FILE(S) only listed the production file; the fixer either no-opped or tried the test file and was blocked. Adding the test path when the review suggests fix-in-test lets the fixer edit the test file.

### Added (2026-03) — Output.log + prompts.log audit (Cycle 12): in-loop dismissal, new-comment solvability, ALREADY_FIXED filter, STALE→YES

**couldNotInject in-loop dismissal**
- At the start of each fix iteration in `push-iteration-loop.ts`, issues whose `couldNotInjectCountByCommentId` is at or above `COULD_NOT_INJECT_DISMISS_THRESHOLD` (3) are dismissed as `file-unchanged` and removed from the queue. If the queue becomes empty after this step, we set `allFixed` and break.
- **WHY**: The threshold was only checked in `findUnresolvedIssues`, which runs at the start of a push iteration. Inside the fix loop we keep retrying single-issue focus without re-running analysis, so issues that hit the threshold mid-loop were never dismissed and were retried 10+ times (output.log audit: 4 comments reached count 11+). Applying the same dismissal at the start of each fix iteration stops the loop and saves ~40–50 wasted iterations per run.

**New-comment solvability (P1)**
- `processNewBotReviews` in `fix-loop-utils.ts` now accepts optional `stateContext` and `workdir`. When both are provided, each new comment is run through `assessSolvability` before being added to the queue; unsolvable comments (e.g. path `(PR comment)`, lockfiles, path traversal) are dismissed with `Dismissed.dismissIssue` and only solvable ones are added. All new comment IDs (including dismissed) are added to `existingCommentIds` so they are not re-fetched as "new" on the next check.
- `executePreIterationChecks` accepts an optional `workdir` and passes it and `stateContext` to `processNewBotReviews`; `push-iteration-loop` passes `workdir` from the git context.
- **WHY**: New bot comments arriving mid-fix-loop were added directly to `unresolvedIssues` without running solvability. The `(PR comment)` path and other unsolvable items therefore entered the fix queue and burned 10+ iterations each with RESULT: UNCLEAR (prompts.log audit). Applying the same solvability filter as at push-iteration start prevents this; tracking dismissed IDs in `existingCommentIds` avoids re-fetching them.

**ALREADY_FIXED batch filter (P3)**
- In `execute-fix-iteration.ts`, when building `issuesForPrompt`, we now also exclude any issue whose `consecutiveAlreadyFixedAnyByCommentId` is >= 2 (in addition to excluding already-verified issues).
- **WHY**: Single-issue focus correctly returned ALREADY_FIXED for some issues; the next batch fix prompt re-included those same issues (e.g. server-wallets, topup/10, topup/100) because the prompt builder only filtered by `Verification.isVerified`. The fixer again returned ALREADY_FIXED, wasting a 64k+ char batch (prompts.log audit). Excluding issues that have already been reported ALREADY_FIXED 2× avoids re-sending them until they are dismissed at the 3× threshold.

**STALE→YES override expansion (P2)**
- In `tools/prr/llm/client.ts`, the batch override that flips STALE to YES when the explanation indicates "code/snippet not visible" now also matches: "can't be evaluated", "cannot assess/determine/verify", "(code|snippet|excerpt|current code) doesn't show", "only shows" when followed by "not/beginning/start/first/lines N", "incomplete" when followed by "show/visible/implementation", and "not visible/shown/included in (current|provided) (excerpt|code|snippet)". The "only shows" branch is tightened so it does not match legitimate STALE (e.g. "file only shows a re-export now").
- **WHY**: Judge instructions say: if you would say "not visible in the provided excerpt" or "not in excerpt", say YES not STALE. The verifier often used different phrasings ("can't be evaluated from the current code snippets", "code doesn't show the SIWE logic", "only shows the beginning"). Forty-eight such STALE verdicts in prompts.log were false dismissals; expanding the override catches these while avoiding false positives on genuine STALE.

### Added (2026-03) — Prompts.log audit: ALREADY_FIXED counter, batch injection filter, single-issue full file, verifier type/signature context

**ALREADY_FIXED multi-model dismissal (P1)**
- New `consecutiveAlreadyFixedAnyByCommentId` state counter tracks how many consecutive times any model returns ALREADY_FIXED for an issue, regardless of explanation text. When the count reaches `ALREADY_FIXED_ANY_THRESHOLD` (3), the issue is dismissed as `already-fixed`.
- Counter is incremented in `no-changes-verification.ts` on every ALREADY_FIXED result. Reset in `execute-fix-iteration.ts` when the fixer actually makes changes (streak broken) and in `iteration-cleanup.ts` when an issue is verified fixed.
- `assessSolvability` in `solvability.ts` also checks the counter so issues are dismissed before any LLM call on subsequent iterations.
- **WHY**: Prompts.log audit showed issues where 3+ different models all returned ALREADY_FIXED with varying explanations ("guard clause exists", "null check present", "already handled"). The existing same-explanation counter (`ALREADY_FIXED_EXHAUST_THRESHOLD = 2`) only fired when the explanation text matched. A separate any-explanation counter catches the broader pattern: when multiple models independently agree the issue is already fixed, it almost certainly is. Dismissing saves 3-5 wasted fix iterations per issue.

**Batch file injection filter (P3)**
- New `allowedPathsForInjection` option on `RunnerOptions`. When set, `injectFileContents` in `llm-api.ts` only injects file contents for paths in the allowed set, skipping files that have no remaining unfixed issues.
- `execute-fix-iteration.ts` passes `allowedPathsForBatch` (the set of file paths with unresolved issues) as `allowedPathsForInjection` to the runner.
- **WHY**: In later fix rounds (push iteration 2+), many files referenced in the prompt are already fixed. Injecting their full contents wastes context budget on files the fixer doesn't need to touch. Filtering injection to only files with unfixed issues keeps the prompt focused and leaves more room for files that actually need changes. Observed: 40-60% reduction in injected content on rounds 2+ for PRs with many files.

**Single-issue full file context (P5)**
- New `getFullFileContentForSingleIssue(workdir, path, maxLines = 600)` in `workflow/utils.ts` reads a file's content up to 600 lines.
- `resolver.ts` `buildSingleIssuePrompt` now uses this as a default `codeSnippetOverride` when no wider snippet was explicitly requested. The fixer sees the full file (or first 600 lines) instead of a short 20-30 line snippet.
- **WHY**: Prompts.log audit showed single-issue fix prompts sending only a 15-30 line snippet around the issue line. Models frequently responded INCOMPLETE_FILE or UNCLEAR because they couldn't see imports, type definitions, or the broader function context. Sending the full file (capped at 600 lines to avoid prompt bloat) gives the model enough context to make correct fixes. For files under 600 lines this is the complete file; for larger files it's the first 600 lines which typically covers the issue.

**Verifier expanded context for type/signature issues (P7)**
- New `commentMentionsApiOrSignature(fix)` helper in `fix-verification.ts` detects when a review comment mentions async/await, signatures, TypeErrors, callers, or method parameter changes.
- `getCurrentCodeAtLine` accepts optional `expandForTypeSignature` flag. When true, returns up to `MAX_LINES_FULL_FILE_VERIFY_TYPE_SIGNATURE` (500) lines instead of the default 200.
- Both sequential and batch verification paths pass the flag based on `commentMentionsApiOrSignature`.
- **WHY**: For type- or signature-related issues, the verifier needs to see the full function body and potentially call sites to determine whether the fix is correct. With the default 200-line limit, the verifier would say "role never assigned" or "method not found" because the relevant code was outside the window. 500 lines covers most function bodies and their immediate call sites. This complements the stronger-model verifier (from the earlier audit) — expanded context + stronger model together reduce false rejections for API/signature fixes.

### Added (2026-03) — Comment parsing: parse all bot comments, noise filter, path-less gap fix

**Bot noise filter**
- New `isBotNoiseComment(body)` in `github/api.ts` filters out junk comments before parsing: comments shorter than 60 chars, "IGNORE THIS" prefixed, or bare bot trigger commands (e.g. `@coderabbitai review`).
- **WHY**: When parsing ALL bot comments (not just the latest), noise comments that are test messages, trigger commands, or placeholder text would pollute the issue list. The noise filter runs before `parseMarkdownReviewIssues` so these never enter the pipeline. The 60-char threshold is conservative — real review comments are always longer; trigger commands and test messages are always shorter.

**Parse all bot comments (not just latest)**
- `getReviewBotIssueComments` now iterates ALL comments from known review bots (`REVIEW_BOTS_PARSE`), not just the latest one per bot. The `.sort()` by date was removed; comments are processed in API order.
- Each comment gets a unique ID: `ic-${comment.id}-${i}` for structured issues, `ic-${comment.id}` for unstructured fallback.
- Non-structured comments fall back to `inferPathLineFromBody` to extract a file path.
- The `otherComments` section (non-bot PR conversation comments) remains unchanged.
- **WHY**: Previously only the latest comment per bot was parsed, under the assumption that bots re-review on each push and the latest comment is the most current. This missed issues from earlier comments that were never re-posted — e.g. a bot's initial review might flag 15 issues, but a later re-review only mentions 3 new ones. The old code would see only the 3, missing the original 15. Parsing all comments ensures zero missed issues. The noise filter prevents junk from inflating the issue count.

**Path-less items included with actionable filter**
- `parseMarkdownReviewIssues` no longer silently drops items that have no recognizable file path. If an item's body is >= 100 chars and contains actionable language (fix, bug, error, missing, should, must, add, remove, change, update, incorrect, broken, crash, fail, import, undefined, null), it's included with `path: '(PR comment)'`.
- Downstream, `assessSolvability` dismisses `(PR comment)` issues at zero LLM cost, so including them is safe.
- **WHY**: Some bot review comments describe real issues without citing a specific file (e.g. "The error handling across the authentication flow is inconsistent — some endpoints return 401, others return 403 for the same condition"). These were silently dropped, meaning PRR never saw them. Including them with a synthetic path lets the solvability check decide whether they're actionable. The 100-char minimum filters out section intros ("Here are the issues:") and the actionable regex filters out pure prose summaries. The `continue` after the path-less branch prevents fall-through to the path-having branch.

### Added (2026-03) — Prompts.log audit: dedup same-caller, verifier strength, dismissal skips, multi-file nudge

**Skip dismissal-comment when file no longer exists**
- In `tools/prr/workflow/dismissal-comments.ts`, issues whose dismissal reason matches "file no longer exists", "file not found", or "no longer exists" are filtered out before any LLM call or file read.
- **WHY**: Prompts.log audit showed a dismissal-comment prompt sent for a file with reason "File no longer exists: stores/task.store.ts" — the LLM was asked to write a comment in a missing file, wasting tokens and producing a comment that would never be inserted. Skipping at filter time avoids the call and any path-resolution work.

**Post-filter generic dismissal comments**
- In `tools/prr/llm/client.ts` (`generateDismissalComment`), after parsing a `COMMENT: Note: ...` response we check whether the comment mostly restates the surrounding code (2–8 words, ≥2 words of length ≥4 appear in the code). If so, we return `needed: false` and do not insert.
- **WHY**: Audit showed gpt-4o-mini producing comments like "extracts relevant metrics for consistent report generation" and "Adds section header for clarity" — they narrate what the code does rather than explaining design intent, add no value, and violate the prompt's "self-explanatory → SKIP" rule. Post-filtering treats obvious restatements as SKIP so we don't insert noise.

**Heuristic dedup: same method + same caller file**
- In `tools/prr/workflow/issue-analysis.ts`, added `callerFileFromBody(body)` to extract a caller/referenced file from comment text (e.g. "runner.py:146", "in runner.py", "callers in X"). Heuristic dedup now merges two comments on the same file when they share the same primary symbol and the same caller file, even when authors differ.
- **WHY**: Prompts.log audit showed dedup returning NONE for four comments on the same file; comments from different authors (cursor vs claude) described the same async/caller mismatch (generate_report + runner.py) but were not grouped, so duplicate issues reached the fix prompt and wasted attempts. Same symbol + same caller file is a strong signal for "same issue".

**Multi-file nudge in fix prompt**
- In `tools/prr/analyzer/prompt-builder.ts`, when TARGET FILE(S) has more than one file and the review body mentions callers (e.g. "calls", "caller", "await", "file:line"), we add a line: "This issue requires changes in **all** listed files — update the implementation and every call site (e.g. `await` / method calls) so signatures match."
- **WHY**: Audit showed the fixer updated only reporting.py while runner.py was in TARGET FILE(S); the verifier then correctly rejected because print_results still called generate_report() without await/args. Explicitly nudging to update all listed files and call sites reduces incomplete multi-file fixes.

**Verifier model floor for API/signature-related fixes**
- In `tools/prr/workflow/fix-verification.ts`, added `commentMentionsApiOrSignature(fix)` (true when the comment mentions async/await, signature/TypeError/caller, method accepts/takes, or file:line call pattern). The verify batch is split into `fixesApiSignature` and `fixesDefaultRest`; when a stronger verifier model is available, API/signature fixes are verified with that model instead of the default.
- **WHY**: Prompts.log audit showed the default verifier (qwen-3-14b) approved a fix that made generate_report async and added a required argument, but missed that print_results still called it without await or args — a call-site bug. Weak verifiers are more likely to miss call-site mismatches; using a stronger model for API/signature-related fixes improves verification accuracy and reduces "fixed then broken at call site" outcomes.

### Fixed (2026-03) — CLAUDE.md / sync targets: do not delete repo-owned files

**Sync target existence recorded and re-checked after clone**
- `setWorkdir` in `tools/prr/state/lessons-context.ts` now calls `Detect.autoDetectSyncTargets(ctx)` from `lessons-detect.ts` instead of a local helper that only updated `syncTargets`. The shared detector sets **both** `syncTargets` and `originalSyncTargetState` (which files existed at detection time).
- **WHY**: The local helper never set `originalSyncTargetState`, so the map stayed empty. Final cleanup uses `didSyncTargetExist(ctx, 'claude-md')` to decide whether to remove CLAUDE.md; with an empty map it always returned false, so we always assumed PRR had "created" it and deleted it at end of run — nuking the repo's actual CLAUDE.md when the user never ran `--clean-claude-md`.

- After clone/update in `tools/prr/workflow/run-setup-phase.ts`, we call `LessonsAPI.Detect.autoDetectSyncTargets(lessonsContext)` again so "existed at start" reflects the **post-checkout** workdir, not the pre-clone state.
- **WHY**: On first run the workdir is created empty, then we set workdir and detect — no CLAUDE.md yet. Clone runs later and checks out the repo (which may include CLAUDE.md). Without re-detection we would still have "claude-md didn't exist" and would delete it at final cleanup. Re-running detection after clone ensures we only treat files as "created by prr" when they were absent after checkout.

### Fixed (2026-03) — Output.log audit: allowed paths, CodeRabbit meta, (PR comment) dismissal

**Runner allowed paths aligned with prompt-builder expansion**
- In `tools/prr/workflow/execute-fix-iteration.ts`, `allowedPathsForBatch` now includes the same extra paths the prompt-builder uses: migration journal (`getMigrationJournalPath`), consolidate-duplicate target (`getConsolidateDuplicateTargetPath`), and test-impl path (`getImplPathForTestFileIssue`). The runner no longer blocks edits that the fix prompt explicitly asked for.
- **WHY**: The prompt told the fixer to edit e.g. `db/migrations/meta/_journal.json` for Drizzle migration issues, but the runner's allow-list was built only from `issue.allowedPaths` / `issue.comment.path`, so every journal edit was rejected as "disallowed file" and the fix never applied.

**CodeRabbit "Actions performed" and auto-reply filtered out**
- `isCodeRabbitMetaComment` in `tools/prr/github/api.ts` now also matches `<!-- This is an auto-generated reply` and `✅ Actions performed` (short comments). The same filter is applied to **issue comments** (the "other comments" path in `getReviewBotIssueComments`) so CodeRabbit's confirmation blurb is not added as a fixable issue.
- **WHY**: That blurb is not a code review; sending it to the fix loop wasted 4+ iterations across models and produced only RESULT: UNCLEAR / WRONG_LOCATION.

**(PR comment) synthetic path dismissed in solvability**
- In `tools/prr/workflow/helpers/solvability.ts`, issues whose path is the synthetic `(PR comment)` (from `inferPathLineFromBody` when no file path is found) are now dismissed as `not-an-issue` before any LLM call.
- **WHY**: The fixer cannot edit a non-file; every attempt fails and burns iterations. Dismissing up front avoids wasted fix/verify cycles.

### Added (2026-03) — Git fetch: timeout, stdout on timeout, GitHub token auth

**Fetch timeout and captured output on timeout**
- Conflict check and remote-ahead check now run `git fetch` via `spawn` (in `shared/git/git-conflicts.ts`) with a 60s timeout instead of using simple-git's fetch (which could hang indefinitely). On timeout the process is killed and the error message includes any stdout/stderr captured so far.
- **WHY**: Users reported the "Checking for conflicts with remote..." step sticking with no output. Fetch can hang on network issues, SSH prompts, or credential prompts. A timeout prevents infinite wait; including git's stdout/stderr in the error (e.g. "Password for 'https://...':") makes it obvious that credentials were the cause so the token fix can be applied.

**GitHub token for fetch and pull**
- `fetchOriginBranch(git, branch, options?)` accepts optional `FetchOptions.githubToken`. When the remote `origin` URL is HTTPS and has no embedded credentials, we use a one-shot auth URL (`https://${token}@...`) for the fetch (same pattern as push in `git-push.ts`). Fetch uses the refspec `refs/heads/<branch>:refs/remotes/origin/<branch>` so `git status()` still sees updated `origin/branch`.
- **WHY**: Repos cloned without a token in the URL (or with SSH that isn't configured) cause git to prompt for a password during fetch; in headless/prr runs there is no TTY so the process hangs. We already have `GITHUB_TOKEN` in config for push; using it for fetch and pull avoids the prompt and unblocks setup and fix-loop sync.
- `pullLatest` now takes optional `FetchOptions` and uses `fetchOriginBranch` for its internal fetch so pull also benefits from token auth.
- **WHY**: After "branch is behind remote" we pull; that pull's fetch would otherwise prompt for password again. Reusing the same fetch path keeps behavior consistent.
- Token is passed from setup (`checkAndSyncWithRemote(..., config.githubToken)`), from the fix-loop pre-iteration check (`checkAndPullRemoteCommits(..., githubToken)`), and from the pull path inside `checkAndSyncWithRemote` when behind. Credentials in URLs are redacted before any log/error output.
- **WHY**: Token is never written to `.git/config` (one-shot URL only), so SIGKILL or crash doesn't leave secrets on disk; redaction prevents credential leakage in logs.

### Fixed (2026-02) — Prompts.log audit: verifier before snippet, model rec skip, no-op skip verify, escalation delay, predict-bots skip

**Verifier prompt: add "Code before fix" snippet**
- In `buildBatchVerifyPrompt` (`src/llm/client.ts`), the verifier now sees a "Code before fix" section derived from the unified diff (removed lines, i.e. the `-` side) in addition to "Current Code (AFTER)" and the diff. New helper `extractBeforeFromUnifiedDiff(diff, maxChars)` strips `-`-prefixed lines (excluding `---` headers) and truncates to the same cap as current code.
- **WHY**: The verifier previously only saw the code *after* the fix attempt. With a before snippet it can compare before vs after and judge whether the issue was actually fixed instead of pattern-matching on the current code alone; this reduces false rejections when the fix was correct (audit: one duplicated `if` took 17 fix iterations because the verifier rejected the first correct fix).

**Skip model recommendation when fewer than 3 unresolved issues**
- In `runBatchAnalysis` (`src/workflow/issue-analysis.ts`), the separate model-recommendation LLM call runs only when `unresolvedCount >= 3` (count of issues with `exists: true`). For 1–2 issues we skip the call and use the default rotation order.
- **WHY**: Saves ~29s and tokens on simple runs; for 1–2 issues the default rotation is sufficient and the recommendation adds little value.

**Treat all-no-op changes as "no changes" and skip verification**
- In `applyFileChanges` (`src/runners/llm-api.ts`) we now track `noOpSkips` (when search and replace are identical). The return type is `{ filesWritten: string[]; noMeaningfulChanges?: boolean }` with `noMeaningfulChanges` true only when `attemptedChanges > 0`, `noOpSkips === attemptedChanges`, and `filesWritten.length === 0`. The runner returns `noMeaningfulChanges: true` in `RunnerResult` in that case. In `executeFixIteration` (`src/workflow/execute-fix-iteration.ts`), when `result.noMeaningfulChanges` we skip `handleNoChangesWithVerification` and go straight to rotation (no verification LLM call).
- **WHY**: When every applied change was a no-op (e.g. fixer output identical search/replace), treating the iteration as "no changes" and skipping verification avoids running the verifier on unchanged code and avoids counting as "file modified"; saves latency and keeps behavior consistent with actual git state.

**Delay full-file rewrite escalation for simple issues**
- `getEscalatedFiles` (`src/runners/llm-api.ts`) now accepts optional `unresolvedIssues` (minimal shape in `RunnerOptions` to avoid circular deps). For each file we compute whether all issues targeting it have triage with `importance <= 3` and `ease <= 2`. For such "simple" files we only escalate when the file was not injected (not when over S/R failure threshold). `executeFixIteration` passes `unresolvedIssues` into `runner.run` options.
- **WHY**: Don't escalate to full-file rewrite as quickly for low-importance, low-difficulty issues; rely on search/replace with more context or a different strategy first. Full-file rewrites are expensive and time out more often; delaying for simple issues reduces wasted time (audit: escalation was triggered after 2 S/R failures even for trivial nits).

**Skip predicted-bot-feedback LLM call when `--no-wait-bot`**
- In `handleCommitAndPush` (`src/workflow/commit-and-push-loop.ts`), the LLM-based "likely new bot feedback" prediction (`predictBotFeedback`) is now gated with `!options.noWaitBot`. When `--no-wait-bot` is set we skip this call; heuristic prediction still runs.
- **WHY**: The prediction runs after commit and is display-only; when the user has opted out of waiting for bot reviews, skipping the prediction saves ~26s and tokens with no impact on behavior.

### Fixed (2026-02) — Output.log audit: stronger verifier escalation, skip full-file after timeout

**Stronger verifier after previous rejections**
- New constant `VERIFIER_ESCALATION_THRESHOLD = 1`. When any issue in the verify batch has been rejected by the verifier at least once (`verifierRejectionCount >= 1`), the next verification uses the current fixer model (via `batchVerifyFixes(..., { model })`) instead of the default cheap verifier model. `verifyFixes` accepts optional `getCurrentModel` and passes it through from the push-iteration loop.
- **WHY**: Output.log audit showed the default verifier (e.g. qwen-3-14b) repeatedly said "not fixed" while fixers had applied valid changes across 12 iterations; one verification with a stronger model can break the stalemate before we dismiss as exhausted.

**Skip full-file rewrite for model after 504/timeout on full-file**
- In `LLMAPIRunner` (`src/runners/llm-api.ts`), a new set `modelsTimedOutOnFullFileRewrite` tracks models that timed out on a full-file rewrite request. When building the fix prompt, if the current model is in the set, we skip escalation to full-file rewrite for that request (use search/replace only). When a 504/timeout occurs and the request was a full-file rewrite, we add the current model to the set. The set is cleared in `resetFailureTracking()`.
- **WHY**: Audit showed gpt-4o-mini timed out twice (~19 min total) on 42k-char full-file requests; skipping full-file for that model on subsequent attempts avoids repeated 504s and uses S/R or other models instead.

### Fixed (2026-02) — Rebase detection, push retry cleanup, dead code removal

**completeMerge rebase vs merge detection**
- `completeMerge` in `src/git/git-merge.ts` now uses `git.revparse(['--show-toplevel'])` to resolve the repo root, then checks `join(root, '.git', 'rebase-merge')` (and `rebase-apply`) to decide whether we're in a rebase or a merge. On rebase it runs `git.rebase(['--continue'])`; on merge it runs `git.commit(message)`.
- **WHY**: `revparse --git-dir` can return a relative path (e.g. `.git`). `existsSync(join('.git', 'rebase-merge'))` is evaluated relative to `process.cwd()`, not the workdir PRR uses (e.g. `~/.prr/work/<hash>`). So the check often failed to find `rebase-merge`, we fell through to the merge branch, and ran `git.commit()` during a rebase — leaving `.git/rebase-merge` behind and causing "rebase-merge directory already exists" on the next push retry.

**Same fix in pull conflict loop**
- The inline rebase check in `src/workflow/repository.ts` (pull conflict round loop, when `conflictedFiles.length === 0`) now uses `--show-toplevel` for the same reason.
- **WHY**: Consistency with `completeMerge`; without it the "no conflicts, is rebase still in progress?" decision could be wrong when cwd ≠ workdir.

**Push retry: clean up after failed rebase**
- In `pushWithRetry` (`src/git/git-push.ts`), when the post-rejection fetch+rebase fails (conflict or any other error, including "rebase-merge directory already exists"), we first try `git.rebase(['--abort'])`. Only if that fails (e.g. stale or corrupted rebase state) do we call `cleanupGitState(git)`.
- **WHY**: `rebase --abort` restores the repo to pre-rebase state with all commits intact. `cleanupGitState` does `reset --hard` and `clean -fd`, which is correct for stuck state but unnecessarily destructive when a simple abort would suffice. Trying abort first keeps user commits; falling back to full cleanup ensures the next run isn't blocked by a leftover `.git/rebase-merge` dir.

**Dead code removal**
- Removed `src/git/clone.ts` (599 lines). It was never imported; `git-clone-index` re-exports from `git-clone-core`, `git-merge`, and `git-lock-files` only. The file contained a duplicate `completeMerge` that only did `git.commit()` (no rebase detection).
- **WHY**: Single source of truth for clone/merge logic; no confusion from a second, weaker `completeMerge` implementation.

**rebase --continue without a TTY**
- All `rebase --continue` calls go through `continueRebase(git)` in `git-merge.ts`: it sets `GIT_EDITOR=true` then runs `git.rebase(['--continue'])`, so git does not invoke an interactive editor for the replayed commit message.
- **WHY**: In non-interactive environments (prr workdir, CI) there is no TTY. Git runs the configured editor (e.g. nano); it then fails with "Standard input is not a terminal" or "There was a problem with the editor 'editor'. Please supply the message using -m or -F". `GIT_EDITOR=true` makes git accept the default message without spawning an editor. Using a single helper keeps behavior consistent and avoids maintaining four call sites.

**Conflict resolution fallback: same model as attempt 1, more 504 retries**
- When the direct LLM API fallback (attempt 2) resolves remaining conflicts, it now uses the same model as attempt 1 (`getCurrentModel()`), passed through `resolveConflict`, `resolveConflictsChunked`, and `resolveAsymmetricConflict`. Previously the fallback used the LLM client default (e.g. qwen-3-14b), which could 504 while the runner had just succeeded with claude-sonnet-4-5.
- ElizaCloud 504/timeout retries increased from 1 to 2 (3 attempts total), with staggered backoff 10s then 20s so the gateway has more time to recover before the next attempt.
- **WHY**: Output.log audit showed attempt 1 resolved CHANGELOG with claude-sonnet-4-5; attempt 2 sent types.ts to qwen-3-14b and got two 504s. Using the same model avoids weak/default models that may be overloaded; extra retries with longer backoff improve success when the gateway is transiently failing.

**Conflict resolution: model fallback and context cap**
- When `getCurrentModel()` is undefined (e.g. during setup before rotation is initialized), Attempt 2 now falls back to `DEFAULT_ELIZACLOUD_MODEL` (e.g. claude-sonnet-4-5) for ElizaCloud so the fallback doesn’t use the client default (qwen-3-14b) that may 504.
- The "file too large for model context" check now uses the effective model’s context limit (`effectiveMaxChars` from `getMaxFixPromptCharsForModel(provider, effectiveModel)`) instead of the LLM client’s default model limit.
- **WHY**: Audit showed attempt 2 using qwen-3-14b when rotation state was unset; falling back to a stronger default improves success. Using the effective model’s limit prevents incorrectly skipping files that fit the actual model’s context window.

**commit.ts pushWithRetry: same abort-then-cleanup as git-push**
- In `src/git/commit.ts`, when the post-rejection rebase fails (conflicts or other error), we try `git.rebase(['--abort'])` first; only if that fails do we call `cleanupGitState(git)`.
- **WHY**: Same rationale as git-push: abort preserves commits; full cleanup is for stuck/corrupt state. Consistency between the two push-retry paths avoids divergent behavior.

### Fixed (2026-02) — Prompts.log audit: conflict prompt injection and large-file embedding

**Skip file injection for conflict resolution prompts**
- In `injectFileContents` (`src/runners/llm-api.ts`), if the prompt starts with `MERGE CONFLICT RESOLUTION`, we return the prompt unchanged with no file injection.
- **WHY**: The conflict resolution prompt builder (`buildConflictResolutionPromptWithContent`) already embeds each file as `--- FILE: path ---` plus content. Re-injecting would duplicate file content (e.g. CHANGELOG twice under "ACTUAL FILE CONTENTS"), blow prompt size (e.g. 140k+ chars), and cause 504s or context-overflow errors.

**Large conflicted files: chunked embed**
- For files over 30k characters with conflict markers, `buildConflictResolutionPromptWithContent` (`src/git/git-conflict-prompts.ts`) now embeds only the conflict sections (each with 7 lines of context before/after) instead of the full file. Section headers show the actual embedded line range (from context start to context end). Instructions tell the LLM to use the plain file path in `<change path="...">` (e.g. `CHANGELOG.md`), not the section annotation.
- **WHY**: Embedding the full file (e.g. CHANGELOG 600+ lines) doubles prompt size and causes 504s; the LLM only needs the conflicted regions to produce correct `<search>`/`<replace>` blocks. Accurate line numbers and path instruction ensure the LLM’s output matches the file and applies cleanly.

### Fixed (2026-02) — Output.log audit: conflict escalation skip, wrong-file exhaust

**Skip full-file rewrite escalation for conflict resolution prompts**
- `getEscalatedFiles` in `src/runners/llm-api.ts` now returns no files when the prompt starts with `MERGE CONFLICT RESOLUTION`.
- **WHY**: The conflict prompt builder already embeds file content (or chunked sections). Escalating to full-file rewrite duplicated content and caused ~10 min of 180s timeouts on CHANGELOG.md in round 1 before falling back to deterministic merge; skipping escalation avoids that waste.

**Auto-exhaust after repeated "wrong file" lessons**
- New state field `wrongFileLessonCountByCommentId` and constant `WRONG_FILE_EXHAUST_THRESHOLD = 2`. When the fixer modifies the wrong files (e.g. fix belongs in `commit.ts` but comment is on `git-push.ts`), we add a lesson and increment the count; when the count reaches 2, `assessSolvability` dismisses the issue as exhausted.
- **WHY**: Cross-file fixes burn through all models with no progress; exhausting after 2 wrong-file lessons defers to human and saves ~5 min of LLM calls (audit: git-push.ts:42 took 14 iterations across 4 models).

### Fixed (2026-02) — Prompts.log audit follow-up: relax file constraint, dismissal skip, judge rule, model recommendation

**Relax file constraint when fixer says fix is in another file**
- New state field `wrongFileAllowedPathsByCommentId`. When the fixer returns CANNOT_FIX or WRONG_LOCATION and the result detail mentions another file path (e.g. "fix is in commit.ts"), we parse and persist that path. On the next fix attempt we merge it into the issue's `allowedPaths` so the fixer is permitted to edit the correct file. Shared `parseOtherFileFromResultDetail(detail, currentPath, workdir)` in `src/workflow/utils.ts`; used in no-changes verification (persist on no-changes) and in `execute-fix-iteration.ts` (merge into issues before building the prompt). Caller passes optional `workdir` into `handleNoChangesWithVerification` so persistence runs when available.
- **WHY**: Prompts.log audit showed 7 identical ~33k-char prompts for one issue (comment on git-push.ts, fix in commit.ts). The fixer correctly refused to edit the wrong file but we kept retrying the same file; persisting the other file and allowing it on retry gives the next attempt a chance to succeed and avoids burning all models.

**Skip dismissal LLM for all already-fixed issues**
- In `addDismissalComments` (`src/workflow/dismissal-comments.ts`), we no longer call the LLM to generate a "Note:" comment for issues with category `already-fixed`. We skip the call entirely and do not add an inline comment (code/diff is self-documenting).
- **WHY**: Audit showed 62% of dismissal LLM responses were EXISTING (issue already reflected in code). For already-fixed, the LLM would only echo that; skipping saves tokens and latency with no loss of information.

**Judge rule: NO when Current Code already implements the suggestion**
- Batch verification system prompt in `src/llm/client.ts` now includes: "If the Current Code already implements what the review asks for, respond NO and cite the specific code that resolves it (reduces ALREADY_FIXED fix attempts)."
- **WHY**: Without this, the judge sometimes said YES (issue still exists) when the code already addressed the comment, triggering unnecessary fixer attempts. Explicitly instructing NO with citation reduces ALREADY_FIXED cycles and improves verification accuracy.

**Model recommendation prompt: avoid echoing "brief reasoning"**
- User and system prompts for the model recommendation call now ask for "explain why these models in this order" instead of "brief reasoning".
- **WHY**: Models tended to literally echo "brief reasoning" in the response; asking for an explanation in this order yields actionable text and avoids placeholder output.

### Fixed (2026-02) — Security, worktree, conflict-resolve, commit cleanup

**Credential redaction in push and rebase logs**
- In `src/git/git-push.ts`, a module-level `redactUrlCredentials(text)` strips `https://...@` to `https://***@` before any debug or error logging. All catch blocks and rebase-failure debug calls (push remote-URL check, stdout/stderr, "Rebase failed", "Rebase continue failed", "onConflict handler failed") now log only the redacted string.
- **WHY**: Git errors and stderr can contain the remote URL with embedded tokens; logging raw errors would leak credentials. Redacting before log keeps behavior unchanged while avoiding credential exposure.

**Worktree-safe rebase detection (shared helper)**
- New exported `getResolvedGitDir(git)` in `src/git/git-merge.ts` resolves the real git directory when `.git` is a file (worktree: `gitdir: <path>`). `completeMerge` and the pull conflict loop in `src/workflow/repository.ts` use it for the `rebase-merge` / `rebase-apply` check.
- **WHY**: In worktrees, `join(root, '.git')` is a file; `existsSync(join(gitDir, 'rebase-merge'))` would fail. Reading the `gitdir:` target and resolving the path makes rebase detection correct in both normal repos and worktrees. One helper avoids duplication and keeps behavior consistent.

**Sync target removal log only on success**
- In `cleanupSyncTargetFiles` (`src/git/git-conflict-resolve.ts`), the message "Removed sync target created by prr: …" is printed only when either `git.rm(file)` or the fallback `git.add(file)` succeeds. If both fail, the log is suppressed and the outer catch still runs.
- **WHY**: Previously the log ran unconditionally after a try/catch that swallowed failures, so we could report removal when neither operation succeeded. Logging only on confirmed success avoids misleading output.

**commit.ts duplicate push removal**
- Removed ~293 lines of broken duplicate code from `src/git/commit.ts`: orphan `PushResult`-style body, mangled `push` signature, and full duplicate implementations of `push` and `pushWithRetry`. The file now re-exports `PushResult`, `push`, `pushWithRetry`, and `PushWithRetryResult` from `./git-push.js` and dropped unused imports (`spawn`, `execFileSync`, `buildCommitMessage`, `continueRebase`, `cleanupGitState`).
- **WHY**: A prior automated edit had left invalid syntax and two copies of push logic; the canonical implementation lives in git-push.ts and is re-exported via git-commit-index. Removing the duplicate fixes parse errors and keeps a single source of truth.

**Dead code: isReasonCodeChange removed**
- Removed unused `REASON_CODE_CHANGE` regex and `isReasonCodeChange` from `src/workflow/dismissal-comments.ts` (dismissal skip for already-fixed no longer uses them).
- **WHY**: After skipping the dismissal LLM for all already-fixed issues, the helper was never called; removing it avoids dead code and confusion.

---

### Added (2026-02) — Analysis cache, line remap, prompt caps, model recommendation, graduation

**Dedup cache across push iterations**
- Cache key is now the full comment ID set (all comments from the API), not just the current `toCheck`. On cache hit, persisted `duplicateMap` is filtered to the current `toCheck`: for each group we pick a representative (canonical if still in toCheck, else first duplicate in toCheck) and build canonical → [dupes] for that subset.
- **WHY**: Keying by `toCheck` caused cache misses on push iteration 2+ when some issues were already resolved (toCheck shrank but comment set unchanged). Re-running LLM dedup burned ~200k chars. Keying by full set and filtering on hit reuses grouping across iterations.

**Line re-mapping after push**
- `computeLineMapFromDiff(git, baseRef, headRef)` parses `git diff base..HEAD` and returns path → (oldLine → newLine) for context lines. Review comment line numbers are remapped before fetching code snippets so the fixer sees the correct post-push lines.
- Base ref uses `origin/<baseBranch>` so the diff works in worktree/CI clones where the local base branch may not exist.
- Diff path is taken from the `b/` side of the header so renamed files (e.g. `a/old b/new`) map under the name comments use.
- **WHY**: After push, comment line refs can point at pre-push locations; code may have shifted. Remapping reduces WRONG_LOCATION and improves snippet accuracy.

**Mega-fix prompt size cap**
- `MAX_ENRICHED_FIX_PROMPT_CHARS = 500_000` caps the total enriched prompt (base + injected file content). `REWRITE_ESCALATION_RESERVE_CHARS = 2_000` is reserved so the rewrite-escalation block appended after injection doesn't push the total over the cap.
- **WHY**: Audit showed single 500k+ prompts caused gateway 500s and waste. Capping prevents mega-prompts; reserving 2k for escalation avoids throwing on borderline sizes when escalation is appended.

**Separate model recommendation call**
- Model recommendation is no longer baked into the first verification batch. After all verification batches complete, a single `getModelRecommendationOnly(summary, modelContext)` call runs (with one retry on transient errors) and the result is merged into the batch result.
- **WHY**: Including the recommendation block in the first batch added ~60k chars per run; verification doesn't need it. A separate short call after verification saves tokens and still provides model ordering for the fix loop.

**Issue graduation**
- Unresolved issues are sorted by attempt count (descending) before the fix loop so high-attempt issues are processed first. Cache is not mutated (sort runs on a copy).
- **WHY**: Issues that have failed many times deserve earlier attention (e.g. batched first or future single-issue path). Sorting is a low-cost way to prioritize without changing behavior.

**Analysis cache wired through**
- `lastAnalysisCacheRef` is now passed from the push iteration loop to `processCommentsAndPrepareFixLoop`. When comment count and `headSha` are unchanged, analysis is reused (unresolved issues and duplicate map from cache) instead of re-running `findUnresolvedIssues`.
- **WHY**: The ref was created and invalidated but never passed to the only consumer. Wiring it enables the documented "reuse cached analysis" behavior and saves ~1–4 min of LLM analysis per iteration when the cache hits.

**Type unification**
- Single `FindUnresolvedIssuesOptions` type from `issue-analysis.ts` is used everywhere; removed duplicate `FindUnresolvedIssuesCallbackOptions`. Callback type accepts optional third argument `options?: FindUnresolvedIssuesOptions` in `main-loop-setup` and `run-orchestrator`.
- **WHY**: Two identical shapes caused drift risk and type mismatches at the call site when passing `lineMap`.

---

### Added (2026-02) — Output.log audit: model rotation, injection, rewrite escalation, batch sizing, 504 retries, AAR

**Model rotation reorder (llm-api / elizacloud)**
- Default model lists in `src/runners/types.ts` are ordered by observed fix success (Claude first, then GPT). Models that 500/timeout or have 0% fix rate are in `ELIZACLOUD_SKIP_MODELS` in `src/models/rotation.ts` and are never selected (e.g. `gpt-4.1`, `claude-sonnet-4.5`, `gpt-5.1-codex-max`, `claude-3-opus`). `gpt-5.2-codex` was removed from the elizacloud rotation list so it is not selected then immediately skipped.
- **WHY**: Audit showed some models at 0% success or repeated 500/timeouts still consumed rotation slots. Leading with best performers and skipping known-bad models reduces wasted calls and improves fix throughput.

**File injection: priority by issue count and dynamic budget**
- `injectFileContents` in `src/runners/llm-api.ts` now injects files in order of how many issues reference them (most first), so the injection cap is used for files most likely to need search/replace. Total injection budget is derived from the model’s context cap (`baseCap * 2.5`) instead of a fixed 200k; caller passes `maxTotalEnrichedChars` so large-context models get more injection headroom.
- **WHY**: Injecting files with the most issues first improves search/replace success when the cap is tight. A fixed 200k budget ignored model limits; tying budget to the model’s cap avoids overshooting on small-context models and underusing on large ones.

**Rewrite escalation for non-injected files**
- `getEscalatedFiles` now escalates (1) files with repeated S/R failures (existing), and (2) files mentioned in the prompt but not injected (LLM never saw file content — S/R would likely fail). Escalation reason text distinguishes “search/replace has failed N times” vs “file content was not in prompt — use full file output”. Escalation scans the **original** prompt only, not the enriched prompt, to avoid false positives from injected content.
- **WHY**: When the injection cap is exhausted, some files are never injected; asking for full-file output for those avoids search/replace matching failures. Scanning the original prompt keeps escalation tied to issue references, not injected file text.

**Duplicate prompt detection (issue IDs + lesson count)**
- The “same prompt+model” hash in `src/workflow/execute-fix-iteration.ts` now uses `runner:model:sortedIssueIds:lessonsBeforeFix` instead of the full prompt string. When the hash matches the previous iteration, we skip the fixer and go straight to rotation.
- **WHY**: Full-prompt hashes rarely matched (wording/formatting drift). Hashing issue IDs and lesson count detects “same issues, same context” even when prompt text differs slightly, so we avoid redundant LLM calls and rotate sooner.

**Proportional batch size reduction**
- In `src/workflow/prompt-building.ts`, when the prompt exceeds the cap, batch size is reduced with `floor(currentMax * effectiveCap / promptLength)` (with a minimum of 1 and at least one issue fewer) instead of halving. Converges in one or two iterations instead of many (e.g. 50→25→12→6).
- **WHY**: Halving wasted iterations when the prompt was only slightly over cap. Proportional reduction gets under the cap faster and keeps batch size as large as the context allows.

**504/gateway timeout: two retries with backoff**
- `MAX_504_RETRIES` increased from 1 to 2; `BACKOFF_MS` is `[10_000, 20_000]` so the first retry waits 10s and the second 20s.
- **WHY**: Single retry was often insufficient for transient gateway issues; two retries with staggered backoff give the gateway time to recover without excessive delay.

**Exhausted issues listed in After-Action Report**
- The “Dismissed” section in `src/ui/reporter.ts` now explicitly lists all issues with category `exhausted`, showing `path:line` for each, so operators know exactly which issues need human follow-up.
- **WHY**: Exhausted issues (verifier rejected fix/ALREADY_FIXED twice) were only summarized by count; listing them makes follow-up actionable without digging through state.

**Documentation**
- `docs/MODELS.md` documents rotation order and skip list (where to add models that 500/timeout or have 0% fix rate) and notes that per-run performance is not yet persisted across PRs.

---

### Added (2026-02) — Prompts.log audit: persisted dedup cache, Note prefix, wider snippets, rotation by success

**Persisted LLM dedup cache**
- Dedup results (comment ID set → duplicateMap, dedupedIds) are now stored in `state.dedupCache` and survive across runs. When the same set of comment IDs is seen again (e.g. re-run or next push iteration), the LLM dedup step is skipped and the cached grouping is reused.
- **WHY**: Audit showed all dedup LLM calls returned NONE because the cache was in-memory only and reset each run. Persisting keyed by sorted comment IDs saves tokens and latency on repeat runs with unchanged comment set.

**"Note:" prefix for dismissal and NEEDS_DISCUSSION comments**
- Inline comments for dismissed issues and for fixer NEEDS_DISCUSSION outcomes now use the **"Note:"** prefix instead of "Review:". Prompt, response parsing, and fixer instructions were updated in `src/llm/client.ts`, `src/workflow/dismissal-comments.ts`, `src/analyzer/prompt-builder.ts`, and `src/workflow/utils.ts`. The pre-check recognizes both "Note:" and "Review:" (legacy) so existing comments are not duplicated.
- **WHY**: CodeRabbit and similar bots flag "Review:" as review artifacts and create feedback loops. "Note:" reads as a neutral developer comment and avoids that.

**Pre-check for existing Note:/Review: before dismissal LLM**
- Before calling the LLM to generate a dismissal comment, we check a ±7 line window for an existing comment containing "Note:" or "Review:". If found, the LLM is not called.
- **WHY**: Audit showed many dismissal calls returning EXISTING/SKIP; the pre-check reduces redundant LLM calls when a comment was already added.

**Wider snippets for batch issue analysis**
- When `effectiveMaxContextChars >= 100_000`, batch verification uses 2500 chars for comment and 3000 for code per issue (up from 2000/2000). Smaller context providers keep 2000/2000.
- **WHY**: Truncated snippets led to conservative "say YES" and false positives. More context when headroom exists improves accuracy without blowing context limits.

**Model rotation sorted by success rate**
- When using legacy rotation (or after exhausting LLM recommendations), the model list is sorted by per-model success rate so better-performing models are tried first. Requires `stateContext` on the rotation context (set by the resolver).
- **WHY**: Audit showed some models at ~1% success still cycled early. Using persisted `modelPerformance` to order the list tries proven models first and deprioritizes chronic low performers.

---

### Added (2026-02) — Fix loop default, empty snippets, grouping rule, dead code cleanup

**maxFixIterations 0 = unlimited**
- CLI documents `--max-fix-iterations` default as `0` meaning "unlimited", but the loop used the raw value so `0` meant zero iterations and the fix loop never ran.
- We now map `0` and `null`/`undefined` to `Infinity` in the fix loop (`effectiveMaxFixIterations`). Loop condition and "max iterations reached" message use this effective value.
- **WHY**: Audit of a run showed `maxFixIterations: 0` and "Fix loop exit: max_iterations" with zero fix attempts. Default 0 should mean "run until done," not "run zero times."

**Empty / missing code snippets in verification prompts**
- **Judge (batch "do issues still exist")**: When `codeSnippet` is empty or whitespace, the prompt no longer shows an empty code block. It shows an explicit placeholder instructing the model not to respond STALE and to prefer YES with explanation when code is not visible.
- **Fix-verification (post-fix batch)**: When `currentCode` is empty or whitespace-only we treat it as missing and emit "Current Code: (unavailable — verify from diff only)" instead of an empty ``` block.
- **WHY**: Audit of prompts.log found issues (e.g. issue_8, issue_12) with empty "Current code:" blocks; the verifier had no context and guessed. Explicit placeholder/text avoids false STALE and makes "unavailable" visible so the model doesn't invent conclusions.

**Comment-deduplication grouping rule**
- Grouping prompt now includes: "Same method/symbol but DIFFERENT fix = do NOT group" with an example (e.g. "Method X doesn't exist" vs "Method X called with wrong cast").
- **WHY**: Audit found a bad merge: two comments about the same method required different fixes (add method vs change call site). Wrong merges cause one fix attempt to address both or lose nuance; the new rule reduces false groupings.

**Dead code in commit-and-push-loop**
- Removed the `maxPushIterations === 0` branch from the bot-wait condition. By the time this runs, `maxPushIterations` is already normalized to `Infinity` when 0, so the branch was never true.
- **WHY**: Cleanup; condition is now `pushIteration < maxPushIterations` only. Behavior unchanged (unlimited case still waits when appropriate).

**Verification model note**
- In-code comment above batch verify loop: verification accuracy affects fix-loop decisions; if many false YES/NO occur, use a stronger model (e.g. via tool config).
- **WHY**: Audit showed ~30% verifier errors with a small model; documenting the lever helps operators tune without code changes.

---

### Added (2026-02) — Audit improvements: token savings, verifier rejection, exit logic, polish

**Think-tag stripping and suppression (OpenAI/ElizaCloud path)**
- Models like Qwen emit `<think>…</think>` reasoning blocks that waste ~30% of output tokens and can break response parsing (e.g. `content.startsWith('YES')` fails when content starts with `<think>`).
- **Strip on response**: In `completeOpenAI()`, response content is post-processed to remove `<think>…</think>` blocks (case-insensitive; unclosed `<think>` to end of string is also stripped). Ensures downstream parsers see only the actual answer.
- **Suppress at source**: When the chosen model name contains "qwen", a system-prompt suffix is added: "Do NOT include <think> tags or internal reasoning. Respond directly." Reduces output tokens and latency.
- **WHY**: Audit of prompts.log showed 27+ responses with 1000–2000 extra output tokens of unused reasoning; stripping and instructing avoids waste and parsing bugs.

**Verifier rejection tracking and auto-dismiss**
- New `verifierRejectionCount` on `ResolverState` (persisted in `.pr-resolver-state.json`) counts how many times the verifier rejected a fix or ALREADY_FIXED claim per comment.
- When `verifierRejectionCount[commentId] >= VERIFIER_REJECTION_DISMISS_THRESHOLD` (2), solvability Check 0e marks the issue unsolvable with `dismissCategory: 'exhausted'` so PRR stops retrying.
- **Increment sites**: (1) `fix-verification.ts` when batch verification fails for an issue; (2) `no-changes-verification.ts` when the no-changes path verifies and the verifier says the issue still exists.
- **WHY**: Fixer/verifier stalemates (fixer says ALREADY_FIXED, verifier disagrees) were retried indefinitely, burning tokens. Capping at 2 rejections per issue stops the loop and defers to human follow-up.

**Exit after two push iterations with zero verified fixes**
- Orchestrator now tracks `consecutiveZeroVerified` and compares **per-iteration progress delta** (not cumulative progress). After two consecutive push iterations with no new verified fixes, it exits with `exitReason: 'no_verified_progress'`.
- **WHY**: Previously the check used cumulative `progressThisCycle`, which never resets, so the condition never triggered. Using the delta between iterations correctly detects "this push cycle added zero verified fixes."

**Dismissal-comment pre-check radius**
- `hasExistingReviewComment()` in `dismissal-comments.ts` now uses a ±7 line radius (was 3) to match the LLM context window (`contextBefore`/`contextAfter` = 7). If a "Review:" comment already exists in that range, the LLM is not called.
- **WHY**: Audit showed 12 consecutive dismissal-comment LLM calls that all returned "EXISTING"; the smaller radius missed comments the LLM could see, wasting input tokens.

**No-op search/replace skip (llm-api runner)**
- In `applyFileChanges()`, when a `<change>` block has identical trimmed `<search>` and `<replace>` content, the change is skipped (no file I/O, no fuzzy match). Logged as "Skipping no-op change".
- **WHY**: LLMs sometimes output no-op edits (e.g. "ALREADY_FIXED" but still emit a change block with same text). Skipping avoids pointless verification and keeps `filesModified` accurate.

**Fix prompt lesson caps for large batches**
- When `issues.length > 10`, global lessons in the fix prompt are capped at 5 (not 15) and per-file inline lessons at 1 per file (not 3). Console "Lessons Learned" summary uses the same cap so the log matches what the fixer sees.
- **WHY**: Large batches (e.g. 50+ issues) with 15 lessons each produced 278k+ char prompts and gateway timeouts; smaller caps keep prompts under ~100k chars while still surfacing recent failures.

**LLM dedup only for files with 3+ issues**
- Heuristic dedup still runs for all files; the **LLM** dedup step now runs only for files that have at least 3 remaining issues after heuristic dedup (was 2).
- **WHY**: For exactly two comments on a file, heuristic grouping is sufficient; skipping the LLM call saves tokens with no meaningful loss in dedup quality.

**Commit message duplicate pattern**
- The commit message pattern for "duplicate" was changed from "remove duplicate code" to "consolidate duplicate logic" to avoid forbidden phrases that trigger fallback.
- **WHY**: Some review bots flag the phrase "remove duplicate code"; the new wording satisfies the intent without triggering filters.

**Prompts.log audit improvements**
- **CodeRabbit analysis chain stripping**: In `sanitizeCommentForPrompt()`, strip `🧩 Analysis chain` and all `🏁 Script executed:` blocks (```shell...``` plus Repository/Length of output metadata) from comment bodies before analysis and fix prompts. **WHY**: CodeRabbit embeds 5–15 shell runs per comment (~200–1500 chars each); one comment had 11 blocks (~3.5k chars). The analyzer only needs the actual finding; script output wasted ~30% of batch analysis prompt tokens.
- **Already-fixed dismissal skip**: When adding dismissal comments, skip the LLM call for `already-fixed` issues whose reason describes a code change (e.g. "now uses", "Line X now", "added validation"). **WHY**: The LLM returns EXISTING when the code is self-documenting; skipping saves ~7 calls per run and ~42s latency. Pattern was broadened to match real-world reasons ("now includes", "now reads", "is now declared", "Lines X in file now invalidate"). **WHY**: Initial regex missed 4/10 samples; full coverage avoids redundant calls.
- **maxFixIterations 0 = unlimited**: CLI documents "0 = unlimited"; the fix loop now treats `--max-fix-iterations 0` as `Infinity` so the loop runs. **WHY**: Previously 0 meant zero iterations and the run did analysis only with no fix attempts.

### Added (2026-02) — Rotation reset, full-rewrite handling, batch reduce, injection cap, no-changes parsing

**Rotation reset at push iteration start**
- When `pushIteration > 1`, the workflow resets the current runner's model index to the first model before starting the fix loop (`resetCurrentModelToFirst` in rotation.ts; wired via `resetRotationToFirstModel` from resolver → run-orchestrator → push-iteration-loop).
- **WHY**: Without this, push iteration 2 started with whatever model PI1 ended on. If that model had just 500'd or timed out, PI2 would retry it first and waste time. Resetting gives each push cycle a "best model first" attempt.

**Full-file rewrite "no diff" handling**
- Runner result includes `usedFullFileRewrite` when the fixer wrote files directly. When that path produces no git diff, the fix loop treats it as `full_rewrite_no_diff` and skips single-issue focus, going straight to rotation.
- **WHY**: Full-file rewrite can exit with no diff (same content). Retrying with single-issue or same model is unlikely to help; rotating is more useful.

**Large-prompt batch reduce (forceNextBatchSizeReduce)**
- When fix prompt length exceeds 200k chars (error or no-changes path), state sets `forceNextBatchSizeReduce = true`. Next fix iteration uses effective consecutive ≥ 2 so the prompt builder immediately uses a smaller batch.
- **WHY**: Very large prompts cause gateway 500s/timeouts. Reducing batch size on the next attempt keeps prompt size under control without burning rotation slots.

**Injection cap with floor**
- Total injected file content is capped so base + injection ≤ 200k chars, with a floor of 50k injection so we still inject key files when the base prompt is large.
- **WHY**: Fixed 200k injection allowed base + injection to exceed limits. Capping by `200k - base` keeps total under 200k; the floor avoids zero injection when base is already >200k.

**Line-number prefix stripping (search/replace only)**
- When parsing `<change>` blocks, search/replace text are normalized with `stripLineNumberPrefixes()` which removes only the injected format `N |` (e.g. `   1 | code` → `code`), not arbitrary leading digits.
- **WHY**: Injected content is line-numbered; some LLMs echo that in `<search>`/`<replace>`. Stripping only `N |` allows matches without corrupting real code (e.g. `  42` or `1: 'foo'`).

**No-changes explanation parsing (ignore XML blocks)**
- `parseNoChangesExplanation()` strips `<change>`, `<newfile>`, and `<file path="...">` block content before looking for NO_CHANGES or inferring patterns. Both stages run on prose-only text.
- **WHY**: Code/fixtures inside those blocks produced false positives (e.g. "fixer made no changes" inside a `<change>` block reported as explanation). Restricting to prose avoids that.

**Merge resolution and wiring**
- Conflict resolution combined rotation reset + batch reduce with per-model caps and AAR snapshots. `RunCallbacks` and run-orchestrator include `resetRotationToFirstModel`; verification timer uses `startTimer('Verify fixes')` (direct function).
- **WHY**: Resolved code must keep our rotation/batch behavior and their modelContext/AAR/committedThisIteration. Missing `resetRotationToFirstModel` on RunCallbacks caused a type error; `Timer.startTimer` would have been a runtime error.

---

### Added (2026-02-27) — Per-model context caps, AAR on all exits, prompt quality

**Per-model context limits (`src/llm/model-context-limits.ts`)**
- New module tracks per-model maximum input token budgets for ElizaCloud (Qwen 3 14B: 24k, GPT-4o: 128k, Claude: 200k) and exposes `getMaxFixPromptCharsForModel()` / `lowerModelMaxPromptChars()`.
- After a 504 / timeout, `lowerModelMaxPromptChars()` reduces the cap to 75% of the sent size (floor 20k chars) so the next attempt automatically uses a smaller batch without manual tuning.
- **WHY**: ElizaCloud routes requests to backends with wildly different context windows. Qwen 3 14B has a 40k total context (≈24k usable input). Sending a 200k-char prompt to it caused immediate 400 "maximum context length is 40960 tokens" or 504 gateway timeout on every attempt, burning rotation slots and wasting time. Tracking limits per model prevents this class of failure.

**Model-specific cap wired into prompt-building and the runner**
- `buildAndDisplayFixPrompt()` reads the per-model cap via `modelContext` and uses it as the hard size limit when reducing batch size in the while-loop.
- `llm-api` runner computes `MAX_ENRICHED_PROMPT_CHARS = baseCap × 2.5` using the same model-specific base instead of the global `MAX_FIX_PROMPT_CHARS`, so the fail-fast guard scales with the model.
- **WHY**: Without this, the prompt-building loop and the runner hard-cap used the global `MAX_FIX_PROMPT_CHARS` (≈200k chars, sized for Claude). For Qwen the effective cap is ~100k — the prompt would look small to the builder but still blow up the gateway.

**After Action Report on all session exits**
- `executeFinalCleanup` and `executeErrorCleanup` now call `printAfterActionReport()` whenever there are remaining issues **or** fixes this session (`verifiedThisSession.size > 0`), not only when `trulyUnresolved.length > 0`.
- `printHandoffPrompt()` still only fires when there are remaining issues (no change).
- **WHY**: On a clean "all fixed" run the AAR was silently skipped, leaving no log record of what was done. On auth/early-exit runs the AAR was also missing because the remaining list was empty at that point. Now every run with session activity produces an audit trail.

**Remaining count shown on early/auth exit**
- `finalUnresolvedIssuesRef` and `finalCommentsRef` are hoisted above the `try/catch` in `executeRun` so the `catch` block can snapshot the latest remaining issues even when an exception fires mid-iteration.
- On `shouldExit` (auth, quota) the refs are updated immediately before returning, so `executeFinalCleanup` / `executeErrorCleanup` receive the correct list.
- A pre-iteration snapshot is also written before every `executeFixIteration` call so a mid-iteration throw still produces a valid remaining list.
- **WHY**: On auth bail-out the remaining count was 0 in RESULTS SUMMARY and the AAR was empty. The refs were initialised to `[]` and only updated at normal exit paths; the early-exit path never wrote them. Hoisting + pre-iteration snapshot closes all gaps.

**Dry-run guard removed from `loopResult.shouldBreak` path**
- The early return after `processCommentsAndPrepareFixLoop` now always writes the refs, not only in `--dry-run` mode.
- **WHY**: The conditional was misleading — all other exit paths write unconditionally. On a non-dry-run with 0 comments the refs stayed at `[]`, making the AAR and remaining count wrong if cleanup ran later.

**Placeholder snippets filtered from fix prompts**
- `buildFixPrompt()` imports `SNIPPET_PLACEHOLDER` and guards the **Current Code** block: `issue.codeSnippet && issue.codeSnippet !== SNIPPET_PLACEHOLDER`.
- **WHY**: If a file was read-error / not-found, `codeSnippet` was set to `'(file not found or unreadable)'`. The old truthy check emitted that string verbatim as a code block in the prompt, sending the fixer irrelevant noise and preventing it from seeing that no code context was available.

**Snippet-presence tie-break in priority sort**
- `sortByPriority()` now uses snippet presence as a secondary sort key when the primary score (importance / ease / date) is equal.
- Issues with a valid `codeSnippet` sort before issues without one within the same priority tier.
- **WHY**: When the batch is capped by prompt-size, the builder takes the first N issues from the sorted array. Without the tie-break, snippet-less issues could displace snippet-bearing ones, reducing the number of **Current Code** blocks in the prompt and lowering fix success rates.

**Dismissal path resolution via `git ls-files`**
- `addDismissalComments()` now calls `resolveFilePath()` (git ls-files) when a file path from state doesn't exist at the exact path. Exact match → use; single suffix match → use; multiple → shortest.
- **WHY**: Bot review comments sometimes reference truncated paths (e.g. `verify/route.ts` instead of `app/api/auth/siwe/verify/route.ts`). The old code logged "File no longer exists, skipping" and silently dropped the comment. Resolution recovers the correct path and inserts the dismissal comment.

---

### Changed — Lesson normalization: flexible input, best-effort canonical form (2026-02)

**Preserve inline backticks**
- `normalizeLessonText()` no longer strips inline backticks (e.g. `execSync`, `tsc`). Only fenced code blocks (triple backticks) are removed.
- **WHY**: LLM-generated lessons often use backticks for code references. Stripping them lost useful structure and made lessons like "Use execSync with shell false" less readable. Preserving them keeps lessons durable and readable in `.prr/lessons.md` and CLAUDE.md.

**Keep normalized "made no changes" lessons**
- Standalone "tool made no changes" / "fixer made no changes" (with or without "without explanation", "trying different approach") are now returned as normalized strings instead of `null`.
- **WHY**: Previously these were rejected as "non-actionable". Callers (e.g. batch verify, no-changes handling) still produce them; rejecting lost valid lessons and broke tests that expected a canonical form. Normalizing and returning allows dedup and storage; callers can filter later if needed.

**Skip single-asterisk list lines**
- Lines that start with a single `*` (and not `**`) are skipped during line-by-line parsing.
- **WHY**: In mixed lists (e.g. "1. item one", "- bullet", "* star"), the single-asterisk line is often noise or comment-style. Keeping it added junk like "star" to the normalized text; skipping it yields "item one item two bullet plus" without spurious tokens.

### Added (2026-02) — JSON-safe review comments and dismissal cleanup

**JSON-safe review comments**
- **No comments in JSON**: Dismissal comments are never inserted into `.json` files (`NO_COMMENT_EXTENSIONS`). Fix prompts (batch and single-issue) explicitly tell the LLM never to add `//` or `#` comments to `.json` — JSON has no comment syntax and would break package managers.
- **Pre-commit safety net**: `unstageToolArtifacts()` in git-commit-core now detects staged `.json` files that contain `//`-style comment lines or invalid JSON, and reverts them before commit. Catches LLM slip-ups and accidental tool output.
- **Polish**: `lockb` added to `BINARY_EXTENSIONS`; after tool-markup detection we `continue` so the JSON block is not run for already-flagged files (avoids double work).
- **WHY**: Inserting `// Review:` into `package.json` produced invalid JSON and broke `bun install` / `npm install`. Three layers (block at source, prompt rule, commit-time revert) prevent recurrence.

**Dismissal comment cleanup**
- **Skip verified-this-session**: `addDismissalComments()` accepts optional `verifiedThisSession`. Dismissed issues whose comment ID is in that set are skipped — the fixer just resolved them, so adding a "dismissed" comment would contradict the fix and cause a re-insertion loop.
- **Developer-style "why" comments**: The dismissal-comment LLM prompt was rewritten to ask for brief design-intent comments (present tense, no diff narration). Explicit BAD/GOOD examples steer the model away from review-tool prose.
- **SKIP option**: The LLM can respond `SKIP` when the code is self-explanatory and no comment adds value. Reduces low-value comments.
- **No generic fallback**: When the LLM doesn't follow the expected format, we no longer insert a generic "Review: dismissed (see PR discussion)" — we skip. Prefers no comment over a meaningless one.
- **WHY**: Comments like "Templates were relocated, and dependency is now obsolete" read as bot output; we want durable "why" documentation. Skipping verified issues prevents the fixer-removes-comment → dismissal-re-adds-it loop.

### Fixed (2026-02-12) — Audit-driven workflow fixes

**Verification cache vs final audit**
- When the final audit re-opens issues (finds them still unfixed), PRR now calls `Verification.unmarkVerified()` for each failed-audit comment before re-entering the fix loop.
- **WHY**: Without invalidation, the next iteration’s verification step still saw those comments as “already verified” and skipped them. That produced “Changed files → []” and zero progress, so the loop never made headway and could run for 30+ minutes. Unmarking forces re-verification so the fixer actually re-attempts those issues.

**Model recommendation compatibility (llm-api)**
- `isModelProviderCompatible()` now prefers `runner.provider` (set at runtime by llm-api) over the static `RUNNER_PROVIDER_MAP[runner.name]`.
- **WHY**: The map hardcoded `llm-api` as `'anthropic'`, but llm-api sets `runner.provider` from the available API key (`'openai'` | `'anthropic'` | `'elizacloud'`). With only `OPENAI_API_KEY` set, recommendations like `gpt-5.2` were rejected as “no compatible recommended models” and the runner fell back to rotation instead of using the LLM’s suggestion.

**Commit message scope**
- Commit messages are now built only from issues whose files were actually staged in that commit. We commit with a placeholder, then amend with the message derived from `commit.stagedFiles`.
- **WHY**: Previously the message listed every verified issue on the PR, including files not changed in this commit. That was misleading in history and in “what did this commit do?”. Scoping to staged files keeps the message accurate.

**Review-bot checks excluded from CI pending**
- GitHub check runs named “Cursor Bugbot” (and other review-bot checks in `REVIEW_BOT_CHECKS`) are excluded from `inProgressChecks` / `pendingChecks` when computing PR status.
- **WHY**: Cursor Bugbot registers as a check that stays `in_progress` indefinitely. Counting it made `ciState` “pending” and triggered the full 300s bot wait even when real CI was done. Excluding known review-bot checks avoids false “CI still running” and shortens wait time when only a review bot is pending.

**Related (from prior session)**
- Empty commits and “Everything up-to-date” push handling: no commit when only tool artifacts are staged; skip bot wait when push reports nothing to push.
- **WHY**: Prevents wasted push + 300s wait when nothing was actually committed.
- Consecutive no-commit bail-out: after 2 push iterations with no files committed, the orchestrator exits with `no_progress`.
- **WHY**: When the fixer keeps writing identical content or only touching tool artifacts, the loop would otherwise run indefinitely.

### Fixed (2026-02-17) — ElizaCloud 401 Unauthorized

- **API key trimming**: All LLM API keys (ElizaCloud, Anthropic, OpenAI) are trimmed when loaded from config. Trailing newlines or spaces in `.env` no longer cause 401s.
- **Startup validation**: When `PRR_LLM_PROVIDER` is `elizacloud`, PRR validates the key with one request at startup. If the key is rejected (401), it throws a clear error instead of failing later during dedup/analysis.
- **Clear 401 error**: If an ElizaCloud request returns 401, the client throws a message telling the user to check `ELIZACLOUD_API_KEY` (correct, no extra spaces/newlines, not revoked).
- **WHY**: Copy-pasting keys from docs or password managers often adds a trailing newline; providers reject the key and return 401. Trimming at load time fixes this class of config error. Startup validation fails fast with a clear message instead of failing mid-run during the first LLM call.

### Fixed (2026-02-17) — ElizaCloud rate limiting

- **Concurrency cap for ElizaCloud**: LLM requests to ElizaCloud are limited to `ELIZACLOUD_MAX_CONCURRENT_REQUESTS` (1) in flight, with `ELIZACLOUD_MIN_DELAY_MS` (6000ms) between starting each request. Additional requests queue until a slot is free.
- **Dedup concurrency cap**: LLM dedup (per-file) now runs with at most `LLM_DEDUP_MAX_CONCURRENT` (1) call at a time instead of 24 in parallel. Combined with the client limiter, this prevents 429s from ElizaCloud and other strict gateways.
- **WHY**: 24 parallel dedup calls triggered 429 even with a client-side cap of 5. ElizaCloud enforces ~10 req/min; lowering to 1 concurrent request + 6s spacing + capping dedup at 1 at a time keeps under provider limits.

### Added (2026-02-15) — Fixer intelligence: snippet accuracy and structured outcomes

**Snippet accuracy**
- **Line references from comment body**: `parseLineReferencesFromBody()` extracts line numbers from review text (e.g. "around lines 52 - 93", "at line 128", "lines 70-78", "#L100-L200") and merges them with `comment.line` and LOCATIONS so the snippet covers every referenced range.
- **Wider context**: Snippet context increased from 5/10 lines to 20/30 lines before/after the anchor range; constants `CODE_SNIPPET_CONTEXT_BEFORE` and `CODE_SNIPPET_CONTEXT_AFTER` are now used in `getCodeSnippet()` instead of hardcoded values.
- **Snippet cap**: When the union of anchors spans more than 500 lines, the window is centered on the anchor range and capped at `MAX_SNIPPET_LINES` to avoid prompt bloat.
- **Shell-block exclusion**: Lines containing `sed -n`, `cat -n`, or `head -n` are skipped when parsing line refs so CodeRabbit's analysis-chain script blocks don't produce huge false ranges.
- WHY: Fixers were often given 15 lines around the GitHub API line while the review text referred to lines 50–90. The model literally couldn't see the code in question. Parsing line refs and widening context ensures the fixer sees the right code; capping and excluding shell blocks keep prompts bounded.

**Structured RESULT protocol**
- **Result codes**: Fix prompts (batch and single-issue) now ask for a `RESULT: CODE — detail` line. Supported codes: `FIXED`, `ALREADY_FIXED`, `NEEDS_DISCUSSION`, `UNCLEAR`, `WRONG_LOCATION`, `CANNOT_FIX`, `ATTEMPTED` (optional `CAVEAT:`).
- **Parsing**: `parseResultCode()` in `utils.ts` extracts the code and detail from fixer output; `handleNoChangesWithVerification` tries it first and falls back to `parseNoChangesExplanation` when no RESULT line is found.
- **No-changes handling**: When the fixer returns a RESULT code without making changes, PRR records a lesson and routes by code (e.g. WRONG_LOCATION → "provide wider code context"; UNCLEAR/CANNOT_FIX → rotate). ALREADY_FIXED still triggers spot-check and full verification.
- **NEEDS_DISCUSSION**: When the fixer adds only a `// REVIEW:` comment and outputs RESULT: NEEDS_DISCUSSION, the "has changes" path in `executeFixIteration` treats it as progress (no verification run, consecutive failures reset).
- **llm-api and direct LLM**: llm-api system prompt reinforces OUTCOME REPORTING; `tryDirectLLMFix` accepts RESULT: ALREADY_FIXED and RESULT: CANNOT_FIX without code, logs and records a lesson (and dismisses when ALREADY_FIXED).
- **Single-issue prompt**: Replaced "You MUST make a change" with structured instructions so the fixer can respond with ALREADY_FIXED, UNCLEAR, WRONG_LOCATION, or NEEDS_DISCUSSION instead of forcing cosmetic edits.
- WHY: Without a shared vocabulary, fixers either made unnecessary edits (because "must make a change") or gave freeform NO_CHANGES text that was hard to act on. Structured codes let PRR record targeted lessons, skip verification for discussion-only changes, and avoid forcing changes when the issue is already fixed or unclear.

**Addressed-in-commits hint**
// Note: hints ensure the LLM verifies past fixes before making new changes.
- Comments whose body matches "✅ Addressed in commits ..." (PRR's own marker after a push) get an extra `contextHints` line: "A previous fix attempt claimed to address this issue. Verify whether the current code actually resolves it before making new changes."
- The hint is passed into the LLM analysis (issue-existence check), not into the fix prompt.
- WHY: Those comments indicate a prior fix attempt; the LLM should explicitly check that the current code still resolves the issue instead of assuming it does.

### Performance (2026-02-15) — Parallelization

**Parallel LLM Dedup Calls**
- LLM dedup calls (one per file with 3+ issues) now run concurrently via `Promise.all()` instead of sequentially in a `for...of` loop.
- WHY: 23 independent LLM calls × 2-5s each = ~40-60s sequential. Now completes in ~5-8s (time of the slowest single call). Each call checks a different file with no shared state until response parsing.

**Parallel File I/O Across Workflow**
- Converted 9 sequential `await`-in-loop patterns to `Promise.all()` across 7 files:
  - `fix-verification.ts`: Batch diff + code snippet fetching for verification prep
  - `issue-analysis.ts`: Two-phase snippet fetching (sync solvability filter, then parallel fetch) in `findUnresolvedIssues`
  - `solvability.ts`: Concurrent snippet refresh in `recheckSolvability`
  - `fix-loop-utils.ts`: Parallel snippet fetches in bug-repopulation, bot-review handling, and post-pull refresh loops
  - `analysis.ts`: Concurrent snippets in `checkForNewComments` and `runFinalAudit`
  - `main-loop-setup.ts`: Concurrent snippets for failed audit re-population
  - `dismissal-comments.ts`: Process files concurrently (within each file, bottom-to-top insertion order preserved for line stability)
- WHY: Code snippet fetching is independent file reads. With 30-50 issues, sequential reads added ~1-3s of accumulated I/O latency that now resolves in a single burst. Dismissal comment LLM calls across different files have no shared state and can safely run in parallel.

**Deliberately Left Sequential**
- `noBatch` single-issue verification — each is an LLM call; parallelizing risks API rate limits (429s)
- Single-issue focus loop — ordering matters for revert logic between attempts
- The main fix loop — inherently sequential: fix → verify → learn → rotate

### Added (2026-02-15) — Inline Dismissal Comments

**Dismissal Comment System**
- When PRR dismisses an issue (already-fixed, stale, exhausted, false-positive), it now adds an inline code comment explaining the reasoning.
- Comments are generated by the LLM based on surrounding code context, dismissal reason, and the original review comment — but inserted programmatically (LLM never touches code directly).
- Comment syntax auto-detected per file type (JS/TS `//`, Python `#`, CSS `/* */`, HTML `<!-- -->`).
- Insertion is bottom-to-top within each file to avoid line-number shifting.
- Binary files, null-line issues, and files with existing `Review:` comments nearby are automatically skipped.
- WHY: Review bots need to see a dialog trail in the code. When PRR dismisses an issue, adding an inline comment visible in the diff lets bots and humans understand the reasoning on the next review pass — enabling a proper back-and-forth between PRR and review bots.

**Enhanced After Action Report (AAR)**
- AAR now includes three distinct sections: "Fixed This Session", "Dismissed", and "Remaining".
- The AAR is always printed if there was any session activity (fixed, dismissed, or remaining issues), not just if unresolved issues exist.
- "Fixed" uses `verifiedThisSession` set for accurate per-run tracking.
- "Dismissed" shows issues grouped by category (already-fixed, stale, exhausted, etc.).
- Suggested resolutions for remaining issues with actionable guidance.
- WHY: The old AAR only showed remaining issues and was skipped entirely when everything was fixed, providing no record of what happened. The enhanced version gives a complete session summary for audit trails and handoff.

**Prompt Logging (`prompts.log`)**
- Full LLM prompts and responses are now written to `prompts.log` (alongside `output.log`).
- Each entry has a searchable slug (e.g., `#0001/llm-anthropic`) that also appears as a one-liner in `output.log`.
- WHY: `output.log` shows operational flow but truncating prompts there makes them useless for diagnosis. `prompts.log` keeps the full content searchable without drowning the operational log. Cmd+F the slug in `prompts.log` to jump from a suspicious `output.log` line to the exact prompt that produced it.

**Comment Body Sanitization for Prompts**
- New `sanitizeCommentForPrompt()` function strips base64 JWT tokens (from "Fix in Cursor" links), HTML metadata (`<!-- BUGBOT_BUG_ID -->`, `<!-- DESCRIPTION START -->`), `<details>/<summary>` blocks, `<picture>/<img>` tags, and other noise from comment bodies before they enter LLM prompts.
- Applied to all prompt paths: fix prompts, dedup prompts, batch analysis, verification, failure analysis, commit messages, and dismissal comments.
- WHY: Bot review comments contain massive base64-encoded JWT tokens in "Fix in Cursor" links (500+ chars of noise per link) and HTML metadata that wastes tokens and pollutes LLM context with irrelevant content.

**Duplicate Prompt Detection**
- MD5 hash-based prompt tracker in `execute-fix-iteration.ts` detects when an identical prompt+model combination would be re-sent.
- On detection, the iteration is skipped with a warning and rotation is triggered immediately.
- Tracker resets on rotation so new models get a fair shot even with identical prompt content.
- WHY: When a fixer made no changes and no new lessons were generated, the exact same prompt was re-sent to the same model — guaranteed to produce the same result. Detecting and skipping saves 30-60s per wasted iteration.

### Fixed (2026-02-15) — 35 Bug Fixes

**Verification & Analysis**
- **Bug #9**: Batch analysis parser fails on `## issue_1` markdown-prefixed IDs — regex now strips all leading `#` chars, not just one.
- **Bug #12**: Verifier false-rejects when LLM deliberates before verdict — implemented 3-tier parsing (starts-with → contains → last-line) instead of only checking if response starts with "YES".
- **Bug #26**: `formatCompact` misleads on number arrays — `[14]` displayed as `[1]` (array length). Now inlines short arrays of primitives.
- **Bug #27**: "Review comments" double-logged — once by `github/api.ts` and once by `main-loop-setup.ts`. Removed the redundant call.
- **Bug #35**: `getCodeSnippet` trusts LOCATIONS tags over `comment.line` — inverted priority so the GitHub API line number is preferred, with LOCATIONS only as fallback when line is null. Fixed wrong code snippets for 2+ issues per run.

**State & Counting**
- **Bug #6**: Results summary over-counts "fixed" — `verifiedFixed` included `already-fixed` dismissed issues. Now filtered.
- **Bug #8**: `verifiedFixed` accumulates duplicates across sessions — deduplication added via `new Set()` during state load.
- **Bug #15**: `verifiedFixed` state inflated from previous runs — added dedup for both `verifiedFixed` and `verifiedComments` on load.
- **Bug #23**: Results summary `verifiedFixed` not bounded by actual comment IDs — now intersects with `currentCommentIds`.
- **Bug #24**: "Fixed this session" uses delta counting — replaced with `verifiedThisSession: Set<string>` for accurate per-run tracking.
- **Bug #25**: `newLessons: -7` in verification summary — switched from `getTotalCount()` (can decrease after cleanup) to `getNewLessonsCount()` (monotonic counter).

**Rotation & Recovery**
- **Bug #10**: Tool rotation announces switch but doesn't change actual runner — stale `runner` variable replaced with `getRunner()` callback.
- **Bug #28**: Tool rotation counts `llm-api` as "tried" without using it — added `runnersAttemptedInCycle` set; single-model runners only considered exhausted if actually attempted.
- **Bug #19**: Exit reason "No changes made" overwrites bail-out — `exitReason` now preserved if already set.

**Lessons & Prompts**
- **Bug #11**: Lessons for null-line issues silently discarded — removed double-normalization in `addFileLesson`.
- **Bug #14**: Single-issue verify path doesn't generate lessons — added `lessonsContext` param and `analyzeFailedFix` call to `tryDirectLLMFix`.
- **Bug #20**: Lessons silently discarded by backtick detection — overly aggressive regex now strips backticks instead of rejecting the lesson.
- **Bug #30**: Prompt truncation too aggressive — increased dedup preview from 150 to 500 chars, batch analysis from 800 to 2000 chars.
- **Bugs #31-32**: Base64 JWT blobs and HTML metadata in prompts — `sanitizeCommentForPrompt()` removes them.
- **Bugs #33-34**: Wrong code snippets due to LOCATIONS tag priority — fixed by Bug #35.

**Reporting & UI**
- **Bug #13**: Sanity check re-adds dismissed issues as unresolved — now considers `isCommentDismissed()` alongside `isVerified()`.
- **Bug #16**: Handoff prompt shows dismissed issues — filtered from `finalUnresolvedIssues`.
- **Bug #17**: AAR summary counts overlap — "Fixed" now excludes `isCommentDismissed()` items.
- **Bug #18**: Results summary uses un-deduped state count — excludes ALL dismissed IDs, uses globally deduped state.
- **Bug #21**: AAR "Tools attempted" shows runner names, not models — now uses full `runner/model` key.
- **Bug #22**: Bail-out summary lacks session context — now shows "this session" count.

**Bot Waiting & Push**
- **Bug #29**: PRR not waiting for bot reviews after pushes — two fixes: (1) removed `skipWait` on bail-out, (2) "no changes" path now calls `waitForBotReviews` if intermediate pushes occurred.

**LLM API**
- **`max_tokens` model-dependent**: Set to 128K for Opus, 64K for Sonnet/Haiku. Previously hardcoded to 128K which caused 400 errors on Sonnet.
- **Dismissal comment regex**: Added `m` flag to `COMMENT:` regex for multi-line LLM responses.
- **Dismissal comments on bail-out**: Removed `exitReason !== 'bail_out'` condition that prevented pushing dismissal comments.
- **`svg` in BINARY_EXTENSIONS**: Removed — SVG is a text format, not binary.

**Performance Tracking**
- **Issue A**: Timing breakdown misses ~42% of session time — added `startTimer`/`endTimer` to `trySingleIssueFix()` and `tryDirectLLMFix()`.
- **Issue B**: "No change" fixer responses discarded without analysis — now extracts last ~500 chars of output (cleaned of tool metadata) as lessons.
- **Issue C**: Identical prompt sent to same model on consecutive iterations — implemented MD5-based duplicate prompt detection.
- **Issue D**: Bail-out "models tried" count wrong — now uses `Performance.getModelPerformance()` for actual attempt counts.

### Added (2026-02-17) — Cost Optimization & LLM Reliability

**Anthropic Prompt Caching**
- System prompts are now sent as block-format content with `cache_control: { type: 'ephemeral' }`, enabling Anthropic's prefix caching. Cache reads cost 90% less than base input tokens.
- `batchCheckIssuesExist` static instruction header (~1800 chars of rules, format, and examples) moved from user message to system prompt. Batch 2+ of the same run hits the cache instead of re-processing identical instructions.
- `checkIssueExists` static instructions extracted to a `static readonly` class property and passed as system prompt. Sequential per-comment checks cache the instructions across calls.
- Cache usage stats (`cache_creation_input_tokens`, `cache_read_input_tokens`) are now logged with estimated savings percentage and exposed on `LLMResponse.usage`.
- WHY: PRR makes many sequential Anthropic calls with identical instructions (batch analysis batches, per-comment checks). Without caching, every call re-processes the same system prompt at full price. Anthropic's prefix caching gives 90% discount on cached tokens — the first call pays a 1.25x write premium, but every subsequent call with the same prefix saves 90%. Observability via debug logs lets you confirm caching is working.

**Focused-Section Mode for Direct LLM Fix**
- For files >15K chars, `tryDirectLLMFix` now sends only ±150 lines around the issue line instead of the full file content. The LLM fixes the section, which is spliced back into the original file.
- Full-file mode preserved for small files and files without a line number.
- WHY: Previously, `tryDirectLLMFix` embedded up to 100K chars (~25K tokens) of full file content in every prompt, even when the issue was on a single line. This wasted input tokens on irrelevant code AND forced the LLM to reproduce the entire file in its output (wasting output tokens too, and often hitting the output token limit before finishing). Focused-section mode cuts prompt size by ~90% for large files and produces shorter, more accurate responses.

**Cheap Model Routing for Low-Stakes Tasks**
- `generateCommitMessage` and `generateDismissalComment` now use a cheap model (Haiku for Anthropic, GPT-4o-mini for OpenAI/ElizaCloud) instead of the default verification model (typically Sonnet).
- `CHEAP_MODELS` map defined per provider, used via the existing `options.model` override in `complete()`.
- WHY: Commit messages and dismissal comments are simple one-line text generation. Sonnet ($3/$15 per MTok) is massive overkill when Haiku ($1/$5) produces equivalent results. Same logic for OpenAI: GPT-4o-mini vs GPT-4o. This saves ~66% on these calls with zero quality impact — the output is a single constrained sentence, not code.

**Infrastructure Failure Detection for `analyzeFailedFix`**
- New exported `isInfrastructureFailure()` utility in `recovery.ts` detects quota, rate limit, timeout, crash, OOM, and HTTP 5xx patterns in verification explanations.
- All three `analyzeFailedFix` callsites (recovery.ts single-issue mode, recovery.ts direct LLM fix, fix-verification.ts sequential mode) now skip the LLM analysis call for infrastructure failures, recording a plain-text lesson instead.
- WHY: When a fix fails because the API returned "429 Quota/rate limit exceeded", spending tokens asking an LLM "why did this fix fail?" is pure waste — the answer is obvious and doesn't need AI analysis. In the audit log, 20+ consecutive quota failures would each have triggered an `analyzeFailedFix` call. Now those skip the LLM entirely and record a simple "infra failure: quota exceeded" lesson.

**Skip Already-Verified Issues in `verifyFixes`**
- `verifyFixes` now checks `Verification.isVerified()` before adding issues to the verification queue, skipping issues already confirmed fixed by earlier recovery phases (`trySingleIssueFix`, `tryDirectLLMFix`).
- WHY: Without this, issues verified during recovery were re-verified in the main verification pass — burning a verification LLM call on an already-known result. Each skipped issue saves one `verifyFix` call (or one slot in a `batchVerifyFixes` prompt).

### Fixed (2026-02-17) — LLM Response Truncation

**`max_tokens` Truncation Causing Silent Fix Failures (P0)**
- Anthropic `max_tokens` increased from a conditional `16000/16384` to `128_000`. The API requires this parameter, but the old value silently truncated LLM responses mid-file, causing the code extraction regex to fail and zero fixes to be applied.
- OpenAI `max_tokens` removed entirely. It's an optional parameter, and the hardcoded `4096` was truncating responses at ~3K words — not enough for any non-trivial file rewrite.
- Added fallback regex in `tryDirectLLMFix` for truncated responses: when a response starts with a code fence but lacks a closing ` ``` ` (hit output limit), the partial content is used instead of silently discarding the entire response.
- WHY: This was the root cause of zero fixes in direct LLM recovery. The model would correctly generate a fixed file, but the response would be truncated at 4096 tokens (mid-word), the closing code fence would be missing, the extraction regex would fail, and the fix would be silently discarded. Setting `max_tokens` high for Anthropic (required parameter) and removing it for OpenAI (optional) eliminates artificial truncation. The fallback regex is a safety net for the rare case where a response genuinely exceeds the model's natural output limit.

### Added (2026-02-17)

**Persistent Comment Status System (`commentStatuses`)**
- Each PR comment now has an explicit `open` or `resolved` lifecycle status persisted in the state file, alongside the LLM's classification (`exists`, `stale`, `fixed`), explanation, triage scores, file path, and a SHA-1 file content hash.
- New `state-comment-status.ts` module with `markOpen()`, `markResolved()`, `getValidStatus()`, `invalidateForFile()`, `invalidateForFiles()`, and `getCommentsByStatus()` functions.
- WHY: Previously, every push iteration re-sent ALL unresolved comments to the LLM for classification — even when neither the comment body nor its target file had changed. For 20+ issues this burned 5-15s and thousands of tokens on identical "still exists" verdicts. PR comments are near-immutable (body/path/line don't change after posting), so the only variable is whether the CODE still exhibits the issue. By persisting the LLM's verdict with a file content hash, we skip re-analysis for comments on unmodified files.

**Comment Status Sync Hooks**
- `markVerified()` and `clearAllVerifications()` in `state-verification.ts` now sync `commentStatuses` to `resolved` when a fix is verified, and clear all statuses when verifications are bulk-cleared.
- `unmarkVerified()` deletes the `commentStatuses` entry so the comment gets fresh LLM re-analysis.
- `dismissIssue()` in `state-dismissed.ts` flips `commentStatuses` to `resolved` when a comment is dismissed.
- `undismissIssue()` deletes the entry for the same reason.
- WHY: Three overlapping systems track comment lifecycle: `verifiedFixed[]`, `dismissedIssues[]`, and `commentStatuses{}`. Without sync hooks, `commentStatuses` would keep stale "open" data after a comment transitions through `markVerified()` or `dismissIssue()`. The hooks maintain the invariant: if a comment is verified or dismissed, its status is resolved or absent — never contradictorily "open". Direct state mutation (no new imports) avoids circular dependency risk between state modules.

**Stale Verification Bypass for Comment Status**
- `--reverify` flag and stale verifications (verified 5+ iterations ago) now bypass the comment status cache, forcing fresh LLM analysis.
- WHY: Without this, the sync hooks + hash relaxation would conspire to silently neuter stale re-checks. When `markVerified()` flips a comment to `resolved`, and later `getStaleVerifications()` flags it for re-check, the status cache would return `resolved` and the comment would be re-dismissed instead of re-analyzed. The `forceReanalyze` guard ensures both `--reverify` and stale verifications always trigger the LLM. This was the subtlest bug in the design — three phases interacting to create a silent failure.

**Hash Relaxation for Hook-Set Statuses**
- `getValidStatus()` now only validates file content hashes for `open` entries. Resolved entries set by hooks (which preserve the original, potentially stale hash) pass through without hash validation.
- WHY: When `markVerified()` flips status to `resolved`, it spreads the existing entry (preserving the original hash). If the file was modified between "mark open" and "mark verified", the hash is stale. Strict validation would invalidate the resolved entry and trigger re-analysis. But resolved entries are already caught by `isVerified()`/`isDismissed()` gates before reaching `getValidStatus()` — the only entries that reach this check and matter are `open` ones, which always have a fresh hash from LLM analysis.

**Issue Deduplication Improvements**
- Duplicate candidate numbering is now sequential across all groups (1, 2, 3... not restarting per group), shared between heuristic display and LLM dedup verdicts.
// Review: sequential numbering clarifies logs, resolving ambiguity in deduplication references
- Comment author displayed inline in duplicate candidate logs for easier identification.
- WHY: When group 1 had candidates #1-#10 and group 2 restarted at #1-#3, the LLM dedup verdict referencing "#3" was ambiguous. Sequential numbering and inline authors make log output unambiguous.

**Dedup Cache (In-Memory)**
- LLM dedup results are cached in-memory when the comment ID set is unchanged between iterations, skipping redundant token-burning dedup calls.
- WHY: Heuristic dedup is CPU-only (cheap), but LLM dedup costs tokens. Dedup results are deterministic given the same set of comment IDs — caching avoids re-running the same LLM call on each push iteration.

### Fixed (2026-02-17)

**Outer Loop Bail-Out Limit**
- After a stalemate bail-out, the push iteration loop returned `shouldBreak: false` so the outer loop would re-enter with fresh bot comments. In practice, bots add MORE comments after each push (not fewer), so each re-entry hit the same stalemate on an even larger issue set. Observed: 5 bail-outs x 300s wait = 25 min wasted.
- Fix: Track consecutive bail-outs at the outer loop level. After `MAX_CONSECUTIVE_BAILOUTS` (2) with no progress reduction in remaining issue count, hard-exit. One re-entry is still useful (catches fixes the bots resolved), but beyond that it's diminishing returns.

**300s CodeRabbit Wait After Stalemate**
- After stalemate bail-out, `handleCommitAndPush` still waited 300s for CodeRabbit re-review even though no more fix iterations would run.
- Fix: Pass `skipBotWait` flag when bailing out so the commit+push skips the wait.

**.prr/ Directory Protection**
- The fixer LLM was modifying `.prr/lessons.md` as if it were a source file. Rule 7 added to the LLM system prompt explicitly forbidding `.prr/` modifications.
- WHY: `.prr/` files are tool-managed state. Fixer edits to lessons files corrupt the learning system and get auto-reverted, wasting a fix iteration.

**Test File Verification for Next.js Routes**
- Test files named after the parent directory (e.g., `verify.test.ts` for `app/api/auth/siwe/verify/route.ts`) weren't matched during verification, causing "0 issues fixed" when the fixer correctly created test files.
- Fix: Added Next.js conventional filename detection (`route.ts`, `page.ts`, `layout.ts`, etc.) that falls back to matching on the parent directory name.

**Search/Replace Failure Escalation via Verification**
- Files that were modified but failed verification now count toward search/replace failure tracking, triggering escalation to full-file rewrite after repeated failures.
- WHY: Previously only literal search/replace parse failures incremented the counter. A file where the fixer made changes that didn't address the issue would never escalate, even after 5+ failed attempts.

**Comment Status Invalidation After Fix**
- After `verifyFixes`, open comment statuses for modified files are invalidated so the next iteration re-analyzes them instead of serving stale "still exists" verdicts.
- WHY: The fixer modifies files to resolve issues. If the status cache still says "open" with the old file hash, it would skip LLM analysis and keep reporting the issue as unresolved even though the fix may have resolved it.

### Added (2026-02-16)

**PR Context in Fix Prompts**
- Fix prompts now include the PR title, description (truncated to 500 chars), and base branch in a new "PR Context" section before the issues list.
- Single-issue prompts include title and base branch (description omitted to keep focus tight).
- New instruction `0. First, run git diff <base>...HEAD --stat` added to fix prompts so the fixer understands the full scope of changes before acting.
- WHY: Without PR context, fixers see individual review comments in isolation. A comment like "incorrect error handling in the auth flow" means nothing without knowing the PR adds OAuth2 PKCE for mobile. Fixes were technically valid but semantically misaligned with the PR's intent. The diff instruction gives agentic fixers (Cursor, Claude Code) a way to see the big picture.

**Greptile Bot Support**
- Added `greptile[bot]` to `REVIEW_BOTS` for issue comment extraction.
- WHY: Greptile posts structured reviews as issue comments (not inline review threads). Without this, its feedback was invisible to prr. CodeRabbit was intentionally NOT added — it uses inline review threads already captured by `getReviewThreads()`, and adding it to `REVIEW_BOTS` would cause duplicate issues from its summary comment.

**Bot Name Normalization**
- New `normalizeBotName()` helper in `GitHubAPI` converts bot logins like `claude[bot]` → `Claude`, `greptile[bot]` → `Greptile` in fix prompts.
- WHY: Cleaner display in prompts without the `[bot]` suffix noise. Only applied in the issue-comment path — raw logins are preserved in inline review threads where they serve as identity keys for deduplication and verification tracking.

**PR Title & Body in PRInfo**
- `PRInfo` interface now includes `title` and `body` fields, fetched in `getPRInfo()`.
- `body` is coerced from `null` to `''` at the API boundary so downstream code never null-checks.
- WHY: This metadata was already returned by the GitHub API but discarded. Threading it through the call chain (`resolver → executeFixIteration → buildAndDisplayFixPrompt → buildFixPrompt`) gives every prompt path access to PR context at zero extra API cost.

### Fixed (2026-02-13)

**Stalemate Bailout Loop**
- After stalemate detection, the tool would commit+push partial progress then re-enter the push iteration loop instead of exiting. This caused 9 repeated stalemate cycles, each waiting 300s for CodeRabbit re-review and running full fix loops — burning tokens and time for zero progress.
- Fix: set `exitReason = 'bail_out'` when breaking from the fix loop, then return `shouldBreak: true` after commit+push so the outer loop exits cleanly.

**Auto-Verified Duplicate Counter**
- The "Auto-verified N duplicate comment(s)" count was recounting previously-verified duplicates every iteration, showing inflated numbers (e.g., 8 when 0 new duplicates were verified).
- Fix: count inline at the point of auto-verification instead of recounting all verified duplicates after the fact.

### Added (2026-02-13)

**Claude[bot] Issue Comment Extraction**
- The tool only extracted inline review thread comments (GraphQL `reviewThreads`), completely missing claude[bot]'s reviews which are posted as issue/conversation comments.
- New `getReviewBotIssueComments()` fetches PR issue comments, filters for known review bots (extensible, currently `claude[bot]`), takes only the latest comment (bots re-review on each push).
- New `parseMarkdownReviewIssues()` handles both of Claude's review formats:
  - Format A: `### N. **Title**` with `**Location:** \`file.ts:line\`` (structured)
  - Format B: `**Issues:**` sub-headers with `N. **Title** (file.ts:line)` (condensed)
- Parsed issues merge seamlessly into the existing `ReviewComment[]` flow.

**Lessons System Overhaul**
- Lesson generation reframed: prompts now ask "what was LEARNED from this failure so the next attempt makes progress" instead of "extract a technical constraint." Produces lessons like "cache.set() returns void not boolean — checking return value always falsy" instead of "The diff only adds X but doesn't do Y."
- Lesson cleanup on fix: when an issue is verified, fix-attempt-specific lessons (prefixed "Fix for X:Y - ...") are removed while architectural insights are kept. New `lessons-cleanup.ts` module.
- Lessons capped in prompts: max 15 most recent (was unlimited, observed 73+). Reframed from "DO NOT REPEAT THESE MISTAKES" to collaborative "Lessons Learned" framing.
- Compaction wired to save: `compact()` (10/file, 20 global) now runs automatically on every `save()` — existed but was never called.
- `--tidy-lessons` now also runs compaction step (was missing from the tidy pipeline).

**Pre-Commit Tool Artifact Detection**
- New `unstageToolArtifacts()` runs after staging, before committing.
- Detects raw `<change><search>...</search><replace>` markup from partially-parsed LLM responses and tool-generated note files (e.g., `__cache-check-needed.md`).
- Reverts modified files / unstages new files with a warning, preventing tool debris from being committed to the codebase.

**Output Log Improvements**
- Moved `output.log` to CWD (was `~/.prr/output.log`).
- Patches `console.log/warn/error` directly instead of `process.stdout.write` — excludes spinner noise (ora) from the log while capturing all substantive output.

### Added (2026-02-12) — CLI & Startup Tooling
- Scans all lesson JSON files in `~/.prr/lessons/` and re-normalizes, deduplicates, prunes garbage entries
- Also cleans `.prr/lessons.md` in the current repo (flexible parser handles multiple Markdown formats)
- Filters out non-actionable noise like "No verification result returned, treating as failed"

// Rest of changelog stays unchanged...
// Note: outputs log to CWD for easier access and consistency with user expectations
