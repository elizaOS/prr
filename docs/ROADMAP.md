# Future / roadmap (exploration ideas)

Items here are potential directions to explore, not committed plans. Each idea includes **why** it would help, so we can revisit tradeoffs later.

## Recently completed

**Prompts.log audit: ALREADY_FIXED counter, batch injection, single-issue full file, verifier context (2026-03)**
- **P1 — ALREADY_FIXED multi-model dismissal**: New `consecutiveAlreadyFixedAnyByCommentId` counter dismisses issues after 3+ models return ALREADY_FIXED (any explanation). Counter resets on fixer changes or verification. **WHY**: Existing same-explanation counter missed the broader pattern where multiple models independently agree the issue is resolved; saves 3-5 wasted iterations per issue.
- **P3 — Batch injection filter**: `allowedPathsForInjection` limits file injection to files with unfixed issues in later rounds. **WHY**: Already-fixed files waste context budget; filtering observed 40-60% reduction in injected content on rounds 2+.
- **P5 — Single-issue full file**: `getFullFileContentForSingleIssue` sends up to 600 lines instead of 15-30 line snippets. **WHY**: Models responded INCOMPLETE_FILE/UNCLEAR without broader context.
- **P7 — Verifier type/signature context**: `commentMentionsApiOrSignature` expands verifier window to 500 lines for type/signature issues. **WHY**: 200-line default caused false "never assigned" rejections.
- See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Prompts.log audit: ALREADY_FIXED counter, batch injection filter, single-issue full file, verifier type/signature context".

**Comment parsing: parse all bot comments, noise filter, path-less gap (2026-03)**
- Parse ALL comments from known review bots (not just latest); `isBotNoiseComment` filters junk before parsing; `parseMarkdownReviewIssues` includes path-less items with actionable language as `(PR comment)`. **WHY**: Only reading the latest comment per bot missed issues from earlier reviews. Zero missed issues is the mission — noise filter and actionable regex prevent false positives. See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Comment parsing".

**Prompts.log audit: dedup, verifier strength, dismissal comments, multi-file (2026-03)**  
- Skip dismissal-comment when reason says "file no longer exists" / "file not found"; post-filter generated COMMENT when it mostly restates surrounding code; heuristic dedup merges same file + same symbol + same caller file across authors; multi-file nudge in fix prompt when TARGET FILE(S) has multiple files and body mentions callers; verifier uses stronger model for API/signature-related fixes when available. **WHY**: Audit of a BFCL/reporting.py run found duplicate issues from different authors not merged (wasted fix attempts), weak verifier approving call-site bugs, dismissal prompt for missing file, generic dismissal comments inserted, and fixer updating only one of two target files. See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Prompts.log audit: dedup same-caller, verifier strength, dismissal skips, multi-file nudge" and [AUDIT-CYCLES.md](AUDIT-CYCLES.md) Cycle 10.

**CLAUDE.md / sync target fix (2026-03)**  
- setWorkdir now uses shared `Detect.autoDetectSyncTargets` so `originalSyncTargetState` is set; re-detect after clone so "existed at start" reflects the post-checkout workdir. **WHY**: We were always deleting CLAUDE.md at final cleanup because we never recorded that it existed in the repo; we only remove sync targets we created this run. See [CHANGELOG](../CHANGELOG.md) "Fixed (2026-03) — CLAUDE.md / sync targets" and [docs/README](README.md) "CLAUDE.md / sync target fix".

**Output.log audit follow-up (2026-03)**  
- Runner allowed paths expanded (journal, consolidate-duplicate, test-impl); CodeRabbit "Actions performed" / auto-reply filtered from fixable comments; issues with path `(PR comment)` dismissed in solvability. **WHY**: Blocked journal edits, meta comments as issues, and non-file paths wasted fix iterations. See [CHANGELOG](../CHANGELOG.md) "Fixed (2026-03) — Output.log audit" and [docs/README](README.md) "Output.log audit follow-up".

**Output.log audit (Cycle 15): fix-in-test allowed path (2026-03)**  
- When the review says to fix the root cause in tests (e.g. "fix logger mocks in tests", "root cause in tests"), the co-located test file is now added to TARGET FILE(S) so the fixer can edit it. **WHY**: Babylon #1207 run stalled because only the production file was allowed; the fixer could not apply the suggested fix. See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Output.log audit (Cycle 15)" and [AUDIT-CYCLES.md](AUDIT-CYCLES.md) Cycle 15.

**Prompts.log audit (Cycle 16): dedup validation + predict-bots guard (2026-03)**  
- Dedup now rejects malformed `GROUP:` lines when any referenced index is outside `1..N`, and the prompt explicitly tells the model that valid indices are only `1..N` and the canonical index must appear in its group. **WHY**: A dedup response referenced comments `2,5,7` in a 3-comment file; rejecting invalid groups avoids wrong merges and the prompt reduces hallucinated indices.
- Bot prediction now skips tiny meta-only diffs and filters predicted files to `changedFiles`. **WHY**: The display-only predictor hallucinated `scripts/build-skills-docs.js` from a `.gitignore`-only diff; filtering to the actual diff saves tokens and avoids noisy UX output. See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Prompts.log audit (Cycle 16)" and [AUDIT-CYCLES.md](AUDIT-CYCLES.md) Cycle 16.

**Output.log follow-up: avoid incorrect skips from truncated paths (2026-03)**  
- Solvability now resolves possibly truncated review paths against tracked repo files before dismissing a comment as "file no longer exists". Single-issue / no-changes flows also pass `pathExists` so inferred test paths match the actual repo layout, and the disallowed-file learner now recognizes "fix in tests" comments when allowing retried test paths. **WHY**: Babylon #1207 output.log showed actionable comments being dismissed because paths like `generate-skills-md.ts`, `SKILL.md`, and `wallet/nfts/route.ts` were treated as missing even though the real files existed at longer repo paths. See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Output.log follow-up: avoid incorrect skips from truncated paths".

