# Split-plan audit cycles

**Last updated:** 2026-03-12 · **Recorded cycles:** 1

Single audit log for split-plan-output.log, split-plan-prompts.log, and plan/code changes. Use it to spot recurring patterns and avoid flip-flopping.

---

## How to use this doc

1. **Before an audit:** Skim "Recurring patterns" and "Regression watchlist" so you know what to watch for.
2. **During an audit (split-plan-output.log / split-plan-prompts.log):**
   - Confirm Phase 1 (dependencies) and Phase 2 (full plan) both ran and produced non-empty output.
   - For the generated plan (e.g. `.split-plan.md`): check that every PR file appears in exactly one split's **Files:** list (or that Validation section correctly lists only true orphans).
   - Spot-check dependency direction: if the plan says "A <- B", verify that A actually depends on B (B provides something A needs).
3. **After an audit:** Add a new cycle using the template below. Fill findings, improvements, and flip-flop check.
4. **Periodically:** Update "Recurring patterns" if a new theme appears in 2+ cycles; add regression checks if we keep fixing the same class of bug.

---

## Recurring patterns to watch (concerns)

These themes have appeared in audits. When auditing, check whether they are still present or regressed.

| Theme | Cycles | Risk |
|-------|--------|------|
| **Dependency direction** | 1 | Phase 1 outputs "A <- B" with wrong direction (e.g. logger <- runtime when runtime uses logger). Guard: explicit notation in Phase 1 prompt ("A <- B means A depends on B; B should merge first"). |
| **Unassigned files** | 1 | Model assigns only a subset of PR files; Validation lists many "in PR but not in any split". Guard: "There are exactly N files … You MUST assign every file to exactly one split"; path extractor handles backtick-wrapped paths. |
| **Docs-only split** | 1 | Model creates a split whose **Files:** list contains only CHANGELOG/DESIGN/README/ROADMAP. Guard: explicit rule to put each doc file in the split that implements the feature it documents; never a "chore: Update documentation" split with only doc files. |
| **Path extraction** | 1 | Plan uses backtick-wrapped paths (`\`path/to/file\``); extractor didn't match leading backtick → 0 paths extracted → bogus "all unassigned" validation. Guard: path regex allows optional backticks; strip from captured path. |

---

## Recurring patterns to keep (improvements)

Improvements should reinforce these, not reverse.

| Pattern | What we keep doing |
|--------|---------------------|
| **source_pr from code** | Always set source_pr from prInfo (never trust LLM); avoids placeholders like "your_repo". |
| **Two-phase LLM** | Phase 1 dependencies only (with patches); Phase 2 full plan from deps + file list (no patches) to avoid 504 and keep prompt size manageable. |
| **Validation section** | Post-process: list paths in plan but not in PR (hallucinations); list PR files not in any split (unassigned). Backtick-aware path extraction so validation is accurate. |
| **Trailing fence strip** | Remove stray ``` at end of LLM plan body so the written file is valid. |
| **Prompt hygiene** | Explicit file count and "assign every file" in Phase 2; no docs-only split rule. |

---

## Regression watchlist

Quick checks each audit.

**Plan vs PR**
- [ ] Every file in the PR appears in exactly one split's **Files:** list (or Validation correctly lists only true unassigned files).
- [ ] No split's **Files:** list contains only documentation (CHANGELOG, DESIGN, README, ROADMAP, docs/*).
- [ ] Dependency direction: for each "A <- B" in Dependencies, A actually depends on B (B provides something A needs).

**Prompts / extraction**
- [ ] Phase 1 system prompt includes "Notation: A <- B means 'A depends on B' …".
- [ ] Phase 2 includes "There are exactly N files … You MUST assign every file to exactly one split's **Files:** list".
- [ ] Path extractor allows optional leading/trailing backticks for **Files:** bullets.

**Output / frontmatter**
- [ ] source_pr is always built from prInfo (not from LLM output).
- [ ] Plan file does not end with a stray ```.
- [ ] Validation section (if present) lists only real unknowns/unassigned (not everything due to extractor bug).

---

## Cycle template

Copy the block below for each new cycle.

**Severity:** High = plan wrong or split-exec broken. Medium = correctness or significant UX. Low = minor/cosmetic.

```markdown
### Cycle — YYYY-MM-DD

**Artifacts audited:** (e.g. split-plan-output.log, split-plan-prompts.log #0001–#0006, .split-plan.md, run.ts diff)

**Findings:**
- **High:** (none or 1-line)
- **Medium:** (1-line each)
- **Low:** (1-line each)

**Improvements implemented:**
- (bullet list)

**Flip-flop check:** Y / N — (one line: any revert or conflicting change?)

**Notes:** (optional).
```

---

## Recorded cycles

### Cycle 1 — 2026-03-12 (elizaOS/eliza #6562, split-plan prompts + plan)

**Artifacts audited:** split-plan-output.log, split-plan-prompts.log (Phase 1 #0003–#0004, Phase 2 #0005–#0006), .split-plan.md, run.ts.

**Findings:**
- **High:** (none)
- **Medium:** Phase 1 dependency direction ambiguous — output had `logger.ts <- runtime.ts` (wrong; runtime uses logger). Phase 2 assigned only 10 of 34 files; model created docs-only Split 4 and omitted 24+ files.
- **Low:** Path extractor did not match backtick-wrapped paths → validation reported "all files unassigned" (fixed in same session). Every split listed only commit b6b80ce (52 commits in PR); left as-is for file-based split-exec.

**Improvements implemented:**
- Phase 1 system prompt: added "Notation: A <- B means 'A depends on B' (B provides something A needs; B should merge first or be in the same PR)."
- Phase 2: "There are exactly ${totalFiles} files in this PR. You MUST assign every file to exactly one split's **Files:** list — no file may be omitted."
- No-docs-only rule tightened: "Do not create a split whose **Files:** list contains only documentation … Put each doc file in the split that implements the feature it documents. Never output a … 'feat: Document…' split that has only doc files."
- Path extractor: optional backticks in regex for **Files:** bullets; strip trailing backtick from candidate (same session, separate fix).

**Flip-flop check:** N — no conflicting changes.

**Notes:** source_pr-from-prInfo and trailing-fence strip were done earlier in same workstream. Branch names in plan use backticks; split-exec parser expects them — no change.
