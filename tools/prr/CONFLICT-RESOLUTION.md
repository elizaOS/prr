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
- **TOP_TAILS_*** — Top+tails fallback (used only when main strategy failed): `TOP_TAILS_FALLBACK_MAX_CHUNK_LINES` (280), `TOP_TAILS_CONTEXT_LINES` (15), `TOP_TAILS_TOP_CONFLICT_LINES` (80), `TOP_TAILS_TAIL_LINES` (80), `TOP_TAILS_TWO_PASS_THRESHOLD_LINES` (150).

---

## Traps and pitfalls

See the phased plan in [.cursor/plans/large-file-deconflict-correct.plan.md](../../.cursor/plans/large-file-deconflict-correct.plan.md) for:

- **Junior devs:** Git stage indices (1=base, 2=ours, 3=theirs), line indexing (0- vs 1-based), base in every LLM path, empty base, base segment alignment, validation on in-memory content, AST parse failure → fallback, concatenation order.
- **Low-param models:** Model-aware segment size, reserve for response, chars vs tokens, tight prompts, many sub-chunks warning.

---

## Deterministic strategies (before LLM)

- **Lock files** — Deleted and regenerated (e.g. `package-lock.json`, `bun.lockb`).
- **`.github/workflows/*`** — **Take theirs** (incoming/base version). When the base branch updated the same workflow file, using the repo's version avoids outdated or broken workflows and matches common CI expectations.
- **CHANGELOG.md, docs/, CONTRIBUTING, etc.** — **Keep ours** (see `DETERMINISTIC_MERGE_FILES` / `DETERMINISTIC_MERGE_PATTERNS` in `git-conflict-resolve.ts`). LLM is not used for these so large docs don't hit context limits. **Marker detection** (`hasConflictMarkers` in `shared/git/git-lock-files.ts`): **`<<<<<<<`**, **`>>>>>>>`** (including orphan closers), and **`=======`** middle lines; **two+** middle-only lines ⇒ conflict; a **single** lone `=======` is ignored only when it matches a **narrow setext-style** pattern (heading-like previous line + body after). **Size-regression validation** is skipped for keep-ours / take-theirs so valid one-side merges are not rejected.

## When resolution still fails

- **Exit details** include the list of remaining conflicted files (e.g. in Actions "Show PRR output on failure").
- Resolve those files manually (edit, remove conflict markers, `git add`), then commit and re-run PRR.
- To skip base-branch merge for one run: **`--no-merge-base`** (not recommended long-term; the PR will stay "out of date with base" on GitHub).

**Partial resolutions:** If we resolved some files but not all, we **persist** the resolved file contents in state (`.pr-resolver-state.json`). On the next run we apply those first, then run LLM only on files that still have conflict markers, so you don’t redo the same resolutions. When the merge eventually completes and is pushed, we clear this cache.

---

## Alternative: whole-file chunks + top/tails focus (fallback only)

**Idea:** Chunk the **entire file** (not just conflict regions), build the story from that, then for each conflict focus on **top of the conflict** and **bottom of one side** and **bottom of the other**, instead of sending the full conflict block or AST-sub-chunked segments.

**When we use it:** Only when the **current strategy has already failed** for that file (chunked or single-shot resolution failed or produced invalid parse). We don’t process the entire file with this strategy unless we need to.

**WHYs (fallback)**
- **Why fallback-only:** So we don't pay the cost of whole-file story + top/tails unless the main path has already failed; default path stays fast and unchanged.
- **Why always build file story in fallback:** When we do run the fallback, every resolution prompt gets the same "map" of the file (what it does, what OURS vs THEIRS change); the model then sees top + tails in that context and can produce a coherent merge.
- **Why two-pass when conflict > 150 lines:** One-shot would ask the model to output the full conflict (e.g. 200 lines) from only top + tails; the middle would be invented and often wrong. Two-pass: first get a resolved "head" from top + base top, then get "tail" from head + tail OURS + tail THEIRS; each request is bounded and the model doesn't hallucinate the middle.
- **Why pass previousParseError into fallback:** When the main path failed due to parse (e.g. `'*/' expected`), the fallback prompts include that error so the model can avoid repeating the same mistake (e.g. close block comments).

**Current vs proposed:**

| Current | Proposed |
|--------|----------|
| Extract conflict regions; for each region send BASE + OURS + THEIRS (or sub-chunk the region at AST boundaries). | Chunk the whole file by position (e.g. fixed line or char windows). Build story from those full-file segments. |
| Story is built from full-file segments only when overview is triggered (2+ chunks or 15k+ chars). | Always build story from whole-file chunks so the model has a consistent "map" of the file. |
| Resolution sees one conflict region (or one AST sub-chunk) at a time. | Resolution sees **top of conflict** (context + start of conflict), then **tail of OURS**, then **tail of THEIRS** — so the model understands how each side ends in context. |

**Concrete shape:**

1. **Whole-file chunking** — Split the file into consecutive segments (e.g. by `FILE_OVERVIEW_SEGMENT_CHARS` or segment cap). No special treatment of conflict boundaries; chunks are purely by position. Use this for the story (already done when overview runs); optionally use the same chunk boundaries for resolution.
2. **Story** — Build the story from those full-file chunks (we already do this). Every resolution prompt gets this story.
3. **Per-conflict resolution with top + tails:**
   - **Top of conflict:** N lines of context before the conflict + the first M lines of the conflict block (e.g. first 50–100 lines including markers, or "shared" lead-in). Gives where the conflict starts and how it's rooted in the file.
   - **Bottom of OURS:** Last K lines of the OURS side of this conflict.
   - **Bottom of THEIRS:** Last K lines of the THEIRS side of this conflict.
   - Prompt: "Given the file story and the top of this conflict, and how OURS ends vs how THEIRS ends, produce a single merged resolution for the full conflict (or for the tail)." Option: one prompt that asks for the full conflict resolution given top + both tails; or two passes (resolve "head" of conflict, then "tail" given the two endings).
