# Guide for AI coding agents

This file helps AI assistants (Cursor, Claude Code, Aider, etc.) work effectively in this repo.

## Generated artifacts (not committed)

These are created by tools and should not be committed: `.split-plan.md`, `.split-rewrite-plan.yaml` (or `.split-rewrite-plan.md`/`.json` — rewrite plan for split-exec), `.split-exec-workdir/` (clone workdir for split-exec), `.split-rewrite-plan-workdir/` (clone workdir for split-rewrite-plan), `split-exec-output.log`, `split-exec-prompts.log`, `split-plan-output.log`, `split-plan-prompts.log`, `pill-output.md`, `pill-summary.md`, `output.log`, `prompts.log`. See `.gitignore`.

**Committed generated data:** **`generated/model-provider-catalog.json`** is checked in on purpose. It lists current **Anthropic** and **OpenAI** API model IDs scraped from the official doc URLs in `docs/MODELS.md`, plus hyphenless lookup keys (e.g. `gpt5mini` → `gpt-5-mini`) so tools can treat vendor spellings as authoritative. Refresh locally with **`npm run update-model-catalog`**; CI runs **`.github/workflows/refresh-model-catalog.yml`** on a weekly schedule. Override path with **`PRR_MODEL_CATALOG_PATH`**. Loader: **`shared/model-catalog.ts`**.

**PRR vs stale bot model advice:** Some review bots claim a valid API id is wrong and suggest another valid id. **WHY dismiss:** That is not a real fix task when both strings appear in the catalog — it would waste fix-loop iterations and risk applying the wrong id. **`assessSolvability`** check **0a6** (`tools/prr/workflow/helpers/outdated-model-advice.ts`) returns `not-an-issue`. **WHY auto-heal:** If the branch already contains the bot’s suggested id inside quotes/backticks near the comment line, **`applyCatalogModelAutoHeals`** (`catalog-model-autoheal.ts`) restores the catalog-correct id in a tight line window so analysis sees correct code. **WHY `verifiedThisSession`:** Commits are gated on verified session ids; heal calls **`markVerified`** so **`commitAndPushChanges`** can run on the “all resolved, no fix loop” path when the only dirty change is the heal. Opt out: **`PRR_DISABLE_MODEL_CATALOG_SOLVABILITY`**, **`PRR_DISABLE_MODEL_CATALOG_AUTOHEAL`**. Details: **DEVELOPMENT.md** (Commit gate and catalog model auto-heal), **docs/MODELS.md**.

**Pill hook:** Pill runs on close only when the user passes **`--pill`** on the command line. **prr**, **split-exec**, **story**, and **split-plan** accept `--pill`; after parsing, they call `setPillEnabled(true)`. Then `closeOutputLog()` runs pill on the closed logs (and writes pill-output.md / pill-summary.md). When `--pill` is not passed, pill does not run. **WHY opt-in:** Default runs stay fast; tools like split-exec have no LLM calls, so pill would often have nothing to analyze. When `--pill` is set, pill runs if the output log has content or the prompts log has PROMPT/RESPONSE/ERROR entries.

