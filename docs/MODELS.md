# LLM Models Reference

This doc summarizes **current and legacy models** from official provider docs. Use it when choosing models or updating context limits in **`shared/llm/model-context-limits.ts`** (**`tools/prr/llm/model-context-limits.ts`** re-exports the same symbols for stable imports from workflow code).

**Sources (check for latest):**

- **Claude:** [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- **OpenAI:** [Models](https://developers.openai.com/api/docs/models) — full ID list for scraping lives on [All models](https://developers.openai.com/api/docs/models/all)

### Machine-readable catalog (for PRR / automation)

Vendor doc pages change often; review bots may lag and suggest wrong renames (e.g. “use `gpt-4-mini`” when `gpt-5-mini` exists).

| Artifact | Purpose |
|----------|---------|
| **`generated/model-provider-catalog.json`** | `fetchedAtIso`, `recommendedRefreshDays` (7), per-provider `apiIds[]`, and `lookup.openaiHyphenless` / `anthropicHyphenless` for loose matching |
| **`shared/model-catalog.ts`** | `loadModelProviderCatalog()`, `resolveCatalogModelId()`, `isKnownOpenAiModelId()`, `isModelCatalogStale()` |
| **`tools/model-catalog/fetch-provider-catalog.ts`** | Fetches the two doc URLs above and regenerates the JSON (no API keys) |

**Refresh:** `npm run update-model-catalog`. **Weekly:** GitHub Action `refresh-model-catalog.yml`. **Override file path:** `PRR_MODEL_CATALOG_PATH`.

**PRR behavior:** Outdated bot comments that call a catalog-valid id a “typo” and suggest another id are **dismissed** (`assessSolvability`, check **0a6**) and optionally **auto-healed** in the workdir before issue analysis.

| Mechanism | WHY |
|-----------|-----|
| **Dismiss in solvability** | Stops non-actionable “rename valid A → valid B” advice from entering the LLM analysis/fix queue. |
| **Heal before hashes / cache** | Analysis reuse keys off file content; correcting a bad string first avoids stale “still broken” conclusions. |
| **Quoted literals only + line window** | Replacing bare tokens file-wide could hit unrelated code or prose; quotes/backticks near the review line target typical `model: '…'` / `` `…` `` constants safely. |
| **`markVerified` + commit when all resolved** | The normal commit gate requires verified session ids; deterministic heals must satisfy the same rule so we do not commit unrelated dirty trees. |

**Environment:** `PRR_MODEL_CATALOG_PATH` (override JSON path). **Disable pieces:** `PRR_DISABLE_MODEL_CATALOG_SOLVABILITY=1` (no 0a6 dismissal), `PRR_DISABLE_MODEL_CATALOG_AUTOHEAL=1` (no file rewrite; dismissal still applies if solvability is on). Full narrative: `DEVELOPMENT.md` — *Commit gate and catalog model auto-heal*.

**Limitations (intentional):** Detection requires **framing** (“typo”, “invalid model”, etc.) so neutral suggestions (“prefer X for cost”) are not auto-dismissed. Parsing needs a confident **pair** of ids (`change A to B`, `use B instead of A`, `replace … with …`, quoted `A → B`, or a **heading** like `### Model name typo \`gpt-5-mini\`` with a later `use \`gpt-4o-mini\`` / `recommended \`…\`` in the same body). Summary tables that only say “FIXED → `gpt-4o-mini`” without an explicit wrong id may **not** match — extend `parseModelRenameAdvice` if another stable pattern appears.

---

## Claude (Anthropic)

All current Claude models support text + image input, text output, multilingual, and vision. Available via Claude API, AWS Bedrock, and Google Vertex AI.

### Latest models

| Model | API ID | Description | Context | Max output | Pricing (MTok) |
|-------|--------|-------------|---------|------------|----------------|
| **Claude Opus 4.6** | `claude-opus-4-6` | Best for agents and coding | 200K / 1M (beta) | 128K | $5 in / $25 out |
| **Claude Sonnet 4.6** | `claude-sonnet-4-6` | Speed + intelligence | 200K / 1M (beta) | 64K | $3 in / $15 out |
| **Claude Haiku 4.5** | `claude-haiku-4-5` | Fastest, near-frontier | 200K | 64K | $1 in / $5 out |

- **Extended thinking:** All three. **Adaptive thinking:** Opus 4.6, Sonnet 4.6 (not Haiku 4.5).
- **1M context (beta):** Opus 4.6, Sonnet 4.6 — use `context-1m-2025-08-07` header; long-context pricing above 200K.
- **Reliable knowledge cutoff:** Opus 4.6 May 2025, Sonnet 4.6 Aug 2025, Haiku 4.5 Feb 2025.

### Legacy Claude models (still available)

| Model | API ID / alias | Context | Max output | Notes |
|-------|----------------|---------|------------|--------|
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250929` / `claude-sonnet-4-5` | 200K / 1M (beta) | 64K | Extended thinking, Priority Tier |
| Claude Opus 4.5 | `claude-opus-4-5-20251101` / `claude-opus-4-5` | 200K | 64K | Extended thinking |
| Claude Opus 4.1 | `claude-opus-4-1-20250805` / `claude-opus-4-1` | 200K | 32K | Higher pricing tier |
| Claude Sonnet 4 | `claude-sonnet-4-20250514` / `claude-sonnet-4-0` | 200K / 1M (beta) | 64K | |
| Claude Opus 4 | `claude-opus-4-20250514` / `claude-opus-4-0` | 200K | 32K | |
| Claude Haiku 3 | `claude-3-haiku-20240307` | 200K | 4K | **Deprecated** — retire Apr 19, 2026; migrate to Haiku 4.5 |

---

## OpenAI

### Featured / frontier models

| Model | API ID | Description | Notes |
|-------|--------|-------------|--------|
| **GPT-5.2** | `gpt-5.2` | Best for coding and agentic tasks | Frontier |
| **GPT-5 mini** | `gpt-5-mini` | Faster, cost-efficient GPT-5 | Well-defined tasks |
| **GPT-5 nano** | `gpt-5-nano` | Fastest, most cost-efficient GPT-5 | |
| **GPT-5.2 pro** | `gpt-5.2-pro` | Smarter, more precise than 5.2 | |
| **GPT-5** | `gpt-5` | Previous reasoning model, configurable effort | |
| **GPT-4.1** | `gpt-4.1` | Smartest non-reasoning model | |

### Codex-optimized (agentic coding)

| Model | API ID | Notes |
|-------|--------|------|
| GPT-5.3-Codex | `gpt-5.3-codex` | Most capable agentic coding |
| GPT-5.2-Codex | `gpt-5.2-codex` | Long-horizon, agentic coding |
| GPT-5.1-Codex | `gpt-5.1-codex` | Agentic coding in Codex |
| GPT-5.1-Codex-Max | `gpt-5.1-codex-max` | Long-running tasks |
| GPT-5-Codex | `gpt-5-codex` | Agentic coding |

### Other widely used

| Model | API ID | Notes |
|-------|--------|------|
| GPT-4o | `gpt-4o` | Fast, flexible |
| GPT-4o mini | `gpt-4o-mini` | Fast, affordable |
| o3 / o3-pro | `o3`, `o3-pro` | Reasoning; o3 succeeded by GPT-5 |
| o4-mini | `o4-mini` | Fast reasoning; succeeded by GPT-5 mini |

### Specialized

- **Image:** `gpt-image-1.5`, `chatgpt-image-latest`, `gpt-image-1`, `gpt-image-1-mini`
- **Video:** `sora-2`, `sora-2-pro`
- **Deep research:** `o3-deep-research`, `o4-mini-deep-research`
- **Realtime / audio:** `gpt-realtime`, `gpt-realtime-1.5`, `gpt-audio`, `gpt-audio-1.5`, `gpt-realtime-mini`, `gpt-audio-mini`
- **Speech:** `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-tts`, etc.
- **Embeddings:** `text-embedding-3-large`, `text-embedding-3-small`

### Open-weight (Apache 2.0)

- `gpt-oss-120b` — most powerful, fits H100
- `gpt-oss-20b` — lower latency

For full list, deprecations, and pricing see [OpenAI Models](https://developers.openai.com/api/docs/models).

---

## Using this in PRR

- **ElizaCloud / context limits:** Edit **`ELIZACLOUD_MODEL_CONTEXT`** in `shared/llm/model-context-limits.ts`. Each entry sets **`maxContextTokens`** (total context window for that API model ID). PRR derives fix-prompt char caps from that (small contexts use a denser tokenization estimate). Optional **`maxFixPromptCharsCap`** tightens the derived value when the gateway still times out. Unknown gateway models use a conservative default until you add a row. Use **`ELIZACLOUD_MODEL_ID_ALIASES`** and pattern aliases in that file when the same physical model appears under multiple strings (e.g. `Qwen/Qwen3-14B` → `alibaba/qwen-3-14b`).
- **Model IDs:** Prefer stable snapshot IDs (e.g. `claude-sonnet-4-5-20250929`) when you need reproducible behavior; use aliases (e.g. `claude-sonnet-4-6`) for "latest" behavior.
- **Claude 4.6:** See [Migrating to Claude 4.6](https://platform.claude.com/docs/en/about-claude/models/migration-guide) when moving from older Claude versions.

### Rotation order and skip list

- **llm-api / ElizaCloud:** Fallback rotation order is **`DEFAULT_MODEL_ROTATIONS`** in `shared/runners/types.ts`; at runtime the list usually comes from the runner’s **`supportedModels`** (gateway/API discovery) and is **filtered** in `tools/prr/models/rotation.ts` using **`getEffectiveElizacloudSkipModelIds()`** from `shared/constants.ts`. Do not assume the static table in `types.ts` is the exact live order.
- **Skip list (authoritative):** **`ELIZACLOUD_SKIP_MODEL_IDS`** in **`shared/constants.ts`**. The table below is a **snapshot for operators**; if it disagrees with the source array, **trust the source file** and update this table when you change skips.

**Last reviewed (skip table):** 2026-04-05 — constants sync + env skip-list validation (`PRR_ELIZACLOUD_EXTRA_SKIP_MODELS` / `INCLUDE` malformed tokens ignored with one-time warn).

| Model id | Reason in **`ELIZACLOUD_SKIP_REASON`** | Notes |
|----------|----------------------------------------|--------|
| `openai/gpt-5.2-codex` | *(default `timeout`)* | Gateway / rotation audit |
| `anthropic/claude-3-opus` | *(default `timeout`)* | |
| `openai/gpt-4.1` | *(default `timeout`)* | |
| `anthropic/claude-sonnet-4.5` | *(default `timeout`)* | |
| `openai/gpt-5.1-codex-max` | *(default `timeout`)* | |
| `anthropic/claude-3.7-sonnet` | `timeout` | Known timeout/504 on gateway |
| `openai/gpt-4o` | `timeout` | |
| `openai/gpt-4o-mini` | `zero-fix-rate` | |
| `anthropic/claude-3.5-sonnet` | `zero-fix-rate` | Low fix success vs stronger models in audits |
| `alibaba/qwen-3-14b` | `zero-fix-rate` | Small context + weak verification vs shown code; opaque 500s on modest prompts |
| `Qwen/Qwen3-14B` | `zero-fix-rate` | Alias of Qwen 14B on some gateways |

**Overrides and maintenance**

- **`PRR_ELIZACLOUD_INCLUDE_MODELS`:** comma-separated — removes matching ids from the effective skip set (retry a timeout-skipped model after infra improves). Hyphenless suffix match is supported (see `getEffectiveElizacloudSkipModelIds`).
- **`PRR_ELIZACLOUD_EXTRA_SKIP_MODELS`:** comma-separated — **adds** ids to the built-in skip list for this environment only.
- **`getElizaCloudSkipReason(id)`:** ids **not** in **`ELIZACLOUD_SKIP_REASON`** use default **`timeout`** so new skip entries still rotate with a sensible debug line until you assign **`zero-fix-rate`**.
- **Operational habit:** When **RESULTS SUMMARY** / Model Performance shows **0%** fix rate for an ElizaCloud id, add it (with reason + comment) to **`shared/constants.ts`** and bump the “last reviewed” line above — same guidance as **AGENTS.md**.

### Re-evaluating skips (maintainer)

1. **Evidence:** Use **RESULTS SUMMARY** → **Model Performance** in **`output.log`** (per-model success/fail counts). Pill may omit tables when the log is summarized — grep **`Model Performance`** in the raw log for critical runs (**AGENTS.md**).
2. **Timeout vs zero-fix:** **`getElizaCloudSkipReason(id)`** returns **`timeout`** (default) or **`zero-fix-rate`**. Timeout-skipped models may be worth retrying after gateway changes — set **`PRR_ELIZACLOUD_INCLUDE_MODELS`** to the full id (or short suffix per **`getEffectiveElizacloudSkipModelIds`**) for a trial run.
3. **Edit source of truth:** Change **`ELIZACLOUD_SKIP_MODEL_IDS`** and **`ELIZACLOUD_SKIP_REASON`** in **`shared/constants/models.ts`** (barreled as **`shared/constants.js`**). Run **`npm test`**; update the snapshot table above and **Last reviewed**.
4. **Env-only skips:** **`PRR_ELIZACLOUD_EXTRA_SKIP_MODELS`** merges comma-separated ids; **`PRR_ELIZACLOUD_INCLUDE_MODELS`** subtracts. Entries with **`//`**, empty tokens, or invalid characters are **dropped** with a one-time **`console.warn`** — fix the env string if a model you expected is missing from the effective list.

- **Per-run performance:** Success/failure is recorded in state; rotation can prefer better-performing models within the same run. **`PRR_SESSION_MODEL_SKIP_FAILURES`** skips a tool/model for the rest of the process after repeated verification failures with zero verified fixes.
- **`PRR_SESSION_MODEL_SKIP_RESET_AFTER_FIX_ITERATIONS`:** positive integer — each session-skipped tool/model key is removed after N **subsequent** completed **fix** iterations (counted from when that key was skipped), so rotation can retry it **without** restarting the process. **`0`** / unset = off. **WHY:** Long runs otherwise never revisit a model skipped early for transient failures (pill-output #847); per-key timing avoids clearing fresher skips on a single global boundary.

*Provider model tables: last curated from linked docs; verify there for current IDs and pricing.*
