# Optional Follow-ups: Design Notes

Three follow-ups from the plugin-jupiter#4 audit. This doc summarizes where they live in the codebase and how to implement them.

---

## 1. Bot wait tuning: shorten when bots are active but slow

**Goal:** Reduce the 300s (5 min) cap when we have bot timing data, so we don’t wait unnecessarily long when bots are “active but slow”.

**Current behavior:**
- **`src/resolver-proc.ts`** `calculateSmartWaitTime()`:
  - With timing: `waitMs` = max+20% (actively reviewing), or avg+10% (idle), clamped to **30s–300s** (lines 278–281).
  - Without timing: uses `defaultWait` (from `--poll-interval`, default **120s** in `src/cli.ts` line 118).
- **`src/workflow/startup.ts`** `MAX_RECOMMENDED_WAIT_S = 300`: only used for the *recommended* wait printed to the user (p75, rounded to 30s); it does **not** set the actual wait.

So the “300s default” in conversation was the **cap** (max 5 min), not the default wait. The default wait with no timing is **120s** (`--poll-interval`).

**Options to “shorten when bots are active but slow”:**
- **A) Lower the cap:** e.g. change `maxWaitMs` in `resolver-proc.ts` from `5 * 60 * 1000` to `3 * 60 * 1000` (3 min) when we have timing data. Simple, one-line.
- **B) Use p75 instead of max when “actively reviewing”:** Today we use `maxObserved * 1.2` when `activelyReviewing`; we could use the same p75-based value used in startup (capped at 300s or lower) so one slow run doesn’t force a long wait every time.
- **C) Make cap configurable:** e.g. `--max-bot-wait <seconds>` (default 300). No change to logic, just tunable.

**Recommendation:** A or B. B is nicer UX (p75 avoids outlier-driven waits) but needs p75 passed into or recomputed in `calculateSmartWaitTime`. A is trivial.

**Files to touch:** `src/resolver-proc.ts` (and optionally `src/workflow/startup.ts` if we want to share a constant).

---

## 2. Self-corruption guard: suppress “new work” for one iteration after restore

**Goal:** After we restore a file from base (self-corruption), don’t treat new bot comments on that file as “new work” for **one** iteration, to avoid re-entry spiral.

**Current flow:**
- **`src/workflow/fix-verification.ts`** (lines 473–500): When all issues on a file fail verification and corruption is detected, we call `detectFileCorruption(git, filePath, 'HEAD')` then `git.checkout(['HEAD', '--', filePath])`. So we restore from **last commit**, not from base branch (comment says “base branch” but code uses HEAD).
- **`verifyFixes`** does **not** return which files were restored.
- **`src/workflow/fix-loop-utils.ts`** `processNewBotReviews()`: pulls in new comments from `checkForNewBotReviews` and appends all of them to `unresolvedIssues` with no filtering by path.

**Design:**
1. **Return restored files from verifyFixes**  
   In `fix-verification.ts`, when we run the restore block, collect `filePath` into an array and return it, e.g. `restoredFiles: string[]` in the result object.

2. **Thread restored files through the loop**  
   `push-iteration-loop.ts` calls `ResolverProc.verifyFixes(...)`. It already has `iterState` and passes context down. Add something like `lastRestoredFiles: string[]` to the iteration state (or a ref), set from `verifyFixes` result when non-empty.

3. **Filter “new” comments on restored files for one round**  
   `processNewBotReviews` is called from `fix-iteration-pre-checks.ts` with `(github, owner, repo, number, existingCommentIds, comments, unresolvedIssues, checkForNewBotReviews, getCodeSnippet)`. Add an optional parameter, e.g. `pathsToIgnoreForNewComments?: string[]`. When present, in the loop that pushes to `unresolvedIssues`, skip any `newComment` whose `comment.path` is in that set. Caller passes `lastRestoredFiles` and clears it after the call (so we only suppress for one iteration).

4. **Clear after use**  
   The place that sets `lastRestoredFiles` should clear it at the **start** of the next fix iteration (so “one iteration” = one full fix loop pass). So: set when we restore in verifyFixes; pass into processNewBotReviews when we check for new reviews; clear at top of next iteration in the fix loop.

**Edge case:** If we restore file A and the bot also added a comment on file B, we still add B’s comment. Only comments on restored paths are suppressed.

