# Guide for AI coding agents

This file helps AI assistants (Cursor, Claude Code, Aider, etc.) work effectively in this repo.

## Generated artifacts (not committed)

These are created by tools and should not be committed: `.split-plan.md`, `.split-exec-workdir/`, `split-exec-output.log`, `split-exec-prompts.log`, `split-plan-output.log`, `split-plan-prompts.log`, `pill-output.md`, `pill-summary.md`, `output.log`, `prompts.log`. See `.gitignore`.

## Repo layout

- **`tools/prr/`** — PR Resolver (main CLI): entry point, workflow, GitHub, LLM, state, runners integration.
- **`tools/pill/`** — Program Improvement Log Looker: audit logs, append improvement plans.
- **`tools/split-plan/`** — PR decomposition planner: produces `.split-plan.md`.
- **`tools/split-exec/`** — Execute split plan: cherry-pick, push, create PRs.
- **`tools/story/`** — PR/branch narrative and changelog.
- **`shared/`** — Shared code: logger, config, git helpers, runners (detect, types), constants.

Entry points: `tools/<tool>/index.ts` (e.g. `tools/prr/index.js` after build). Build output: `dist/tools/<tool>/index.js`.

## Build and test

- **Typecheck (compile to dist/):** `npm run typecheck` or `npx tsc`. Use `npm run typecheck:noemit` for type-only check (no emit).
- **Tests:** `npm test` (vitest).
- **split-exec:** Requires the plan's **target branch to exist on the remote** (checked before clone). Run from any directory; it clones the plan's repo into the workdir and pre-fetches target and split branch refs (so `pushWithRetry`'s rebase can resolve `origin/<branch>`). Uses `pushWithRetry` (fetch + rebase + retry on push rejection). `pushWithRetry` supports an `onConflict` callback for automatic conflict resolution; split-exec wires a simple handler for `.github/workflows/` files (checkout --theirs). Other conflicts require `--force-push` or manual resolution in the workdir. If the remote branch has newer commits and rebase fails or retries are exhausted, re-run with `--force-push` to overwrite, or resolve manually. On re-runs, splits whose branches already contain the cherry-picked commits report "already up-to-date" — this is expected and does not indicate an error.
- **prr base-branch merge:** For PRs whose base branch differs from the PR branch (e.g. `1.x`, `staging`, `develop`), the base branch is fetched during clone via `additionalBranches`. If the ref is still missing (e.g. `--single-branch` clone), `mergeBaseBranch` and the base-merge workflow add the refspec and retry. An "ambiguous argument origin/\<branch\>" error means the base branch was never fetched — check that the remote has the branch and that `additionalBranches` includes it.

## Conventions

- **Imports:** Use `.js` extensions in import paths (ES modules), e.g. `from './foo.js'`.
- **User-facing numbers:** Use `formatNumber(n)` from `shared/logger.js` or `n.toLocaleString()` so counts show with comma thousands separators (see `.cursor/rules/number-formatting.mdc`).
- **Paths:** PRR code lives under `tools/prr/` and `shared/`; docs may still say `src/` in places — treat as `tools/prr/` for code. After path migrations, run `prr --tidy-lessons`; section keys in `.prr/lessons.md` may need manual updates so file-scoped lessons match.

## Docs and rules

- **`.cursor/rules/`** — Cursor rules (e.g. number formatting, audit-cycle template, canonical paths).
- **`docs/AUDIT-CYCLES.md`** — Audit log; when adding a cycle, use the template, bump "Recorded cycles", and add the new cycle under "Recorded cycles" (newest first).
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
