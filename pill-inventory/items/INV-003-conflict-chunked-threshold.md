# INV-003: Conflict chunked first-chars threshold

## Why This Document

This inventory item is split from **`pill-output.md`** so repeated findings can be tracked without making the raw pill log too large for LLMs to process.

## State

- **Status:** Done
- **Priority:** Medium
- **Area:** merge / conflict / prompts
- **Hits:** 2
- **Events:** 2026-04-26, 2026-04-28

## Evidence

- Raw pill: conflict batch embed should use **`CONFLICT_USE_CHUNKED_FIRST_CHARS`** (or equivalent constant) instead of a magic number.
- **`tools/prr/git/git-conflict-prompts.ts`**, **`shared/constants/llm.ts`**.

## Next action

None.

## Resolution

Conflict path uses the shared constant for chunked first-chars threshold; see **`DEVELOPMENT.md`** (fix loop / conflict prompt budget) and **`CHANGELOG.md`**.
