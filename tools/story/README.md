# story — PR and branch narrative & changelog

Build a human-readable narrative, feature catalog, and changelog (Added / Changed / Fixed / Removed) from a GitHub PR or branch. Accepts a PR URL, a single branch (commit history only), or two branches (compare and tell the story from older → newer). Uses the same config as prr (GITHUB_TOKEN + LLM provider).

## Why story exists

- **Large PRs**: Manually summarizing hundreds of commits and files is tedious; an LLM can infer themes and produce a coherent changelog.
- **Branches without a PR**: You may want a narrative for a branch that was never opened as a PR (e.g. long-lived `v2-develop`). Single-branch mode uses the branch’s commit history only; no comparison to default.
- **Two branches**: When you pass `--compare <other>`, story determines which branch is older/newer and tells the story of the **primary** branch (the one in the URL), so the narrative is about “what happened here” rather than the other branch.

## Modes

| Mode | Input | What is fetched | Output |
|------|--------|------------------|--------|
| **PR** | PR URL (`owner/repo#123` or full URL) | PR title/body, commits, files | Narrative + features + changelog from PR + commits + files |
| **Single branch** | Branch spec (e.g. `owner/repo@branch`, tree URL) | Commit history on that branch (oldest → newest, up to 500) | Narrative + features + changelog from commits only (no file list) |
| **Two branches** | Branch spec + `--compare <branch>` | Compare API: commits and files from older ref to newer ref; primary branch (URL) is preferred as “newer” when both have commits | Narrative + features + changelog from commits + files |

**Why single-branch has no file list:** A branch may be behind the default (e.g. `v2-develop` behind `develop`). Comparing to default would yield 0 commits. Listing the branch’s commit history (via List Commits API) always gives a story; file-diff would require picking another base and is optional.

**Why we prefer the primary branch in two-branch mode:** The first argument is the branch the user cares about. If both directions have commits (diverged), we use the direction where that branch is the “newer” ref so the narrative describes what happened on it, not on the other branch.

## Usage

```bash
# PR
story https://github.com/owner/repo/pull/123
story owner/repo#456

# Single branch (commit history only)
story owner/repo@v2-develop
story https://github.com/owner/repo/tree/v2-develop

# Two branches (primary branch = first arg; order auto-detected, story = primary’s story)
story https://github.com/owner/repo/tree/v2-develop --compare v1-develop
story owner/repo@v2-develop --compare https://github.com/owner/repo/tree/v1-develop

# Output to file
story owner/repo#456 --output CHANGELOG.md

# Verbose (debug + prompt/response logs under ~/.prr/debug/<timestamp>)
story owner/repo@branch -v

# Cap context size for huge PRs/branches
story owner/repo@branch --max-commits 200 --max-files 500
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <file>` | stdout | Write narrative and changelog to a file. |
| `-v, --verbose` | off | Enable debug logs and prompt/response files under `~/.prr/debug/<timestamp>`. |
| `--max-commits <n>` | 150 | Max commit lines sent to the LLM. For single-branch, if total ≤ this we send all; otherwise first/last halves with “… N more …” in between. **Why:** Keeps prompt size bounded for very long histories. |
| `--max-files <n>` | 400 | Max file paths sent to the LLM; rest summarized as “… and N more files”. **Why:** Avoids blowing context on repos with thousands of changed files. |
| `--compare <branch>` | — | (Branch mode only.) Second branch: name (`v1-develop`), `owner/repo@branch`, or tree URL. Same repo required. Order is auto-detected; narrative is from older → newer, preferring the primary branch as “newer” when diverged. |

## Log files

- **story-output.log** — Console output tee (same directory as run, or `PRR_LOG_DIR`). **Why:** Separate from prr’s `output.log` so story and prr don’t overwrite each other (see shared logger `prefix`).
- **story-prompts.log** — Full prompts and responses when the LLM is called (same format as prr’s prompts.log).
- With `-v`, **~/.prr/debug/<timestamp>/** — Per-request prompt/response files for inspection.

## Configuration

Same as prr: `GITHUB_TOKEN` plus one of `ELIZACLOUD_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. Optional: `PRR_LLM_PROVIDER`, `PRR_LLM_MODEL`. See root [README](../../../README.md) and [.env.example](../../.env.example).

## Input formats

- **PR:** `https://github.com/owner/repo/pull/123`, `owner/repo#123`
- **Branch:** `owner/repo@branch`, `owner/repo:branch`, `https://github.com/owner/repo/tree/branch` (branch may contain `/`; query/fragment stripped)

**Why support tree URL for branch:** Users often paste the browser URL for a branch; accepting it avoids “invalid input” and we normalize to branch name before calling the GitHub API.

**Why normalize `--compare` to a branch name:** The compare API expects ref names (e.g. `v1-develop`), not full URLs. If the user passes a tree URL for `--compare`, we parse it and pass only the branch name so the API doesn’t return 404.
