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
2. **Sub-chunking** — When a single conflict region exceeds the model’s segment cap, we split at **semantic boundaries** (TS/JS: AST statement boundaries; Python: `def`/`class`; fallback: blank lines or line cap). Each sub-chunk is resolved with its base segment, then results are concatenated.
3. **Validation** — Before writing or staging, we validate the resolved file (parse for TS/JS; JSON and size checks for other cases). If invalid, we leave the file conflicted and report.

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

**Why warn only for actually skipped files?**  
Warning for any file over 50KB was noisy when we successfully resolve many of those with sub-chunking. We now list only files that hit “file too large for model context” and were skipped.

---

## Constants

- **CONFLICT_PROMPT_OVERHEAD_CHARS** — Reserve for system/instructions and model response. Segment cap leaves room so input + output stays under context.
- **MAX_SINGLE_CHUNK_CHARS** / **MAX_EDGE_SEGMENT_CHARS_DEFAULT** — Default segment size when model is unknown. Overridden in resolve path by the derived cap.
- Segment cap formula: `(effectiveMaxChars - CONFLICT_PROMPT_OVERHEAD_CHARS) / 3`, clamped to [4_000, 25_000].

---

## Traps and pitfalls

See the phased plan in [.cursor/plans/large-file-deconflict-correct.plan.md](../../.cursor/plans/large-file-deconflict-correct.plan.md) for:

- **Junior devs:** Git stage indices (1=base, 2=ours, 3=theirs), line indexing (0- vs 1-based), base in every LLM path, empty base, base segment alignment, validation on in-memory content, AST parse failure → fallback, concatenation order.
- **Low-param models:** Model-aware segment size, reserve for response, chars vs tokens, tight prompts, many sub-chunks warning.

---

## Related

- **Changelog:** [CHANGELOG.md](../../CHANGELOG.md) — “Conflict resolution: 3-way merge, sub-chunking, validation”.
- **Audit:** [CONFLICT-RESOLUTION-AUDIT.md](CONFLICT-RESOLUTION-AUDIT.md) — Implementation audit and base-segment fix.
