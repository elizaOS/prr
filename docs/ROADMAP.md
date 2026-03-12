# Future / roadmap (exploration ideas)

Items here are potential directions to explore, not committed plans. Each idea includes **why** it would help, so we can revisit tradeoffs later.

**Completed work belongs in [CHANGELOG](../CHANGELOG.md), not here.** When an item is done, add it to CHANGELOG and remove it from this file. See `.cursor/rules/roadmap-vs-changelog.mdc`.

## Blast radius and focus masking

**Idea:** Use the PR diff to compute a "blast radius" (changed files plus their upstream dependencies and downstream dependents), then focus the fix loop on that set and effectively ignore or deprioritize the rest.

- **Upstream:** files that changed files import/depend on.
- **Downstream:** files that import/depend on changed files.
- **Use:** Restrict which issues we process and which files appear in the fix prompt so the model and tooling focus on the scope of the PR; mask off out-of-scope code.

**WHY:** Audits show waste when the fix loop processes comments on files outside the PR's logical scope or when the prompt is diluted by many unrelated files. Focusing on blast radius reduces prompt size, improves fix accuracy, and avoids cross-file confusion (e.g. wrong-file exhaust). Tradeoff: some valid cross-file fixes might be deprioritized; depth limit and "changed files only" fallback keep scope reasonable.

Would require: PR changed-file list (`git diff base...HEAD --name-only`), a dependency graph (e.g. TS/JS import/require parsing), radius computation (depth limit), and integration into issue filtering and prompt building. Start with TS/JS; fallback to "changed files only" when no graph is available.

## Audit-derived follow-ups (optional)

From [tools/prr/AUDIT-CYCLES.md](../tools/prr/AUDIT-CYCLES.md) consolidated findings; not committed, low priority.

- **getConsolidateDuplicateTargetPath:** Iterate all path matches in comment body and return the first that is not `comment.path` and not `lib/utils/db-errors.(ts|js)` (today we use first match only, so if db-errors is mentioned first we return null). **WHY:** When the canonical duplicate file is listed after db-errors, fixer could get allowed path for the right file.
- **pathExists for single-issue prompt:** `buildSingleIssuePrompt` in `workflow/utils.ts` calls `getTestPathForSourceFileIssue(issue)` without `pathExists`; batch prompt and recovery already pass it. **WHY:** Single-issue focus mode can resolve to a colocated test path that does not exist when the real file is in __tests__/integration/; passing pathExists would align behavior and reduce wrong-file attempts.
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
