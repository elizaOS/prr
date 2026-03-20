# LLM Models Reference

This doc summarizes **current and legacy models** from official provider docs. Use it when choosing models or updating context limits (e.g. `tools/prr/llm/model-context-limits.ts` or `shared/llm/model-context-limits.ts`).

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

- **ElizaCloud / context limits:** When adding or changing models in `tools/prr/llm/model-context-limits.ts` (or `shared/llm/model-context-limits.ts`), use the **input** context (e.g. 200K tokens for Claude, 128K for GPT-4o) and leave headroom for completion (~20%).
- **Model IDs:** Prefer stable snapshot IDs (e.g. `claude-sonnet-4-5-20250929`) when you need reproducible behavior; use aliases (e.g. `claude-sonnet-4-6`) for "latest" behavior.
- **Claude 4.6:** See [Migrating to Claude 4.6](https://platform.claude.com/docs/en/about-claude/models/migration-guide) when moving from older Claude versions.

### Rotation order and skip list

- **llm-api / ElizaCloud:** Fallback rotation order is **`DEFAULT_MODEL_ROTATIONS`** in `shared/runners/types.ts`; at runtime the list usually comes from the runner’s **`supportedModels`** (gateway/API discovery) and is **filtered** in `tools/prr/models/rotation.ts` using **`getEffectiveElizacloudSkipModelIds()`** from `shared/constants.ts`. Do not assume the static table in `types.ts` is the exact live order.
- **Skip list (authoritative):** **`ELIZACLOUD_SKIP_MODEL_IDS`** in `shared/constants.ts` — currently includes `openai/gpt-5.2-codex`, `anthropic/claude-3-opus`, `openai/gpt-4.1`, `anthropic/claude-sonnet-4.5`, `openai/gpt-5.1-codex-max`, `anthropic/claude-3.7-sonnet`, `openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`. **`ELIZACLOUD_SKIP_REASON`** marks some as **`timeout`** vs **`zero-fix-rate`** (timeout skips may be worth retrying if the gateway was flaky). **Override:** **`PRR_ELIZACLOUD_INCLUDE_MODELS`** (comma-separated) removes matching IDs from the effective skip set. See README Configuration.
- **Per-run performance:** Success/failure is recorded in state; rotation can prefer better-performing models within the same run. Performance is not yet persisted across PRs.

*Provider model tables: last curated from linked docs; verify there for current IDs and pricing. PRR integration bullets above: align with `shared/constants.ts` as of repo checkout — if they drift, trust the source file.*