**Files to touch:**
- `src/workflow/fix-verification.ts` — return `restoredFiles`.
- `src/workflow/push-iteration-loop.ts` — receive `restoredFiles`, store in state/ref, pass to pre-checks.
- `src/workflow/fix-loop-utils.ts` — `processNewBotReviews(..., pathsToIgnoreForNewComments?: string[])`.
- `src/workflow/fix-iteration-pre-checks.ts` — pass `lastRestoredFiles` into `processNewBotReviews`, then clear it (or have push-iteration-loop clear at start of iteration).

**Note:** Restore currently uses **HEAD**, not base branch. If we want “restore from base” literally, we’d need to use ``git.show([`origin/${baseBranch}:${filePath}`])`` and write to the file, and have `baseBranch` available in verifyFixes (e.g. pass `prInfo.baseBranch`).

---

## 3. “Restore from base” heuristic when LLM says file corrupted

**Goal:** When the fixer/LLM output says “file corrupted” or “restore from base” (or similar), run `git show origin/<base>:<path> > <path>` instead of asking the fixer again.

**Where LLM output is seen:**
- **`src/workflow/execute-fix-iteration.ts`**: `result.output` from the runner; `parseResultCode(result.output)` for RESULT: codes.
- **`src/workflow/helpers/recovery.ts`**: direct-LLM fix path; `result.output` and `parseResultCode`; CANNOT_FIX/ALREADY_FIXED and “other file” retry.
- **`src/workflow/no-changes-verification.ts`**: handles RESULT: ALREADY_FIXED, CANNOT_FIX, etc.

**Design:**
1. **Detect the intent**  
   Add a small helper, e.g. `parseRestoreFromBaseIntent(output: string): { path: string } | null`. Look for:
   - Phrases like “restore from base”, “restore this file from base”, “file is corrupted”, “file has been corrupted”, “revert to base”.
   - Optional: path from same line or next line, or from “git show origin/…:path” pattern.
   - If we can’t extract a path, we can’t act (or we could try to infer from the issue’s `comment.path` when in single-issue/direct-LLM context).

2. **Where to act**  
   - **Option A – After fixer run, before verification:** In `execute-fix-iteration.ts`, after we have `result.output` and before we treat as “no changes”. If `parseRestoreFromBaseIntent(result.output)` returns a path and we have `prInfo.baseBranch`, run `git.show([`origin/${prInfo.baseBranch}:${path}`])` and write to `path`, then treat as “has changes” (so verification runs) or as “skip verification for this file” depending on product choice.
   - **Option B – In direct-LLM path:** In `recovery.ts`, when we get CANNOT_FIX or a free-text explanation that matches “restore from base” / “corrupted”, call the same helper and, if we have base branch, restore the file and retry or exit clean.

3. **Safety**  
   - Only allow paths that are under the repo and not in `PROTECTED_DIRS`.
   - If `git show origin/<base>:<path>` fails (e.g. path doesn’t exist on base), log and do not overwrite.

**Files to touch:**
- New helper: e.g. `src/workflow/restore-from-base.ts` with `parseRestoreFromBaseIntent(output)` and `restoreFileFromBase(git, baseBranch, filePath)`.
- **`src/workflow/execute-fix-iteration.ts`** — after getting `result.output`, if parse returns a path and we have `prInfo`, call `restoreFileFromBase`, then treat as one of: “no change” (so we don’t re-run fixer), “has change” (run verification), or “skip this issue”.
- Optionally **`src/workflow/helpers/recovery.ts`** for the direct-LLM path.

**Risk:** False positives (LLM says “could restore from base” as a suggestion; we shouldn’t restore unless we’re sure). Prefer narrow regex/phrases and/or only trigger when combined with CANNOT_FIX or a clear “file corrupted” sentence.

---

## Summary

| Follow-up              | Complexity | Main files                                      | Notes |
|------------------------|-----------|--------------------------------------------------|-------|
| Bot wait tuning         | Low       | `resolver-proc.ts` (and optionally startup)       | Lower cap or use p75 when we have timing. |
| Self-corruption guard   | Medium    | `fix-verification.ts`, `push-iteration-loop.ts`, `fix-loop-utils.ts`, `fix-iteration-pre-checks.ts` | Return restored paths; filter new comments on those paths for one iteration. |
| Restore-from-base heuristic | Medium | New helper + `execute-fix-iteration.ts` (and optionally `recovery.ts`) | Parse “restore from base” / “corrupted”; run `git show origin/<base>:<path>` with safety checks. |

Implementing in order 1 → 2 → 3 keeps each step self-contained and testable.
