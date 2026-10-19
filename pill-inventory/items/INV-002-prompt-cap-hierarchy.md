# INV-002: Prompt cap hierarchy

## Why This Document

This inventory item is split from **`pill-output.md`** so repeated findings can be tracked without making the raw pill log too large for LLMs to process.

## State

- **Status:** Done
- **Priority:** Medium
- **Area:** llm / prompts
- **Hits:** 5
- **Events:** 2026-04-26, 2026-04-28, 2026-04-29

## Evidence

- Duplicate themes in raw pill: `MAX_ENRICHED_FIX_PROMPT_CHARS`, prompt cap invariant, rewrite reserve, `assertValidLlmPromptSizeLimits`.
- **`pill-output.md`** items referencing cap ordering (e.g. enriched vs base caps).

## Next action

None — caps centralized / asserted in **`shared/constants/llm.ts`** and related tests.

## Resolution

Fixed in **`shared/constants/llm.ts`** with **`assertValidLlmPromptSizeLimits`**; regression coverage in prompt-budget / elizacloud tests as cited in **`DEVELOPMENT.md`**.
