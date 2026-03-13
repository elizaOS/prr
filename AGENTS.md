# Guide for AI coding agents

This file helps AI assistants (Cursor, Claude Code, Aider, etc.) work effectively in this repo.

## Generated artifacts (not committed)

These are created by tools and should not be committed: `.split-plan.md`, `.split-exec-workdir/` (clone workdir for split-exec), `split-exec-output.log`, `split-exec-prompts.log`, `split-plan-output.log`, `split-plan-prompts.log`, `pill-output.md`, `pill-summary.md`, `output.log`, `prompts.log`. See `.gitignore`.

**Pill hook:** Pill runs on close only when the user passes **`--pill`** on the command line. **prr**, **split-exec**, **story**, and **split-plan** accept `--pill`; after parsing, they call `setPillEnabled(true)`. Then `closeOutputLog()` runs pill on the closed logs (and writes pill-output.md / pill-summary.md). When `--pill` is not passed, pill does not run. **WHY opt-in:** Default runs stay fast; tools like split-exec have no LLM calls, so pill would often have nothing to analyze. When `--pill` is set, pill runs if the output log has content or the prompts log has PROMPT/RESPONSE/ERROR entries.

**prompts.log:** When output logging is active (e.g. prr with default --verbose), `prompts.log` (or `{prefix}-prompts.log`) is written with full prompt and response text between structural markers (PROMPT #NNNN, RESPONSE #NNNN). Content is written by `shared/logger.ts` (`writeToPromptLog`). Entries with zero content between markers indicate a logging bug and should be reported or investigated; pill and audit cycles rely on this content. When using a **subprocess runner** (e.g. llm-api), that process may not call `initOutputLog`, so its prompts can appear in `output.log` (e.g. `PROMPT #0001 → { chars: N }`) but not in `prompts.log`; set `PRR_DEBUG_PROMPTS=1` to get per-prompt files under `~/.prr/debug/` which may have content even when prompts.log is empty.

## Repo layout

- **`tools/prr/`** — PR Resolver (main CLI): entry point, workflow, GitHub, LLM, state, runners integration.
- **`tools/pill/`** — Program Improvement Log Looker: audit logs, append improvement plans.
- **`tools/split-plan/`** — PR decomposition planner: produces `.split-plan.md`.
- **`tools/split-exec/`** — Execute split plan: cherry-pick, push, create PRs.
- **`tools/story/`** — PR/branch narrative and changelog.
- **`shared/`** — Shared code: logger, config, git helpers, runners (detect, types), constants.

Entry points: `tools/<tool>/index.ts` (e.g. `tools/prr/index.js` after build). Build output: `dist/tools/<tool>/index.js`.

## Build and test

- **Typecheck (compile to dist/):** `npm run typecheck` or `npx tsc` (or `bun run typecheck`). Use `npm run typecheck:noemit` for type-only check (no emit). Development uses `bun`; CI supports both npm and bun.
- **Tests:** `npm test` or `bun test` (vitest).
- **split-exec:** Requires the plan's **target branch to exist on the remote** (checked before clone). Run from any directory; it clones the plan's repo into the workdir and pre-fetches target and split branch refs (so `pushWithRetry`'s rebase can resolve `origin/<branch>`). Uses `pushWithRetry` (fetch + rebase + retry on push rejection). `pushWithRetry` supports an `onConflict` callback for automatic conflict resolution; split-exec wires a simple handler for `.github/workflows/` files (checkout --theirs). Other conflicts require `--force-push` or manual resolution in the workdir. If the remote branch has newer commits and rebase fails or retries are exhausted, re-run with `--force-push` to overwrite, or resolve manually. On re-runs, splits whose branches already contain the cherry-picked commits report "already up-to-date" — this is expected and does not indicate an error.
- **prr base-branch merge:** For PRs whose base branch differs from the PR branch (e.g. `1.x`, `staging`, `develop`), the base branch is fetched during clone via `additionalBranches`. If the ref is still missing (e.g. `--single-branch` clone), `mergeBaseBranch` and the base-merge workflow add the refspec and retry. An "ambiguous argument origin/\<branch\>" error means the base branch was never fetched — check that the remote has the branch and that `additionalBranches` includes it.

## PRR thread replies

With **`--reply-to-threads`** (or **`PRR_REPLY_TO_THREADS=true`**), PRR posts a short reply on each GitHub review thread when it fixes or dismisses an issue (e.g. "Fixed in \`abc1234\`." or "No changes needed — already addressed before this run."). Use **`--resolve-threads`** to also resolve (collapse) threads after replying. Optional **`PRR_BOT_LOGIN`** (GitHub login of the bot that posts replies) enables cross-run idempotency: PRR skips posting if that thread already has a comment from that login.

**WHY opt-in:** Default runs stay fast and unchanged; posting to GitHub is a conscious choice. **WHY one reply per thread:** Keeps noise low and leaves room for human follow-up in the same thread. **WHY only some dismissal categories get a reply:** We reply for `already-fixed`, `stale`, `not-an-issue`, `false-positive`; we do not reply for `exhausted`, `remaining`, `chronic-failure` so "gave up" / "needs human" threads stay low-noise. **WHY cross-run idempotency:** Re-runs would otherwise duplicate replies; `PRR_BOT_LOGIN` lets us skip threads we already replied to. Full WHYs: [docs/THREAD-REPLIES.md](docs/THREAD-REPLIES.md).

## Conventions

- **Imports:** Use `.js` extensions in import paths (ES modules), e.g. `from './foo.js'`.
- **User-facing numbers:** Use `formatNumber(n)` from `shared/logger.js` or `n.toLocaleString()` so counts show with comma thousands separators (see `.cursor/rules/number-formatting.mdc`).
- **Paths:** PRR code lives under `tools/prr/` and `shared/`; docs may still say `src/` in places — treat as `tools/prr/` for code. DEVELOPMENT.md’s Architecture Overview diagram uses canonical paths (tools/prr/, shared/); the Key Files table there matches. After path migrations, run `prr --tidy-lessons`; section keys in `.prr/lessons.md` may need manual updates so file-scoped lessons match.

## Docs and rules

- **`.cursor/rules/`** — Cursor rules (e.g. number formatting, audit-cycle template, canonical paths).
- **`tools/prr/AUDIT-CYCLES.md`** — PRR audit log; when adding a cycle, use the template, bump "Recorded cycles", and add the new cycle under "Recorded cycles" (newest first).
- **`DEVELOPMENT.md`** — Developer guide, key files, run locally (`bun dist/tools/prr/index.js …`).

## Quick file map

| Concern            | Location |
|--------------------|----------|
| PRR CLI            | `tools/prr/index.ts`, `tools/prr/cli.ts` |
| PRR orchestration  | `tools/prr/resolver.ts`, `tools/prr/workflow/` |
| GitHub API         | `tools/prr/github/api.ts` |
| LLM / rotation     | `tools/prr/llm/`, `tools/prr/models/rotation.ts`, `shared/llm/` (rate-limit, model-context-limits, elizacloud) |
| State, lessons      | `tools/prr/state/` |
| Split plan (planner)| `tools/split-plan/` |
| Split exec (runner) | `tools/split-exec/` (branch/PR logic: `run.ts`) |
| Shared logger      | `shared/logger.ts` |
| Shared config      | `shared/config.ts` |
| Shared git         | `shared/git/` |
