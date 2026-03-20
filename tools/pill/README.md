# pill — Program Improvement Log Looker

**pill** audits a project using its **output.log** and **prompts.log** (from prr, story, or a previous pill run), then writes an improvement plan to **pill-output.md** and **pill-summary.md**. It does not run fixers, verify diffs, or commit — it is analysis-only.

---

## Why pill exists

- **prr** and **story** produce logs that describe what the tool did and what the LLM saw. Those logs are evidence of behavior: failures, retries, model rotations, and user-visible output.
- **WHY audit logs:** Logs often reveal patterns that code review misses: repeated failures pointing to prompt or logic bugs, bail-outs that suggest architectural issues, or documentation gaps. Turning that evidence into an actionable improvement plan helps improve the project (and the tool itself when run on prr’s own repo).
- **WHY analysis-only:** Earlier designs included fix/verify/commit cycles. That duplicated prr’s loop and made pill heavy and stateful. Analysis-only keeps pill simple: one LLM audit, append-only markdown output, no git or runner integration. You (or another process) decide what to do with the plan.
- **WHY two output files:** **pill-output.md** holds the full improvement list (summary + per-item details) so implementers have one place to work from. **pill-summary.md** holds a short, dated log of runs (pitch + link to pill-output) so you can see history at a glance without opening the full instructions file.

---

## How it works

1. **Context assembly** — Reads docs, source (with token budget), directory tree, and the target **output.log** and **prompts.log**. Log file names depend on `logPrefix` (see below). Large logs are summarized so the audit request stays within context and avoids 504 / FUNCTION_INVOCATION_TIMEOUT.
2. **Audit LLM** — Sends context to the configured audit model with a system prompt that asks for: a **pitch** (engaging 1–2 paragraph summary), a **summary** (technical overview), and **improvements** (file, description, rationale, severity, category).
3. **Output** — Appends one dated section to **pill-output.md** (full plan) and one entry to **pill-summary.md** (pitch + link). Uses `.toLocaleString()` for user-facing counts (no dependency on shared logger; see workspace rule).

**Context assembly (large logs and 504 avoidance):**
- When **output.log** is small (≤30k tokens and ≤100k chars), it is included in full. When it is large, we use **head** (first 400 lines) + **story-read middle** (chapter-by-chapter LLM summarization from `shared/llm/story-read.ts`) + **tail** (last 400 lines) + **excerpt** (high-signal lines: RESULTS SUMMARY, Model Performance, etc.). **WHY:** A full ~183k-char log caused 504; char and token thresholds trigger summarization earlier; head/tail preserve init and exit state.
- After assembly, the output log is capped at **40k chars** by default. Override with **`PILL_OUTPUT_LOG_MAX_CHARS`** (env) if you need a different limit. **WHY:** Hard char cap ensures the audit request never includes an unbounded log.
- When the log is large but no LLM client is available (e.g. dry-run), we send head + "[ … middle omitted (no summarization client) … ]" + tail + excerpt instead of raw. **WHY:** Sending raw in that path would still cause 504.
- **prompts.log** is included raw when under the same token threshold; otherwise it is summarized via story-read (pair PROMPT+RESPONSE per slug, chunked, then digest). See **shared/README.md** for story-read and **shared/utils/tokens.ts** for truncation.

**WHY logPrefix:** When prr runs, logs are `output.log` / `prompts.log`. When story runs, the shared logger uses `prefix: 'story'` so files are `story-output.log` / `story-prompts.log`. Pill uses its own logger with hardcoded `pill-output.log` / `pill-prompts.log`. The prefix tells pill which log pair to read (prr vs story vs pill-on-pill).

**WHY dynamic import in closeOutputLog:** The shared logger’s `closeOutputLog()` runs pill via dynamic `import('../tools/pill/orchestrator.js')` so that the main process never loads pill at startup. That avoids a circular dependency: orchestrator used to import `formatNumber` from `shared/logger.js`, while logger imported the orchestrator in the close path. We broke the cycle by using `n.toLocaleString()` in the orchestrator and keeping the pill hook behind a dynamic import.