**prompts.log:** When output logging is active (e.g. prr with default --verbose), `prompts.log` (or `{prefix}-prompts.log`) is written with full prompt and response text between structural markers (PROMPT #NNNN, RESPONSE #NNNN). Content is written by `shared/logger.ts` (`writeToPromptLog`). Entries with zero content between markers indicate a logging bug and should be reported or investigated; pill and audit cycles rely on this content.

**Troubleshooting empty prompts.log:** If the **primary LLM path** (in-process, e.g. elizacloud via `tools/prr/llm/client.ts`) produces empty PROMPT/RESPONSE entries, the fix is in that code path: ensure the full prompt string is passed to `debugPrompt()` and the full response body to `debugResponse()` (e.g. after streaming, pass the accumulated content, not a placeholder). `shared/logger.ts`'s `writeToPromptLog` refuses zero-length or whitespace-only body and **warns to stderr** (and console) with the slug so you can see which caller sent an empty body. If most entries in prompts.log are from **llm-elizacloud** and every body is empty, the streaming path in the elizacloud client may not be passing the accumulated response to the logger — check `shared/llm/elizacloud.ts` (or the code that calls `debugResponse()` after streaming). Check that `initOutputLog()` was called before the first LLM call and that `promptLogStream` is non-null. **When llm-api is the sole fixer:** the subprocess may not call `initOutputLog`, so **prompts.log may be empty** even though the fixer ran; use **`PRR_DEBUG_PROMPTS=1`** to get per-prompt files under `~/.prr/debug/`, or inspect `output.log` (e.g. `PROMPT #0001 → { chars: N }`) for evidence of calls.

**Crash / truncation:** Writes are buffered. If the process exits abruptly (crash, kill), the last entry may be missing or truncated. The logger uses cork/uncork per prompts.log entry so each PROMPT/RESPONSE/ERROR is flushed as a unit, reducing truncated entries. `closeOutputLog()` flushes and closes streams on normal shutdown.

**Pill and large logs:** When output.log (or prompts.log) exceeds the token budget, pill summarizes it and may miss single-line or tabular evidence (e.g. RESULTS SUMMARY counts, Model Performance table, overlap IDs). For critical runs, inspect output.log manually for those sections; pill now also extracts and appends key evidence when the log is summarized. **Very large output.log** (e.g. long runs) can cause **504 / FUNCTION_INVOCATION_TIMEOUT** when the full audit request is sent; pill caps output-log size (see `tools/pill/context.ts`). If pill fails with 504, set **`PILL_CONTEXT_BUDGET_TOKENS=20000`** (or lower) for small-context models so the audit request fits; re-run with a smaller log or inspect output.log manually otherwise.

**Model pinning:** If the log shows "Configured model unavailable; using: …", the requested model was not available and PRR fell back. If it shows "No model configured; defaulting to: …", no model was set and PRR chose a default. To pin the model, set **`PRR_LLM_MODEL`** (e.g. `anthropic/claude-sonnet-4-5-20250929`).

**Model skip list (ElizaCloud):** Some models are skipped by default. Reasons are separate: **known timeout/504** (transient possible — retry with `PRR_ELIZACLOUD_INCLUDE_MODELS`) vs **0% fix rate** (audit). The list is in **`shared/constants.ts`** (`ELIZACLOUD_SKIP_MODEL_IDS`; reasons in `ELIZACLOUD_SKIP_REASON`). DEBUG logs show which reason per model. To re-enable a skipped model (e.g. timeout was gateway-specific), set **`PRR_ELIZACLOUD_INCLUDE_MODELS`** to a comma-separated list (e.g. `openai/gpt-4o,anthropic/claude-3.7-sonnet`). See `getEffectiveElizacloudSkipModelIds()` and `getElizaCloudSkipReason()`.

**Clone / git output:** During clone and fetch, git's stdout and stderr are forwarded to the terminal so you see progress (e.g. "Receiving objects: 45%") and any prompts. If it appears to hang with no output, the process may be waiting on a git prompt (e.g. SSH host key verification or credentials). For first-time SSH, set **`GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"`** to avoid the host key prompt; for HTTPS, ensure a token is set so git does not prompt for a password. Clone timeout: **`PRR_CLONE_TIMEOUT_MS`** (default 900s). Optional **`PRR_CLONE_DEPTH`** (e.g. `1`) passes **`git clone --depth`** for a shallow clone on very large repos (trade-off: incomplete history).

**Strict audit exit:** Set **`PRR_STRICT_FINAL_AUDIT=true`** (or `1`) to exit with code **2** when the run would otherwise succeed but **audit overrides** exist (issues kept verified despite final audit UNFIXED). Default is to exit 0 unless another failure applies.

**Final audit and verified state:** When the **final audit** reports an issue as UNFIXED, PRR **re-queues** that issue (removes it from verified and re-enters the fix loop) even if a prior iteration had marked it verified. This is **safe over sorry**: we do not trust prior verification over the final audit. The RESULTS SUMMARY and AAR list these as "re-queued: audit said UNFIXED (were previously verified)". See README philosophy ("Safe over sorry verification") and `tools/prr/workflow/analysis.ts` (final audit loop).

## Repo layout

- **`tools/prr/`** — PR Resolver (main CLI): entry point, workflow, GitHub, LLM, state, runners integration.
- **`tools/pill/`** — Program Improvement Log Looker: audit logs, append improvement plans.
- **`tools/split-plan/`** — PR decomposition planner: produces `.split-plan.md`.
- **`tools/split-rewrite-plan/`** — Generate rewrite plan from group plan + repo: ordered ops per split (cherry-pick / commit-from-sha) for split-exec. Optional; when present, split-exec uses it instead of one-commit-per-split.
- **`tools/split-exec/`** — Execute split plan: when a rewrite plan is present, runs its ops and pushes to rebuild branches; when absent, one commit per split from **Files:** (or cherry-picks from **Commits:**). Push, create PRs.
- **`tools/story/`** — PR/branch narrative and changelog.
- **`shared/`** — Shared code: logger, config, git helpers, runners (detect, types), constants.

Entry points: `tools/<tool>/index.ts` (e.g. `tools/prr/index.js` after build). Build output: `dist/tools/<tool>/index.js`.

## Build and test

- **Typecheck (compile to dist/):** `npm run typecheck` or `npx tsc` (or `bun run typecheck`). Use `npm run typecheck:noemit` for type-only check (no emit). Development uses `bun`; CI supports both npm and bun.
- **Tests:** `npm test` or `bun test` (vitest).
- **split-exec:** Requires the plan's **target branch to exist on the remote** (checked before clone). Run from any directory; it clones the plan's repo into the workdir and pre-fetches target and split branch refs (so `pushWithRetry`'s rebase can resolve `origin/<branch>`). Uses `pushWithRetry` (fetch + rebase + retry on push rejection). `pushWithRetry` supports an `onConflict` callback for automatic conflict resolution; split-exec wires a simple handler for `.github/workflows/` files (checkout --theirs). Other conflicts require `--force-push` or manual resolution in the workdir. If the remote branch has newer commits and rebase fails or retries are exhausted, re-run with `--force-push` to overwrite, or resolve manually. On re-runs, splits whose branches already contain the cherry-picked commits report "already up-to-date" — this is expected and does not indicate an error.
- **prr base-branch merge:** For PRs whose base branch differs from the PR branch (e.g. `1.x`, `staging`, `develop`), the base branch is fetched during clone via `additionalBranches`. All base-branch (and `additionalBranches`) fetches use an **explicit refspec** (`+refs/heads/<branch>:refs/remotes/origin/<branch>`) so the tracking ref is always updated. **WHY:** On `--single-branch` clones the default fetch config only includes the PR branch; a plain `git fetch origin <branch>` would not update `origin/<branch>`, leaving a stale ref so the merge-base check incorrectly reports "already up-to-date" and the PR stays "dirty" on GitHub. If you see "ambiguous argument origin/\<branch\>", the base branch was never fetched — check that the remote has the branch and that `additionalBranches` includes it.

## PRR thread replies

With **`--reply-to-threads`** (or **`PRR_REPLY_TO_THREADS=true`**), PRR posts a short reply on each GitHub review thread when it fixes or dismisses an issue (e.g. "Fixed in \`abc1234\`." or "No changes needed — already addressed before this run."). Use **`--resolve-threads`** to also resolve (collapse) threads after replying. Optional **`PRR_BOT_LOGIN`** (GitHub login of the bot that posts replies) enables cross-run idempotency: PRR skips posting if that thread already has a comment from that login. **Note:** Replies need a **real** inline review thread (not synthetic **`ic-*`** issue-comment rows) and a **`databaseId`** on the comment. Recovered-from-git ids are matched **case-insensitively** to GraphQL ids. "Fixed in …" is posted after push when possible, and at **final cleanup** for **`verifiedThisSession`** when push did not run (e.g. `--no-push` / nothing to push).

**WHY opt-in:** Default runs stay fast and unchanged; posting to GitHub is a conscious choice. **WHY one reply per thread:** Keeps noise low and leaves room for human follow-up in the same thread. **WHY fixed replies only after push:** "Fixed in \<sha\>." is posted only when the commit has been successfully pushed (commit-and-push phase), not after incremental pushes. **WHY reply for remaining/exhausted:** We reply for `already-fixed`, `stale`, `not-an-issue`, `false-positive`, and also for `remaining` and `exhausted` with a short "Could not auto-fix; manual review recommended." so threads (e.g. wrong-file exhaust) are not left without any reply. We do not reply for `chronic-failure` and other rare categories. **WHY cross-run idempotency:** Re-runs would otherwise duplicate replies; `PRR_BOT_LOGIN` lets us skip threads we already replied to. Full WHYs: [docs/THREAD-REPLIES.md](docs/THREAD-REPLIES.md).

## Conventions

- **Imports:** Use `.js` extensions in import paths (ES modules), e.g. `from './foo.js'`.
- **User-facing numbers:** Use `formatNumber(n)` from `shared/logger.js` or `n.toLocaleString()` so counts show with comma thousands separators (see `.cursor/rules/number-formatting.mdc`).
- **Paths:** PRR code lives under `tools/prr/` and `shared/`; docs may still say `src/` in places — treat as `tools/prr/` for code. DEVELOPMENT.md’s Architecture Overview diagram uses canonical paths (tools/prr/, shared/); the Key Files table there matches. After path migrations, run `prr --tidy-lessons`; section keys in `.prr/lessons.md` may need manual updates so file-scoped lessons match.

## Docs and rules

- **`.cursor/rules/`** — Cursor rules (e.g. number formatting, audit-cycle template, canonical paths, **docs-no-new-md**: do not create new `.md` files until you have checked existing docs for an appropriate place; see rule).
- **`tools/prr/AUDIT-CYCLES.md`** — PRR audit log; when adding a cycle, use the template, bump "Recorded cycles", and add the new cycle under "Recorded cycles" (newest first).
- **`DEVELOPMENT.md`** — Developer guide, key files, run locally (`bun dist/tools/prr/index.js …`). **Fix-loop audit content** (pain points, thresholds, rationale) lives in DEVELOPMENT.md "Fix loop audits (output.log)", not in standalone audit files.
- **No standalone audit .md:** Integrate audit findings and run context into DEVELOPMENT.md and AUDIT-CYCLES.md; only add a new doc when the content has no proper home (see `.cursor/rules/docs-no-new-md.mdc`).

## Quick file map

| Concern            | Location |
|--------------------|----------|
| PRR CLI            | `tools/prr/index.ts`, `tools/prr/cli.ts` |
| PRR orchestration  | `tools/prr/resolver.ts`, `tools/prr/workflow/` |
| GitHub API         | `tools/prr/github/api.ts` |
| LLM / rotation     | `tools/prr/llm/`, `tools/prr/models/rotation.ts`, `shared/llm/` (rate-limit, model-context-limits, elizacloud) |
| Catalog model advice (dismiss + auto-heal) | `tools/prr/workflow/helpers/outdated-model-advice.ts`, `tools/prr/workflow/catalog-model-autoheal.ts`, `shared/model-catalog.ts`, `generated/model-provider-catalog.json` |
| State, lessons      | `tools/prr/state/` |
| Split plan (planner)   | `tools/split-plan/` |
| Split rewrite plan    | `tools/split-rewrite-plan/` (generates `.split-rewrite-plan.yaml` from group plan + clone) |
| Split exec (runner)   | `tools/split-exec/` (branch/PR logic: `run.ts`; optional rewrite plan → rebuild branches, else one commit per split) |
| Shared logger      | `shared/logger.ts` |
| Shared config      | `shared/config.ts` |
| Shared git         | `shared/git/` |
