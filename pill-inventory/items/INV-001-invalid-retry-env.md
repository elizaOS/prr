# INV-001: Invalid retry env warning

## Why This Document

This inventory item is split from **`pill-output.md`** so repeated findings can be tracked without making the raw pill log too large for LLMs to process.

## State

- **Status:** Done
- **Priority:** Low
- **Area:** config / elizacloud
- **Hits:** 2
- **Events:** 2026-04-26, 2026-04-28

## Evidence

- Raw pill themes: `PRR_ELIZACLOUD_SERVER_ERROR_RETRIES` invalid value, warn-only vs strict parse.
- Related: `shared/config.ts`, `shared/llm/elizacloud.ts`, `tests/elizacloud-server-error-retries.test.ts`.

## Next action

None — implemented and covered by tests.

## Resolution

Invalid env values warn (or strict-parse path where configured); behavior aligned with **`tests/elizacloud-server-error-retries.test.ts`**. See **`CHANGELOG.md`** / audit cycles for the exact landing commit.