**Git fetch: timeout and token auth (2026-03)**  
- Conflict-check and remote-ahead fetch now run via spawn with a 60s timeout; on timeout the error includes git’s stdout/stderr so users see e.g. password prompts. Optional `githubToken` is used for one-shot HTTPS auth when the remote has no credentials, so fetch/pull no longer hang waiting for a password. **WHY**: Stuck “Checking for conflicts…” with no output was caused by fetch waiting for credentials; timeout + output + token auth fix it. See [CHANGELOG](../CHANGELOG.md) “Added (2026-03) — Git fetch: timeout, stdout on timeout, GitHub token auth”.

---

## Recently completed (from audits)

The following items from Prompts.log / Output.log audits are already implemented and documented in [CHANGELOG](../CHANGELOG.md) under "Fixed (2026-02) — Prompts.log audit: verifier before snippet, model rec skip, no-op skip verify, escalation delay, predict-bots skip":

- **Verifier before snippet** — Verifier prompt now includes "Code before fix" (from diff) so it can compare before vs after. WHY: Reduces false rejections when the fix was correct.
- **Model recommendation skip (&lt; 3 issues)** — No separate recommendation call for 1–2 issues; use default rotation. WHY: Saves ~29s and tokens.
- **All-no-op skip verification** — When all change blocks are no-ops, skip verification and treat as no changes. WHY: Avoids verifier on unchanged code.
- **Delay full-file escalation for simple issues** — For importance ≤ 3 and ease ≤ 2, escalate only when file not injected. WHY: Rely on S/R first; full-file is expensive.
- **Skip predict-bots when --no-wait-bot** — Omit LLM prediction of likely bot feedback when user isn't waiting for bots. WHY: Saves ~26s.

---

## Blast radius and focus masking

**Idea:** Use the PR diff to compute a "blast radius" (changed files plus their upstream dependencies and downstream dependents), then focus the fix loop on that set and effectively ignore or deprioritize the rest.

- **Upstream:** files that changed files import/depend on.
- **Downstream:** files that import/depend on changed files.
- **Use:** Restrict which issues we process and which files appear in the fix prompt so the model and tooling focus on the scope of the PR; mask off out-of-scope code.

**WHY:** Audits show waste when the fix loop processes comments on files outside the PR’s logical scope or when the prompt is diluted by many unrelated files. Focusing on blast radius reduces prompt size, improves fix accuracy, and avoids cross-file confusion (e.g. wrong-file exhaust). Tradeoff: some valid cross-file fixes might be deprioritized; depth limit and “changed files only” fallback keep scope reasonable.

Would require: PR changed-file list (`git diff base...HEAD --name-only`), a dependency graph (e.g. TS/JS import/require parsing), radius computation (depth limit), and integration into issue filtering and prompt building. Start with TS/JS; fallback to "changed files only" when no graph is available.

## Audit-derived follow-ups (optional)

From [AUDIT-CYCLES.md](AUDIT-CYCLES.md) consolidated findings; not committed, low priority.

- **getConsolidateDuplicateTargetPath:** Iterate all path matches in comment body and return the first that is not `comment.path` and not `lib/utils/db-errors.(ts|js)` (today we use first match only, so if db-errors is mentioned first we return null). **WHY:** When the canonical duplicate file is listed after db-errors, fixer could get allowed path for the right file.
- **pathExists for single-issue prompt:** `buildSingleIssuePrompt` in `workflow/utils.ts` calls `getTestPathForSourceFileIssue(issue)` without `pathExists`; batch prompt and recovery already pass it. **WHY:** Single-issue focus mode can resolve to a colocated test path that does not exist when the real file is in __tests__/integration/; passing pathExists would align behavior and reduce wrong-file attempts.
- **Fix-in-test allowed path (Cycle 15):** Implemented — see "Recently completed" above.
- **Path normalization:** In runner `allowedSet`, add `.replace(/\\/g, '/')` so Windows-style paths match. **WHY:** Avoid cross-platform mismatches when comparing paths.
- **Tests:** Unit tests for `getMigrationJournalPath`, `getConsolidateDuplicateTargetPath`, `getFixedIssueTitle`, `pluralize`, and optionally `isCodeRabbitMetaComment`. **WHY:** Future refactors don’t break behavior.

## Dismissal feedback loop (generator-judge learning)

**Idea:** Use the structured `dismissedIssues` data (already persisted in state) to close the loop between the issue generator (review bots) and the judge (fixer/verifier), so the system learns which issues are false positives and stops re-flagging them.

- **Export dismissed issues** in machine-readable format for generator training.
- **Pattern analysis** to identify common false positive types (e.g. "TypeScript types prevent this" shows up repeatedly — stop flagging null checks in typed code).
- **Dismissal rate metrics** per issue type / per bot, surfaced in run summary.
- **Automatic generator tuning** — feed dismissal patterns back into analysis prompts so the batch checker is less likely to say YES for known false-positive shapes.
- **Confidence scoring** — generator indicates uncertainty, judge can teach ("I'm 60% sure this is an issue" — judge confirms or dismisses with evidence).

**WHY:** Current runs show high dismissal rates (e.g. 62% EXISTING for already-fixed, many stale/file-unchanged). That implies the generator often flags issues that the judge then dismisses. Closing the loop would reduce tokens (fewer issues to analyze/fix), improve signal-to-noise for humans, and make PRR’s behavior more predictable. Tradeoff: requires generator support or a separate “dismissal → analysis prompt” pipeline; we already persist dismissal reasons, so export and pattern analysis are low-hanging first steps.
