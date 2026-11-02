# INV-012: Blast radius — graceful degradation over cap

## Why This Document

When **`PRR_BLAST_RADIUS_MAX_FILES`** is exceeded, treating **all** issues as in-scope removes the feature’s value for large monorepos (pill cited **elizaOS**-scale trees). Track separately from path rules (**`INV-005`**) and model rotation (**`INV-006`**).

## State

- **Status:** Closed
- **Priority:** Medium
- **Area:** dependency graph / scope
- **Hits:** 3
- **Events:** 2026-04-14, 2026-04-25, 2026-04-26

## Evidence

- **`pill-output.md`** — **`## 2026-04-26 17:49`**, item **49**: **`shared/dependency-graph/`** + **`PRR_BLAST_RADIUS_MAX_FILES`** — sample / BFS-bounded subset or index instead of hard fail → “all in scope”. Pill path **`tools/prr/src/blast-radius.ts`** → **`shared/dependency-graph/`** + callers in **`tools/prr/workflow/`**.
- **Raw dated section removed from `pill-output.md` after triage.**
- **`## 2026-04-25 22:12`**, item **39**: **`MIN_CONFLICT_RESOLUTION_SIZE_RATIO`** / large-file regression guard — **`shared/constants/limits.ts`** (conflict resolution safety, not blast-radius graph — **optional** follow-up vs **`tools/prr/git/`** conflict heuristics). **Raw § removed after triage.**
- **`## 2026-04-14 07:20`**, item **34**: raise **`MIN_CONFLICT_RESOLUTION_SIZE_RATIO`** or env-gate — **`shared/constants/llm.ts`** (pill said **`prompts.ts`** — wrong file) (**`INV-003`** chunked path already **Done** — ratio is adjacent guardrail). **Raw § removed after triage.**

## Next action

None.

## Resolution

**2026-08-25:** Over **`PRR_BLAST_RADIUS_MAX_FILES`**, scan a bounded subset (PR **`preferFiles` first**). **`git ls-files`** honors **`timeoutMs`**. **`maxDepth=0`** skips proximity. ESM **`.js`** specifiers and Go **`_test.go`** exclusion.
