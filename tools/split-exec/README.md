# split-exec — Execute a split plan

Reads a `.split-plan.md` file (from **split-plan**), clones the repository at the source branch, then **iteratively** executes each split: checkout the target branch (existing PR branch or a new branch from base), cherry-pick the listed commits, push, and create a new pull request when the plan says "New PR". Processes one split at a time so you can fix conflicts or stop between splits.

## Why split-exec exists

- **Automate the plan:** split-plan only writes the plan; split-exec performs the git operations and opens PRs so you don't have to cherry-pick and push by hand.
- **Iterative/slow:** One split at a time. If a cherry-pick conflicts, the tool stops and tells you where; you resolve in the workdir and can re-run or edit the plan. **WHY:** Batch execution would leave the repo in a hard-to-recover state on the first conflict.
- **New PRs only:** When the plan says "New PR: `branch-name`", split-exec creates that branch from the target base, cherry-picks, pushes, and opens a new PR via the GitHub API.
- **Route-to is disabled:** "Route to: PR #42" splits are rejected at runtime. Modifying an existing PR's branch (cherry-pick + push) is too risky — if anything goes wrong the PR is corrupted. Use "New PR" splits instead and close the old PR after merge.

## Prerequisites

- **Target branch must exist on the remote.** split-exec checks this before cloning (fail-fast). If the plan's `target_branch` (e.g. `staging`) does not exist on the repo, create it first or change the plan. You can run split-exec from any directory; it clones the plan's repo (from `source_pr`) into the workdir.

## Input

- **Plan file:** Path to a `.split-plan.md` produced by split-plan (or edited by hand). The file must have YAML frontmatter with `source_pr`, `source_branch`, `target_branch`, and a **## Split** section with `### N. Title`, **New PR:** `branch-name`, optional **PR title:** or **Title:** (used for commit message and GitHub PR title — use repo-style e.g. `feat: add PRR workflow`), **Files:** (recommended) or **Commits:** for each split.

## Usage

```bash
# Execute the plan (clone, cherry-pick, push, create PRs)
split-exec .split-plan.md

# Use a custom workdir (default: .split-exec-workdir in cwd)
split-exec .split-plan.md --workdir /tmp/split-work

# Dry run: parse plan and print what would be done; no clone/push
split-exec .split-plan.md --dry-run

# Force-push when remote has diverged (overwrite remote branches)
split-exec .split-plan.md --force-push

# Run pill analysis on the output log when the run finishes
split-exec .split-plan.md --pill

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
| `--force-push` | off | On push rejection (remote has newer commits), force-push to overwrite the remote branch. **WHY:** Use when re-running a plan and your local split branches are the source of truth (e.g. after fixing commits). |
| `--pill` | off | When the run finishes, run pill analysis on the output log and append to pill-output.md / pill-summary.md. **WHY:** Split-exec has no LLM calls; passing `--pill` lets you still get operational improvement suggestions from the log. |

## Exit codes (for CI / automation)

| Code | Meaning |
|------|--------|
| `0` | Success: one or more splits were pushed (or dry-run completed). |
| `2` | All executed splits were already up-to-date (remote had the commits; nothing pushed). Use this to distinguish "no work done" from "changes pushed". |
| non-zero | One or more splits failed (e.g. cherry-pick conflict, push failed). |

## Flow (per split)

1. **New PR (file-based, recommended):** If the split lists **Files:**, the tool copies only those files from the source branch into the new branch and creates **one new commit** (split title). No cherry-pick — so each PR contains only the intended changes (e.g. workflow-only or ticker-only).
2. **New PR (cherry-pick):** If the split lists only **Commits:**, the tool cherry-picks those commits in order. Note: cherry-pick is all-or-nothing per commit; a commit that touches multiple areas will bring all changes into that PR.
3. **Route to PR #N:** **Disabled.** Use "New PR" and close the old PR after merge.

**PR titles:** The GitHub PR title (and the file-based commit message) use **PR title:** or **Title:** from the plan when present; otherwise the split heading (e.g. `### 1. PRR Workflow Infrastructure`). To match the repo's style (e.g. conventional commits like `chore: add PRR workflow`), add a line such as `- **PR title:** \`chore: add PRR workflow\`` to each split.

If any cherry-pick fails (e.g. conflict), the tool aborts the cherry-pick, prints the workdir path, and exits. You can resolve conflicts in the workdir, then re-run (the tool will re-clone or you can skip that split by editing the plan).

## Configuration

Requires **GITHUB_TOKEN** with repo scope (clone, push, create PR). Same as prr; see root [README](../../README.md) and [.env.example](../../.env.example). No LLM is used.

**Token check:** Before cloning, split-exec verifies the token by calling the GitHub API (`getDefaultBranch`). If the token is invalid or the account has no access to the repo, you get a clear error and no splits run. **WHY:** Failing early avoids clone + first-push failure with a raw "Authentication failed" from git.

**Push auth:** Push uses the same URL format as the initial `git ls-remote` check (`https://${token}@...`) so clone and push behave consistently. If push still fails with "Invalid username or token", create a new token at https://github.com/settings/tokens with **repo** scope and set `GITHUB_TOKEN` in `.env`.

## Output and PR URLs

- Each split prints a one-line status (`[n] Pushed` or `[n] Already up-to-date`) and, when a PR exists, the PR URL on the next line (in cyan).
- The final summary repeats all PR URLs in one line: **Open PRs:** (when all splits were already up-to-date) or **PRs:** (when some were pushed). **WHY:** So you can copy links from one place even when skimming the log.

## Log files

- **split-exec-output.log** — Console output tee (same directory as run, or `PRR_LOG_DIR`). **WHY prefix:** So split-exec and split-plan/prr don't overwrite each other's logs.

## Troubleshooting

### "Target branch X does not exist on remote"

The target branch is checked **once upfront** (before cloning). If it's missing, you get one error and no splits run. The plan's `target_branch` (e.g. `staging`) is not present on the remote. Either:

1. **Create the branch on the remote:** e.g. push an initial commit to `staging` from another clone, or create it in the GitHub UI.
2. **Change the plan:** Edit `.split-plan.md` frontmatter and set `target_branch` to an existing branch (e.g. `main`).
3. **Manual fetch (if the branch exists but ls-remote failed):** From the workdir printed in the error, run: `cd <workdir> && git fetch origin <target-branch>`.

### "Push rejected and rebase has conflicts in: ..."

This happens when the remote branch was modified after the plan was generated (e.g. someone pushed to the same branch). The tool fetches and rebases; if there are conflicts it tries to resolve them (e.g. `.github/workflows/` files via `checkout --theirs`). If resolution fails or conflicts are in other files:

1. **Re-run with `--force-push`** to overwrite the remote branch (use when your split is the source of truth).
2. **Resolve manually:** The error message includes the workdir and a `git add ... && git rebase --continue` command. Resolve the conflicted files in that workdir, then run the command and push (or re-run split-exec).
3. **Re-generate the plan** if the remote branch has diverged enough that merging no longer makes sense.
