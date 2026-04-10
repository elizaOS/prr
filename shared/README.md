# Shared library

Code shared across **prr**, **pill**, **story**, **split-exec**, and **split-plan**. This README covers modules that have non-obvious design or WHYs.

---

## `utils/tokens.ts` — Token estimation and truncation

**Purpose:** Single source of truth for token budgeting (chars-per-token) and for truncating long text while keeping head and tail visible.

**Exports:**
- **`CHARS_PER_TOKEN`** (4) — Rough chars per token for budgeting. **WHY:** Same constant everywhere avoids drift; aligns with `shared/llm/model-context-limits.ts` and provider docs.
- **`estimateTokens(text)`** — `Math.ceil(text.length / CHARS_PER_TOKEN)`. **WHY:** Good enough for context budgeting; not used for billing. Prr (prompt size checks), pill (log caps), and story-read (chapter sizing) all use this.
- **`truncateHeadAndTail(text, maxTokens, marker?)`** — Truncates to ~maxTokens chars, keeping head (2/3) and tail (1/3) with an optional marker in between. **WHY:** Start and end of logs/docs are highest signal; middle is often repetitive. Callers (e.g. pill) can pass a custom marker for audit messages (e.g. "504 timeout avoidance").
- **`truncateHeadAndTailByChars(text, maxChars, marker?)`** — Same idea with a character cap. **WHY:** Hard char caps (e.g. 50k for pill output log) avoid gateway 504 / FUNCTION_INVOCATION_TIMEOUT when token estimates undercount.

**WHY `Math.max(0, …)` for tailChars:** When the marker is long, `tailChars = maxChars - headChars - marker.length` can go negative. `text.slice(-tailChars)` with negative would be wrong. Clamping to 0 yields an empty tail but valid output.

---

## `llm/story-read.ts` — Chapter-by-chapter summarization with carried context

**Purpose:** Summarize long text (e.g. output.log, prompts.log) by splitting into chapters, sending each to an LLM with compressed context from previous chapters, and merging state (open questions, predictions, threads) into a final digest. Used by **pill** for large logs; reusable by any tool that needs to summarize huge logs or documents without losing narrative.

**Concepts:**
- **Chunking:** `chunkPlainText(text, chapterTokenBudget)` splits on **line boundaries** so chapters are readable and we never split mid-line. **WHY line boundaries:** Logs and docs are line-oriented; splitting mid-line would send broken context to the model.
- **Single line over budget:** If one line exceeds the chapter token budget and the current chapter is empty, we emit that line as its own chapter. **WHY:** Otherwise one giant line (e.g. a 50k-token minified blob) would become one oversized chapter and blow the model's context.
- **Prior context:** Before each chapter we pass compressed "open questions", "active predictions", and "story so far" (threads). **WHY:** The model builds understanding progressively; without carried context each chapter would be analyzed in isolation and the digest would lose narrative.
- **Default system prompt:** Asks for JSON with observations, answeredQuestions, newQuestions, refutedPredictions, threads, etc. **WHY:** Structured output lets us merge state and build a consistent digest; the prompt is tuned for "log from a software tool run" but can be overridden via options.
- **onChapterError:** `'break'` (default), `'skip'`, or `'throw'`. **WHY:** One bad chapter shouldn't kill the whole run; break returns digest so far; skip continues with empty analysis for that chapter.

**Exports:** `chunkPlainText`, `storyReadChapters`, `storyReadPlainText`, `parseChapterAnalysis`, `ChapterAnalysis`, `StoryReadClient`, `StoryReadOptions`. Pill's `processor.ts` wires its log formats (plain text, prompts.log pairs) to these; the core loop and schema live here so other tools can reuse them.

---

## Other shared modules

- **`logger.ts`** — Output log tee, prompts log, debug, formatNumber. See main README and pill README for pill hook and WHY dynamic import.
- **`config.ts`** — Loads .env, validates config. Used by prr, story, split-exec, split-plan. **`PRR_THINKING_BUDGET`** above **500,000** clamps with a warning (typo guard).
- **`constants.ts`** — LLM limits, batch sizes, **`ELIZACLOUD_SKIP_MODEL_IDS`** / **`ELIZACLOUD_SKIP_REASON`** (authoritative ElizaCloud skip list), session-skip envs. Operator snapshot: **[docs/MODELS.md](../docs/MODELS.md)** (“Rotation order and skip list”). Overrides: **`PRR_ELIZACLOUD_INCLUDE_MODELS`**, **`PRR_ELIZACLOUD_EXTRA_SKIP_MODELS`** (root README).
- **`llm/`** — rate-limit, elizacloud, model-context-limits. Used by prr and pill.
- **`git/`** — Clone, merge, commit, push, conflict detection. Used by prr and split-exec. Recovery / **`scanCommittedFixes`**: see **AGENTS.md** / **DEVELOPMENT.md** (no **`git-hooks.ts`** in this tree — hooks live in product repos).
- **`runners/`** — llm-api, cursor, aider, etc. Used by prr fixer lane.

See [CHANGELOG](../CHANGELOG.md) for WHYs on recent shared changes (tokens, story-read, thread replies, pill 504 avoidance).