**WHY errors propagate from runPillAnalysis when called from CLI:** The pill CLI should show real failures (missing API key, LLM error, parse/write error). The shared logger’s hook wraps `runPillAnalysis` in try/catch and swallows errors so that shutdown always completes and pill remains optional. Only the CLI path gets thrown errors.

---

## Usage

### Standalone (pill CLI)

```bash
# From repo root (must contain or specify logs)
node dist/tools/pill/index.js <directory> [options]
# or after npm link
pill <directory> [options]
```

- **&lt;directory&gt;** — Directory that contains the log files and project to audit (e.g. `.` or `~/.prr` if logs are there).
- **--audit-model &lt;model&gt;** — Model for the audit call (default: claude-opus-4-6).
- **--output-only** — Use only output.log (no prompts.log).
- **--prompts-only** — Use only prompts.log (no output.log).
- **--dry-run** — Run audit and show results; do not write pill-output.md or pill-summary.md.
- **--instructions-out &lt;path&gt;** — Override path for pill-output.md.
- **-v, --verbose** — Verbose logging (provider, model, token counts, plan preview).

Config (API keys, provider) is loaded from `<directory>/.env` and then `~/.pill/.env` (target overrides home). Same env vars as prr/story (e.g. `ELIZACLOUD_API_KEY`, `ANTHROPIC_API_KEY`).

- **PILL_CONTEXT_BUDGET_TOKENS** (optional, 8000–128000) — Max context tokens for the audit request (user + system). Default 35000. Set to **20000** (or lower) for models with a small context window to avoid 504 / FUNCTION_INVOCATION_TIMEOUT. Per-section caps (output log, prompts digest, source, docs, tree) scale with the budget. Each audit HTTP request uses at most **~42k chars** of user payload (plus system prompt); larger assembled context is **chunked** into multiple requests. Chunk sizing uses the same **chars/token (4)** as `estimateTokens` so a single chunk cannot balloon to ~75k chars (that mismatch caused ElizaCloud **504 / FUNCTION_INVOCATION_TIMEOUT**).
- **PILL_OUTPUT_LOG_MAX_CHARS** (optional) — Hard cap on output-log chars sent to the audit (default **40000**). Override if you need a different limit.

### Integrated (prr / story / split-exec / split-plan) — opt-in with --pill

When you run **prr**, **story**, **split-exec**, or **split-plan** with the **`--pill`** flag, the shared logger enables pill for that run. On normal exit (or Ctrl+C), `closeOutputLog()` runs pill on the logs that were just closed and prints the pitch and file paths to the real console (using the original console refs captured before patching). When `--pill` is not passed, pill does not run.

- **WHY opt-in:** Running pill on every run (especially for tools like split-exec that make no LLM calls) added cost and often produced empty or low-value output. Making pill explicit keeps default runs fast and lets users request analysis when they want it.
- **WHY run on close:** The logs are only complete and flushed after the tee streams are closed. Running pill before close would read incomplete or buffered content.
- **WHY orig refs:** The process console is patched to tee to the log file. Pill’s output (pitch, paths) should go to the user’s terminal, not into the log. We capture `console.log`/warn/error before patching and use those in the hook so the user sees pill’s message in the real console.
- **WHY reset pillAnalysisEnabled at start of block:** So the hook runs at most once even if something throws later; we set `pillAnalysisEnabled = false` before any await.
- **WHY double-init guard in initOutputLog:** If `initOutputLog` is called twice (e.g. in tests or re-entry), we must not overwrite the original console refs with the already-patched console. We only assign `origLogRef` / `origWarnRef` / `origErrorRef` when they are still null, so the first capture is preserved and the pill hook always has the real console.

---

## Failure modes and debugging

