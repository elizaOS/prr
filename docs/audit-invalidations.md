# Audit: Comment status invalidations (output.log / prompts.log)

## What invalidations are

**Comment status** caches the LLM’s “issue still exists” verdict per comment, keyed by file path (and content hash). When we **invalidate**, we remove cached `open` statuses for comments that target certain files so the next run re-analyzes those comments instead of trusting the cache.

## Why they happen (single trigger)

- **Where:** `push-iteration-loop.ts` after `verifyFixes`.
- **Trigger:** The fixer has just run; we have a set of **changed files** (from `getChangedFiles(git)` in `fix-verification.ts`). We call `CommentStatusAPI.invalidateForFiles(stateContext, changedFiles)`.
- **Reason:** After the fixer modifies a file, the previous “still open” verdict for comments on that file is stale (the issue may now be fixed). Invalidating forces the next iteration’s `findUnresolvedIssues` to re-ask the LLM for those comments only, instead of re-analyzing everything.

So: **every invalidation is caused by “fixer changed these files”** — no other code path triggers it. `prompts.log` does not drive invalidations; it only contains verification/batch prompts. The link is: verify step → `changedFiles` from git → invalidate for those paths.

## Audit of output.log

| Time     | Changed files (from log)              | Invalidated              | Notes |
|----------|----------------------------------------|--------------------------|-------|
| 08:15:10 | `.prr/lessons.md`, `build.ts`, `src/service.ts` | 9 comment status(es) for 3 files | First verify after fix; 9 open statuses across those 3 files. `.prr/` is in the set (fixer touched it before revert). |
| 08:15:45 | `build.ts`                             | (0 — not logged)         | No cached open status for `build.ts` at that point, so nothing to invalidate. |
| 08:18:05 | `build.ts`, `src/service.ts`           | 6 for 2 files           | Matches 2 changed files. |
| 08:19:53 | `build.ts`                             | 1 for 1 file            | One comment had open status on `build.ts`. |
| 08:24:30 | `build.ts`, `package.json`             | 1 for 2 files           | One comment on one of the two files had open status. |
| 08:26:15 | `build.ts`, `package.json`             | 2 for 2 files           | One open status per file. |
| 08:28:07 | `build.ts`                             | 1 for 1 file            | One open status for `build.ts`. |

So: **every invalidation line corresponds to a “Changed files” line from the same verify step.** The counts are consistent (N comments with cached `open` status whose `filePath` is in the changed-files set; M = number of files in that set).

## Correctness

- **Intended rule:** Invalidate cached “open” comment status only for files that the fixer actually changed.
- **What we do:** We pass exactly `changedFiles` from verification into `invalidateForFiles`. So invalidations are **correct** and **not excessive** — we only clear cache for files that were modified.

## Minor clarity point

When the fixer edits `.prr/lessons.md`, it appears in `changedFiles` and is included in the “N changed file(s)” count. We don’t persist comment status for `.prr/` (those comments are dismissed), so invalidating for `.prr/` is a no-op. Filtering `.prr/` out of the list passed to `invalidateForFiles` (or only for the log) would make “changed file(s)” refer only to source files and align the message with user-visible edits; behavior would be unchanged.

## Summary

- **Why:** So that after the fixer changes files, we don’t reuse stale “issue still open” cache for comments on those files.
- **When:** Once per fix iteration, right after `verifyFixes`, using the same `changedFiles` from that step.
- **Correct?** Yes. Invalidations are driven solely by fixer-changed files and the counts in the log match that.
