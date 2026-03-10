# split-exec — Execute a split plan

Reads a `.split-plan.md` file (from **split-plan**), clones the repository at the source branch, then **iteratively** executes each split: checkout the target branch (existing PR branch or a new branch from base), cherry-pick the listed commits, push, and create a new pull request when the plan says "New PR". Processes one split at a time so you can fix conflicts or stop between splits.

## Why split-exec exists

- **Automate the plan:** split-plan only writes the plan; split-exec performs the git operations and opens PRs so you don't have to cherry-pick and push by hand.
- **Iterative/slow:** One split at a time. If a cherry-pick conflicts, the tool stops and tells you where; you resolve in the workdir and can re-run or edit the plan. **WHY:** Batch execution would leave the repo in a hard-to-recover state on the first conflict.
- **Route to existing PRs:** When the plan says "Route to: PR #42", split-exec checks out that PR's branch, cherry-picks the listed commits, and pushes so the existing PR gets the new commits.
- **New PRs:** When the plan says "New PR: `branch-name`", split-exec creates that branch from the target base, cherry-picks, pushes, and opens a new PR via the GitHub API.

## Input

- **Plan file:** Path to a `.split-plan.md` produced by split-plan (or edited by hand). The file must have YAML frontmatter with `source_pr`, `source_branch`, `target_branch`, and a **## Split** section with `### N. Title`, **Route to:** or **New PR:**, and **Commits:** for each split.

## Usage

```bash
# Execute the plan (clone, cherry-pick, push, create PRs)
split-exec .split-plan.md

# Use a custom workdir (default: .split-exec-workdir in cwd)
split-exec .split-plan.md --workdir /tmp/split-work

# Dry run: parse plan and print what would be done; no clone/push
split-exec .split-plan.md --dry-run

# Verbose
split-exec .split-plan.md -v
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-w, --workdir <dir>` | `.split-exec-workdir` | Directory used for the git clone and cherry-picks. **WHY:** So you can inspect or fix the repo between runs; default is in cwd so it's easy to find. |
| `-n, --dry-run` | off | Parse the plan and print each split (commits, route-to or new-PR); do not clone, cherry-pick, or push. |
| `-y, --yes` | off | Reserved for future per-split confirmation; currently unused. |
| `-v, --verbose` | off | Verbose logging. |

## Flow (per split)

1. **Route to PR #N:** Check out that PR's branch (e.g. `auth-cleanup`), hard-reset to `origin/branch`, cherry-pick each listed commit in order, push to `origin/branch`.
2. **New PR:** Create a new branch from `origin/target_branch`, cherry-pick each listed commit, push the new branch, then call the GitHub API to create a pull request (head = new branch, base = target branch, title from the split title).

If any cherry-pick fails (e.g. conflict), the tool aborts the cherry-pick, prints the workdir path, and exits. You can resolve conflicts in the workdir, then re-run (the tool will re-clone or you can skip that split by editing the plan).

## Configuration

Requires **GITHUB_TOKEN** with repo scope (clone, push, create PR). Same as prr; see root [README](../../README.md) and [.env.example](../../.env.example). No LLM is used.

## Log files

- **split-exec-output.log** — Console output tee (same directory as run, or `PRR_LOG_DIR`). **WHY prefix:** So split-exec and split-plan/prr don't overwrite each other's logs.