When pill records **no improvements**, it returns one of four distinct reasons so you can fix the cause (pill-output.md #3):

| Reason | Meaning | What to do |
|--------|---------|------------|
| **no_logs** | Output/prompts log for this prefix is empty or missing. | Ensure the tool that produced the logs (prr, story, split-exec) wrote to the expected files (e.g. `split-exec-output.log` when prefix is `split-exec`). Run from the directory that contains those logs, or pass that directory to the pill CLI. |
| **no_api_key** | No LLM API key configured for the chosen provider. | Set the right key in `.env`: `ELIZACLOUD_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` (see Configuration in main README). When pill runs from the hook, it uses the same env as the parent process. |
| **api_call_failed** | The audit LLM request failed (network, rate limit, model error). | Check the error message in the console or in the log line. Ensure the model ID is valid and the key has access. Look at **pill-prompts.log** for the request if it was written before the failure. |
| **zero_improvements_from_llm** | The audit ran successfully but the LLM suggested zero improvements. | Not a failure — the logs were analyzed and the model had nothing to add. |

**Where you see the reason:** When pill is run from the **CLI**, it prints a single line (e.g. `No improvements to record: No logs to analyze.`). When pill runs from the **hook** (after prr/story/split-exec close their logs), the shared logger prints a short message to the console (e.g. `[Pill] No logs to analyze (output/prompts log empty or missing for this prefix).`) and appends a `[Pill] No improvements to record (reason: …)` line to the output log. Check **pill-output.log** (or the tool’s output log) for the exact reason string.

---

## Output files

| File              | Purpose |
|-------------------|--------|
| **pill-output.md** | Full improvement plan: dated sections, summary, and per-improvement details (file, description, rationale, severity, category). Append-only. |
| **pill-summary.md** | Short run log: date, source (prr/story/pill), pitch, and link to the corresponding section in pill-output.md. Append-only. |

Numbers in user-facing strings (e.g. improvement counts) use `.toLocaleString()` for locale-aware formatting (e.g. comma thousands separators).

---

## Log file names and prefix

| Source        | Log prefix | output log         | prompts log          |
|---------------|------------|--------------------|----------------------|
| prr           | (none)     | output.log         | prompts.log          |
| story         | story      | story-output.log   | story-prompts.log   |
| pill (own CLI)| pill      | pill-output.log    | pill-prompts.log    |

Pill infers the pair from **logPrefix** in config (CLI passes it when invoked from the hook via `currentLogPrefix`). When auditing prr’s own repo, pill can also include **pill-output.log** in context when the primary logs are not pill’s own (pill-on-itself).

**If pill says "every PROMPT/RESPONSE entry is empty" but your prompts.log has content:** Pill reads both logs from the **same directory** (the one containing the output log). When pill runs from the prr hook, that directory is where prr wrote its logs. The "empty" conclusion means the prompts.log pill actually read had entry headers but no body text — either (1) a **different run** wrote that file (e.g. logging bug or different cwd), or (2) you are looking at a prompts.log in another directory. Run pill with the directory that contains the log **pair** you want (e.g. `pill /path/to/dir`), or run prr with `--pill` from the directory where you want both logs so the hook reads the same run's files.

---

## Architecture (brief)

- **cli.ts** — Commander; parses &lt;directory&gt; and options; resolves directory to absolute path.
- **config.ts** — Loads .env, builds PillConfig. **tryLoadPillConfig()** returns null instead of throwing (used by the shared logger hook so missing config doesn’t break shutdown).
- **context.ts** — Assembles PillContext: docs, source, tree, output log, prompts digest; story-read for large logs (head+tail+summarized middle); char cap (PILL_OUTPUT_LOG_MAX_CHARS); pill-on-itself handling. Uses `shared/utils/tokens.ts` and `shared/llm/story-read.ts`.
- **orchestrator.ts** — `runPillAnalysis(config)`: assemble context, call audit LLM, parse JSON, append to pill-output.md and pill-summary.md (or return paths in dry-run). No try/catch around the whole function so the CLI sees errors; the hook in logger catches and ignores.
- **llm/prompts.ts** — **AUDIT_SYSTEM_PROMPT** only (verify prompt was removed when the fixer was removed).
- **types.ts** — PillConfig, ImprovementPlan, Improvement, PillContext, etc.

---

## See also

- Main [README](../../README.md) — prr, story, and pill overview.
- [docs/README.md](../../docs/README.md) — Documentation index.
- [shared/README.md](../../shared/README.md) — Shared tokens and story-read (WHYs, context caps).
- [.cursor/rules/number-formatting.mdc](../../.cursor/rules/number-formatting.mdc) — User-facing numbers use `formatNumber` from logger or `n.toLocaleString()`.
