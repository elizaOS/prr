# Future / roadmap (exploration ideas)

Items here are potential directions to explore, not committed plans. Each idea includes **why** it would help, so we can revisit tradeoffs later.

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

## Dismissal feedback loop (generator-judge learning)

**Idea:** Use the structured `dismissedIssues` data (already persisted in state) to close the loop between the issue generator (review bots) and the judge (fixer/verifier), so the system learns which issues are false positives and stops re-flagging them.

- **Export dismissed issues** in machine-readable format for generator training.
- **Pattern analysis** to identify common false positive types (e.g. "TypeScript types prevent this" shows up repeatedly — stop flagging null checks in typed code).
- **Dismissal rate metrics** per issue type / per bot, surfaced in run summary.
- **Automatic generator tuning** — feed dismissal patterns back into analysis prompts so the batch checker is less likely to say YES for known false-positive shapes.
- **Confidence scoring** — generator indicates uncertainty, judge can teach ("I'm 60% sure this is an issue" — judge confirms or dismisses with evidence).

**WHY:** Current runs show high dismissal rates (e.g. 62% EXISTING for already-fixed, many stale/file-unchanged). That implies the generator often flags issues that the judge then dismisses. Closing the loop would reduce tokens (fewer issues to analyze/fix), improve signal-to-noise for humans, and make PRR’s behavior more predictable. Tradeoff: requires generator support or a separate “dismissal → analysis prompt” pipeline; we already persist dismissal reasons, so export and pattern analysis are low-hanging first steps.
