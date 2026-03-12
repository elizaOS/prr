# split-plan — PR decomposition planner

Analyze a large pull request and output a human-editable decomposition plan (`.split-plan.md`). The plan identifies dependencies between changes, proposes how to split the PR into focused units, and can route changes to existing open PRs. The plan file is intended for human review and editing, and will be consumed by `split-exec` (future) or executed manually.

## Why split-plan exists

- **Large PRs from agents:** LLM agents often produce PRs that mix refactors, features, and fixes. Humans can't review them effectively. split-plan analyzes diffs and commit structure to propose a decomposition into reviewable units.
- **Branch topology:** Only open PRs targeting the same base branch are shown as "buckets"; a PR into `v2` won't suggest routing changes to a PR into `v3`. **WHY:** A PR to `v2-develop` and a PR to `v3-develop` live in different worlds; changes don't apply across branch lineages.
- **Dependencies first:** The tool asks the LLM to identify which changes depend on which, then constrains the split so dependent changes stay together or merge in order. **WHY:** Without that, the model groups by file proximity and can propose splits that break build or logic (e.g. "new PR with caller only" while the callee is in another PR).

## Input and output

- **Input:** PR URL only (e.g. `https://github.com/owner/repo/pull/123` or `owner/repo#123`). **WHY no branch spec:** Decomposition only makes sense for an existing PR; we need PR metadata, commits, and file list from the GitHub PR API.
- **Output:** A markdown file (default: `.split-plan.md`) with YAML frontmatter (`source_pr`, `source_branch`, `target_branch`, `generated_at`), a **Dependencies** section, a **Split** section (per proposed PR: route to existing or new, files, commits, rationale), and **Merge order**. **WHY default to file:** The plan is meant to be edited before execution; writing to a file is the primary workflow. A future `split-exec` will read this file.

## Usage

```bash
# Default: write to .split-plan.md in cwd
split-plan https://github.com/owner/repo/pull/123
split-plan owner/repo#456

# Custom output path
split-plan owner/repo#456 --output my-plan.md

# Verbose (debug and prompt/response logs)
split-plan owner/repo#123 -v

# Cap patch content in prompt (chars) for very large PRs
split-plan owner/repo#123 --max-patch-chars 80000
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <file>` | `.split-plan.md` | Write the plan to this file. **WHY default in cwd:** Same as story; user can override for a named plan (e.g. `pr-123-plan.md`). |
| `-v, --verbose` | off | Enable debug logs and prompt/response files under `~/.prr/debug/<timestamp>`. |
| `--max-patch-chars <n>` | 120000 | Max total patch content (chars) included in the LLM prompt. Files are sorted by change size; patches are included until the budget is exceeded. **WHY:** Full diffs for 50+ files can exceed 200k chars and blow context or cause timeouts; capping keeps prompts bounded while still prioritizing the largest changes. |

## PR title style (repo vibe)

split-plan fetches **recent closed/merged PR titles** from the repo and asks the LLM to summarize the style (e.g. conventional commits, length, ticket refs). That summary is injected into the plan-generation prompt so the model outputs **PR title:** per split in the repo's vibe. split-exec then uses that for the GitHub PR title and commit message. If there are no recent PRs or the style call fails, the plan still works; splits just won't have **PR title:** and will use the section heading instead.

## Why we cap open PRs and patch size

- **Open PRs:** We fetch only open PRs targeting the same base branch, then cap at 20 and truncate each PR body to 500 chars. **WHY:** A busy repo can have 100+ open PRs; including them all would blow the context window. Twenty buckets and a short description are enough for "route to this existing PR" decisions. The prompt states "showing up to 20" so the model knows the list may be truncated.
- **Patch budget:** We sort changed files by `additions + deletions` (largest first), then include patch content until `--max-patch-chars` is reached. Remaining files appear as metadata only with "[patch omitted — budget exceeded]". **WHY:** The largest diffs are where concern boundaries are ambiguous; small changes are often obvious from filename and commit message. We never drop files from the list—only patch content—so the model always sees the full file list.