4. **Reassembly** — If we only resolve "top" and "tails" in separate steps, we must merge: e.g. "resolved top" + "resolved middle" (inferred or one more call) + "resolved tail". If we ask for full conflict in one go from top+tails, we still need to validate and replace the conflict region as today.

**Why it might help:**

- **Consistent context:** The model always sees the file in the same chunked way (by position), so "line 400" means the same segment everywhere.
- **Ending-aware:** Sending the **bottom** of OURS and THEIRS avoids the model only seeing the start of a long conflict; it can align the merge with how each side actually concludes (e.g. closing braces, return values).
- **Smaller prompts for huge conflicts:** One conflict might be 500 lines; instead of sending 500 + 500 + base, we send "top 80 lines + ours tail 60 + theirs tail 60" and ask for a full resolution, which may be enough for the model to synthesize.

**Open design choices:**

- **N, M, K:** How many lines for "context before", "top of conflict", and "tail" of each side? Tune by segment cap and model context.
- **One shot vs two pass:** One prompt "top + tail ours + tail theirs → full resolution" vs "resolve top" then "resolve tail given top and both tails".
- **When to use:** Always, or only when the conflict region is "oversized" (e.g. > MAX_SINGLE_CHUNK_CHARS) so we don't change behavior for small conflicts.
- **Base:** We still need BASE for 3-way semantics. Options: include "top of BASE" and "tail of BASE" for the same region, or a short "BASE summary" for that conflict.

**Where in code:** `resolveConflictsWithTopTailsFallback` in `git-conflict-chunked.ts`; called from `git-conflict-resolve.ts` only when the main resolution path (chunked or single-shot) has already failed for that file.

**Complete implementation (fallback path):**
1. **Always build file story** — Fallback calls `getFileConflictOverviewAlways`, which chunks the entire file into full-content segments and builds the story across turns. Every resolution prompt gets this story so the model has a consistent map of the file.
2. **Per-conflict: top + tails** — For each conflict region we send: top (context + first M lines of conflict), tail OURS, tail THEIRS, base top, base tail. One-shot prompt asks for the full resolved conflict.
3. **Two-pass when conflict is large** — When the conflict’s larger side exceeds `TOP_TAILS_TWO_PASS_THRESHOLD_LINES` (150) but is still ≤ 280, we do two passes: (a) resolve “head” from top + base top; (b) resolve “tail” from resolved head + tail OURS + tail THEIRS + base tail. Reassemble as head + tail.
4. **Parse-error hint** — When the main path failed due to parse validation, we pass that error into the fallback so the top+tails prompts can include “fix this parse error” and avoid repeating the same mistake.

Constants: `TOP_TAILS_FALLBACK_MAX_CHUNK_LINES` (280), `TOP_TAILS_CONTEXT_LINES` (15), `TOP_TAILS_TOP_CONFLICT_LINES` (80), `TOP_TAILS_TAIL_LINES` (80), `TOP_TAILS_TWO_PASS_THRESHOLD_LINES` (150).

---

## Audit: top+tails fallback (implementation correctness)

**Correctness**

- **Fallback trigger** — Only runs when the main path (chunked or single-shot) has already set `result.resolved === false`. Parse-error hint is passed only when the main path failed at parse validation (`lastParseError` set in that branch only).
- **Validation** — Fallback output is checked with the same `validateResolvedContent` (size/JSON) and `validateResolvedFileContent` (TS/JS parse) as the main path. No shortcut.
- **Reassembly** — Chunks are processed in `startLine` order; non-conflict lines are preserved; each conflict region is replaced by its resolved lines. Same pattern as main chunked path. No double-count or reordering.
- **Base segment** — Uses `getBaseSegmentForChunk(baseContent, chunk)` so base top/tail align with the conflict region. Short base (fewer lines than conflict) yields shorter baseTop/baseTail; that’s acceptable.
- **Overview when null** — If `getFileConflictOverviewAlways` returns null (e.g. LLM failure), we still run resolution with `overview ?? undefined`. A debug log notes that the fallback ran without a story.

**Design choices / limitations**

- **Two-pass boundary** — Head is “same approximate length as TOP” (~context + 80 lines). The model may output a different length, so the logical boundary between head and tail is fuzzy. The tail prompt asks for “continuation from head” and “do not repeat the head”, which is the best we can do without sending the full middle.
- **Conflict marker check** — We only reject if the resolved block *starts* a line with `<<<<<<<`/`=======`/`>>>>>>>` (`/^(<{7}|={7}|>{7})/m`). Markers in the middle of a line are not detected; same as main path and acceptable.
- **lastParseError** — Only set when the main path failed at *parse* validation. Failures due to size regression, missing RESOLVED block, or other validation do not set it, so the fallback runs without a parse hint in those cases (correct).

**Conclusion:** The implementation is consistent with the design, reuses the same validation and reassembly patterns, and handles null overview and parse hints correctly. The two-pass “approximate length” boundary is an intentional tradeoff.

---

## Related

- **Changelog:** [CHANGELOG.md](../../CHANGELOG.md) — “Conflict resolution: 3-way merge, sub-chunking, validation”.
- **Audit:** [CONFLICT-RESOLUTION-AUDIT.md](CONFLICT-RESOLUTION-AUDIT.md) — Implementation audit and base-segment fix.
