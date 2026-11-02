# Pill inventory index

## Why This Document

This index is the **compact priority queue** for pill-derived work on **this** repo (`tools/prr/`, `shared/`). Raw pill output grows too large for LLM context — open **[items/](items/)** per `INV-*` id for evidence, hit counts, and resolution. Raw append log: **`pill-output.md`** (inbox only, often gitignored locally).

## How to pick work

1. Read **Queue** below (highest priority first).
2. Open the linked **`items/INV-*.md`** for full context.
3. Implement from the item file, not from raw **`pill-output.md`** alone.
4. When done, update the item file **and** this index in the same change.

## Queue

| ID | Theme | Priority | Status | Hits | Last event | Next action |
|----|-------|----------|--------|------|------------|-------------|
| [INV-004](items/INV-004-verifier-snippet-centering.md) | Verifier / audit snippet centering vs truncation | High | Open | 32 | 2026-04-08 | Center excerpts; streaming / empty-body / truncation guard |
| [INV-011](items/INV-011-strict-final-audit-orchestration.md) | Strict final audit — orchestration / uncertain | High | Open | 24 | 2026-04-08 | Early exit + **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** wiring |
| [INV-013](items/INV-013-dedup-fix-pipeline-invariants.md) | Dedup → verify → fix pipeline invariants | High | Open | 23 | 2026-04-08 | Stage counts; collapse duplicates before fix |
| [INV-005](items/INV-005-path-category-canonicalization.md) | Path dismissal canonical classifier | Medium | Open | 30 | 2026-04-08 | **`classifyReviewPath`**; synthetic **`(PR comment)`** bucket |
| [INV-006](items/INV-006-model-rotation-resilience.md) | Model rotation / skip resilience | Medium | Open | 31 | 2026-04-08 | Skip list vs **dedup**; quota errors; operator docs parity |
| [INV-008](items/INV-008-merge-conflict-blocked-ux.md) | Merge / git / blocked-run operator UX | Medium | Open | 27 | 2026-04-08 | Clone prompts; **`mergeable: null`**; missing base ref line map |
| [INV-009](items/INV-009-verified-this-session-on-head-change.md) | **`verifiedThisSession`** vs HEAD change / commit gate | Medium | Open | 13 | 2026-04-08 | Clear session Set when load clears verified on **`headSha`** change |

## Done recently

| ID | Theme | Closed |
|----|-------|--------|
| [INV-010](items/INV-010-state-lifecycle-overlap-pruning.md) | State lifecycle — overlap, re-queue, git recovery | 2026-08-25 |
| [INV-012](items/INV-012-blast-radius-large-repo.md) | Blast radius — graceful degradation over cap | 2026-08-25 |
| [INV-001](items/INV-001-invalid-retry-env.md) | Invalid `PRR_ELIZACLOUD_SERVER_ERROR_RETRIES` warn + strict parse | 2026-04-28 |
| [INV-002](items/INV-002-prompt-cap-hierarchy.md) | Prompt cap alignment + `assertValidLlmPromptSizeLimits` | 2026-04-28 |
| [INV-003](items/INV-003-conflict-chunked-threshold.md) | Conflict batch embed uses `CONFLICT_USE_CHUNKED_FIRST_CHARS` | 2026-04-28 |

## Conventions

- **ID:** `INV-NNN` with zero-padded 3 digits in filenames: `INV-001-…`.
- **Hits:** bump when the same theme appears again in a new pill section or audit.
- **Events:** pill run date or manual triage date (`YYYY-MM-DD`).

See **[DEVELOPMENT.md](../DEVELOPMENT.md)** → *Pill output triage* for the full rotation workflow.
