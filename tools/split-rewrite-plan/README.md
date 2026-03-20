# split-rewrite-plan — Generate rewrite plan from group plan and repo

Reads a `.split-plan.md` (group plan from **split-plan**), clones or uses an existing workdir, analyzes commits on the source branch since the target branch, and writes a **rewrite plan** (`.split-rewrite-plan.yaml` or `.json`) with ordered ops per split. **split-exec** can then run that plan to build clean per-split history (cherry-pick or commit-from-sha) on rebuild branches.

## Why this tool exists

- **split-plan** produces only the group plan (which files go to which split); it does not clone the repo.
- **split-rewrite-plan** clones (or uses a workdir), runs `git log target..source --first-parent`, and for each commit maps changed paths to splits. Commits that touch one split become a single cherry-pick op; commits that touch multiple splits become one commit-from-sha op per split with that split’s paths. **WHY:** So each split branch gets a **linear history** that only touches that split’s files.
- **split-exec** executes the rewrite plan when present; without it, split-exec does the bare minimum (one commit per split from **Files:**). **WHY separate tool:** split-plan stays clone-free (no git ops); the generator needs a clone to analyze commits, so it lives in its own tool.

## Prerequisites

- **Group plan** with **Files:** (and **New PR:**) per split. The generator builds a file→split map from **Files:**; commits are assigned to splits based on which files they touch.
- **GITHUB_TOKEN** with repo scope (for clone). Same as split-exec; see root README and `.env.example`.

## Usage

```bash
# Generate rewrite plan (default output: .split-rewrite-plan.yaml beside the group plan)
split-rewrite-plan .split-plan.md

# Custom workdir (default: .split-rewrite-plan-workdir in cwd; use same as split-exec to reuse clone)
split-rewrite-plan .split-plan.md --workdir .split-exec-workdir

# Custom output path
split-rewrite-plan .split-plan.md --output .split-rewrite-plan.json

# Verbose (warnings for skipped commits, empty splits)
split-rewrite-plan .split-plan.md -v
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --plan-file <path>` | (positional) | Path to `.split-plan.md`. |
| `-w, --workdir <dir>` | `.split-rewrite-plan-workdir` | Git workdir; clone here if not already a repo. Use the same workdir as split-exec to avoid a second clone. |
| `-o, --output <path>` | beside group plan, `.split-rewrite-plan.yaml` | Output path for the rewrite plan. |
| `-v, --verbose` | off | Verbose logging (e.g. skipped commits, empty splits). |

## Warnings

- **Commit touches only unassigned files:** Skipped and (with `-v`) logged. **WHY:** Those paths are not in any split’s **Files:**.
- **File in multiple splits:** First occurrence in the plan wins; a warning is printed. **WHY:** Each file must map to exactly one split so we don't emit the same path in two commit-from-sha ops (which would duplicate changes on two branches).
- **Split has zero ops:** No commit touched that split’s files; the split is still emitted with an empty `ops` array; split-exec skips it with a one-line warning. **WHY:** We emit all group-plan splits so the rewrite plan's structure matches the group plan; the executor knows to skip empty ones.

## Pipeline

1. **split-plan** → produces `.split-plan.md` (group plan with **Files:** per split).
2. **split-rewrite-plan** → produces `.split-rewrite-plan.yaml` (ordered ops per split).
3. **split-exec** → with rewrite plan, runs ops and pushes to rebuild branches; optionally `--promote` to force-push rebuild over original.

If the source branch moves after step 2, split-exec will refuse to run the rewrite plan (staleness check). **WHY:** The plan's `source_tip_sha` pins the source state it was built from; applying it to a different tip would produce wrong branches. Re-run split-rewrite-plan to regenerate.