## Why low-signal files are listed but not patched

Lockfiles (`package-lock.json`, `bun.lock`, `yarn.lock`, `*.lock`), `*.min.js`, and `*.min.css` are listed in the prompt with metadata (path, status, +/- lines) but their patch content is never included. **WHY:** They consume huge patch budget without helping the model reason about *concerns* (refactor vs feature vs config). The model still sees that they changed (e.g. dependency bumps) but we don't spend context on their diffs.

## Model note

Prefer a capable model (e.g. Sonnet-level or equivalent). Dependency analysis and structured output benefit from stronger reasoning. If using a small or low-param model, treat the output as a draft: expect missed dependencies or inconsistent structure, and review the plan before executing. **WHY:** Low-param models often skip Phase 1 (dependencies) or output a single "no dependencies" line; the split plan then ignores dependency order.

## Configuration

Same as prr: `GITHUB_TOKEN` plus one of `ELIZACLOUD_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. Optional: `PRR_LLM_PROVIDER`, `PRR_LLM_MODEL`. See root [README](../../README.md) and [.env.example](../../.env.example).

**SPLIT_PLAN_LLM_MODEL:** When set, split-plan uses this model for both phases. When unset, split-plan uses the provider's **fast/cheap model** (e.g. gpt-4o-mini, claude-haiku) by default to reduce gateway 504 timeouts on large PRs. Set `SPLIT_PLAN_LLM_MODEL` if you want a stronger model and accept longer runs or use a smaller `--max-patch-chars`.

## Two-phase LLM flow

split-plan uses **two LLM calls** to avoid 504 timeouts on large PRs:
1. **Phase 1 — Dependencies:** Full PR (commits, file list with patches) → model outputs only the `## Dependencies` section. Response is small.
2. **Phase 2 — Split plan:** Dependencies text + file list **without patches** + open PRs → model outputs the full plan (frontmatter, Dependencies, Split, Merge order). No patches in this prompt keeps it smaller.

By default the **fast/cheap model** is used (see SPLIT_PLAN_LLM_MODEL above). You can override with a stronger model if needed.

## Troubleshooting

**504 / "An error occurred with your deployment"** — The LLM gateway timed out. Try:
1. **Re-run** — Often transient.
2. **Reduce prompt size:** `--max-patch-chars 60000` (or `80000`) so Phase 1 sends less patch content.
3. By default split-plan uses the fast model and two-phase flow; if you set `SPLIT_PLAN_LLM_MODEL` to a heavy model, consider unsetting it or using a smaller `--max-patch-chars`.
4. The client retries 504 up to 4 times with backoff before failing.

## Log files

- **split-plan-output.log** — Console output tee (same directory as run, or `PRR_LOG_DIR`). **WHY prefix:** So split-plan and prr/story/pill don't overwrite each other's logs when run from the same directory (see shared logger `prefix`).
- **split-plan-prompts.log** — Full prompts and responses when the LLM is called.
- With `-v`, **~/.prr/debug/<timestamp>/** — Per-request prompt/response files.

## Plan file format (for humans and split-exec)

The plan is markdown with YAML frontmatter. **WHY markdown not JSON:** Humans will edit it; markdown is readable and the future `split-exec` can use a forgiving LLM-assisted parser. Frontmatter is validated/repaired on write: if the LLM outputs invalid YAML, we replace it with safe values from the PR and `generated_at` from code so the file is always usable.

## Validation section

If the LLM references file paths in the plan that are not in the PR's file list, we append a **## Validation** section: "Warning: these paths were not in the PR: …". If any PR file is not in any split's **Files:** list, we add "These files were in the PR but not assigned to any split: …". We don't strip paths so human-added references aren't removed; we only warn.

## Audit cycles

Audits of split-plan runs (output log, prompts log, plan quality) are recorded in **AUDIT-CYCLES.md** (this folder). Use it to spot recurring patterns and regression checks, same as PRR's [tools/prr/AUDIT-CYCLES.md](../prr/AUDIT-CYCLES.md).
