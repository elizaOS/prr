# Conflict resolution (3-way merge + sub-chunking)

PRR resolves merge conflicts using a methodical, correct approach aligned with structured-merge best practices.

---

## Two conflict contexts

PRR resolves conflicts in **two separate steps** during setup:

1. **Sync with remote (same branch)** — e.g. workdir had a leftover rebase or merge with `origin/<branch>`. We resolve, complete the merge/rebase, and **push**. The message "Pushed after conflict resolution" refers to this.
2. **Base branch merge** — We merge the PR’s **base branch** (e.g. `main`) into the PR branch so the PR is up to date. If that merge has conflicts (e.g. `CHANGELOG.md`, `ROADMAP.md`, `runtime.ts`), we resolve them and push the **merge commit**. If resolution fails or leaves conflict markers, we abort and do not push.

**If GitHub still shows "This branch has conflicts that must be resolved"** after a run, the push you saw was likely from (1). The conflicts listed by GitHub are with the **base** branch; step (2) either did not run, failed to resolve, or we detected conflict markers left in the resolved files and aborted. Resolve those files manually (or with `--no-merge-base` to skip base merge for this run), then push and re-run.

---

## Flow

1. **Three-way merge** — Every LLM resolution sees **base** (Git stage 1), **ours** (stage 2), and **theirs** (stage 3). The model merges both changes relative to the common ancestor.
2. **File overview (chunked only)** — We do a **full read** of the file in consecutive full-content segments (no cap; we always chunk). Each segment is sent in full; the LLM builds the story across turns. That story is then injected into every chunk-resolution prompt so the model has global context.
3. **Sub-chunking** — When a single conflict region exceeds the model’s segment cap, we split at **semantic boundaries** (TS/JS: AST statement boundaries; Python: `def`/`class`; fallback: blank lines or line cap). Each sub-chunk is resolved with its base segment, then results are concatenated.
4. **Validation** — Before writing or staging, we validate the resolved file (parse for TS/JS; JSON and size checks for other cases). If invalid, we leave the file conflicted and report.

---

## WHYs

**Why 3-way (base + ours + theirs)?**  
Two-way (ours vs theirs only) forces the model to guess how to combine. Proper merge semantics require the common ancestor so the model can reason about what each side changed from base and produce a correct merge. Git provides base as stage 1; we pass it into every resolution path.

**Why sub-chunk at AST boundaries?**  
When a conflict region is too large for one LLM call, we must split. Splitting mid-statement would send invalid code and produce broken output. Splitting at top-level statements (or def/class in Python, or blank lines in fallback) keeps each segment parseable and mergeable. Industry approach: AST-based structured merge (e.g. Mergiraf, SPORK).

**Why validate before write/stage?**  
LLMs can truncate or corrupt output. Committing invalid syntax would push broken code. We parse the resolved content (TS/JS via TypeScript API); if there are parse errors we reject and leave the file conflicted so the user can fix manually.

**Why one retry on parse failure?**  
When validation fails (e.g. `'*/' expected`), we retry resolution once with the previous parse error in the prompt so the model can fix syntax. Many parse failures are trivial (unclosed comment, missing brace); one retry gives the model a chance to self-correct without unbounded retries.

**Why derive segment cap from model context?**  
A fixed cap (e.g. 25k chars) would overflow a 40k-context model (3×25k input). We compute `(effectiveMaxChars - CONFLICT_PROMPT_OVERHEAD_CHARS) / 3` and clamp to [4k, 25k] so small-context models get smaller segments and we never exceed the model’s window.

**Why no skip by file size?**  
We always chunk (story and resolution). No cap; no "file too large, resolve manually."

**Why chunk files that exceed single-request context?**  
Previously we skipped any file larger than the model's context (e.g. 40KB on a small model). Those files are now resolved via **chunked strategy** (segments under the model's limit). We do not skip by file size; we always chunk.

**Why a full-read file story before chunked resolution?**  
When resolving many conflict regions in one file, each chunk is sent in isolation. The model can lose the big picture. We have the model do a **full read** of the file in consecutive full-content segments (always chunked; no cap), then tell the story across turns. That story is injected into every chunk prompt so resolutions stay coherent.

---

## Constants

- **CONFLICT_PROMPT_OVERHEAD_CHARS** — Reserve for system/instructions and model response. Segment cap leaves room so input + output stays under context.
- **FILE_OVERVIEW_*** — Full-read story: trigger when `FILE_OVERVIEW_MIN_CHUNKS` (2) or `FILE_OVERVIEW_MIN_FILE_CHARS` (15k). We always chunk the file into full-content segments of `FILE_OVERVIEW_SEGMENT_CHARS` (40k) and build the story across turns (no whole-file cap).
- **MAX_SINGLE_CHUNK_CHARS** / **MAX_EDGE_SEGMENT_CHARS_DEFAULT** — Default segment size when model is unknown. Overridden in resolve path by the derived cap.
- Segment cap formula: `(effectiveMaxChars - CONFLICT_PROMPT_OVERHEAD_CHARS) / 3`, clamped to [4_000, 25_000].

---

## Traps and pitfalls

See the phased plan in [.cursor/plans/large-file-deconflict-correct.plan.md](../../.cursor/plans/large-file-deconflict-correct.plan.md) for:

- **Junior devs:** Git stage indices (1=base, 2=ours, 3=theirs), line indexing (0- vs 1-based), base in every LLM path, empty base, base segment alignment, validation on in-memory content, AST parse failure → fallback, concatenation order.
- **Low-param models:** Model-aware segment size, reserve for response, chars vs tokens, tight prompts, many sub-chunks warning.

---

## Deterministic strategies (before LLM)

- **Lock files** — Deleted and regenerated (e.g. `package-lock.json`, `bun.lockb`).
- **`.github/workflows/*`** — **Take theirs** (incoming/base version). When the base branch updated the same workflow file, using the repo's version avoids outdated or broken workflows and matches common CI expectations.
- **CHANGELOG.md, docs/, CONTRIBUTING, etc.** — **Keep ours** (see `DETERMINISTIC_MERGE_FILES` / `DETERMINISTIC_MERGE_PATTERNS` in `git-conflict-resolve.ts`). LLM is not used for these so large docs don't hit context limits.

## When resolution still fails

- **Exit details** include the list of remaining conflicted files (e.g. in Actions "Show PRR output on failure").
- Resolve those files manually (edit, remove conflict markers, `git add`), then commit and re-run PRR.
- To skip base-branch merge for one run: **`--no-merge-base`** (not recommended long-term; the PR will stay "out of date with base" on GitHub).

**Partial resolutions:** If we resolved some files but not all, we **persist** the resolved file contents in state (`.pr-resolver-state.json`). On the next run we apply those first, then run LLM only on files that still have conflict markers, so you don’t redo the same resolutions. When the merge eventually completes and is pushed, we clear this cache.

---

## Related

- **Changelog:** [CHANGELOG.md](../../CHANGELOG.md) — “Conflict resolution: 3-way merge, sub-chunking, validation”.
- **Audit:** [CONFLICT-RESOLUTION-AUDIT.md](CONFLICT-RESOLUTION-AUDIT.md) — Implementation audit and base-segment fix.
