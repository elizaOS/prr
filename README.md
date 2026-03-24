// Note: prr is a whimsical name reflecting the fun, yet serious nature of this resolver tool.
# prr (PR Resolver)

```text
    /\_____/\
   /  o   o  \
  ( ==  ^  == )
   )         (
  (           )
 ( (  )   (  ) )
(__(__)___(__)__)

sits on your PR and won't get up until it's ready
```

CLI tool to automatically resolve PR review comments using LLM-powered fixing and verification. Works with comments from humans, bots, or any reviewer.

## Philosophy

There are plenty of AI tools that autonomously create PRs, write code, and push changes without human involvement. **prr takes a different approach.**

**Human-driven, AI-assisted**: You stay in control. You decide which PR to work on, when to run prr, and when it's done. The AI handles the tedious back-and-forth with reviewers (human or bot), but you're the driver.

**The right tool for the job**: Sometimes you want to manually address feedback. Sometimes you want AI to grind through 50 nitpicks from CodeRabbit. prr gives you the option without taking over your workflow.

**AI talking to AI, supervised by humans**: Modern PRs often involve bot reviewers (CodeRabbit, Copilot, etc.) that leave dozens of comments. Instead of manually addressing each one, let prr's AI negotiate with the reviewer AI while you focus on what matters. You can always interrupt, inspect, and override.

**Safe over sorry verification**: When PRR is unsure whether a fix really covers a lifecycle, cache, cleanup, or multi-path issue, it should keep the issue open instead of optimistically marking it fixed.

**WHY**: False negatives cost another pass. False positives hide real bugs, create misleading "all fixed" states, and make PR threads look cleaner than the code really is.

**Visible decisions over hidden confidence**: In verbose runs, PRR should show the actual per-comment decisions it is using internally, not just aggregate counts or a final "done" message.

**WHY**: When the PR still shows open comments, operators need to compare PRR's internal state with the GitHub conversation directly. A readable issue table makes classification mistakes obvious and auditable.

**Philosophy in practice**:
- Run prr on a specific PR (you choose)
- Watch it work, interrupt with Ctrl+C anytime
- Inspect the **PR clone** (workdir), modify files, continue — this is **not** necessarily the directory where you ran `prr` (`process.cwd()`); see [AGENTS.md](AGENTS.md) (“Clone workdir”).
- Push when *you* decide it's ready

## Features

### Core Loop
- Fetches review comments from PRs (humans, bots, or any reviewer)
- **Parses all bot comments**: Reads every comment from known review bots (not just the latest), with noise filtering and path-less issue recovery. *Why*: Bots may post multiple comments across re-reviews; parsing only the latest missed issues from earlier reviews.
- Uses LLM to detect which issues still exist in the code
- **Conservative issue detection for distributed bugs**: Lifecycle/cache/leak comments and ordering/history comments now get broader analysis context before PRR decides they are already fixed. *Why*: Some bugs live across declaration, usage, cleanup, and trimming sites; a narrow anchor snippet can make a real issue look resolved.
- **Path-resolution categories instead of blanket stale dismissals**: PRR now distinguishes `missing-file` from `path-unresolved`, and carries canonical resolved paths forward when a review cites a basename or truncated path. *Why*: "File no longer exists" was previously hiding very different root causes such as ambiguous basenames, summary-table leakage, and path fragments that only needed repo-path expansion.
- **Catalog-backed dismissal + auto-heal for bogus model-id advice**: Bots with stale training sometimes flag a **valid** OpenAI/Anthropic API id as a “typo” and suggest another valid id. When **both** ids appear in the committed **`generated/model-provider-catalog.json`**, PRR dismisses the comment in solvability and (by default) restores the catalog id inside quoted literals near the review line, then can commit when the run would otherwise skip the fix loop. *Why*: Avoids burning the fixer on bad vendor advice and prevents silent adoption of the wrong model string in code. See [DEVELOPMENT.md](DEVELOPMENT.md) (“Commit gate and catalog model auto-heal”) and [docs/MODELS.md](docs/MODELS.md).
- **Shared test-path inference**: Prompt building, create-file solvability, and retries now reuse the same test-target inference helper instead of maintaining slightly different regex copies. *Why*: When those phases drift, PRR can decide one test file should be created while another phase allows or explains a different one.
- Generates fix prompts and runs Cursor CLI, Claude Code, or opencode to fix issues
- **Config-driven concurrency**: Optional `PRR_MAX_CONCURRENT_LLM` (default 1) caps in-flight LLM requests; analysis batches, verification, and (with llm-api) parallel fix groups share this cap. On 429, concurrency is halved for 60s. *Why*: Default keeps behavior unchanged; raising (e.g. to 3) can cut wall-clock when the backend supports it. See Configuration.
- Verifies fixes with LLM to prevent false positives
- **Debug issue table**: Verbose mode prints a human-readable per-comment table after analysis and again at exit. *Why*: This exposes the exact `open` / `dismissed/<category>` / `verified` decision PRR is using so you can compare it with the PR thread list.
- **Final audit**: Adversarial re-verification of all issues before declaring success — asks what is still wrong (not “is it fixed?”) so weak verifiers do not rubber-stamp. Overrides that keep an issue verified despite UNFIXED are opt-in via `PRR_STRICT_FINAL_AUDIT`. See [DEVELOPMENT.md](DEVELOPMENT.md) and `PRR_FINAL_AUDIT_MODEL` in Configuration.

### Smart Retry Strategies
- **Lessons learned**: Tracks what didn't work to prevent flip-flopping between solutions
- **LLM-powered failure analysis**: Learns from rejected fixes to generate actionable guidance
- **Smart model rotation**: Interleaves model families (Claude → GPT → Gemini) for better coverage
- **Rotation order & skip list (llm-api/elizacloud)**: Default lists ordered by observed fix success (Claude first); models that 500/timeout or have 0% fix rate are in a skip list and never selected. *Why*: Audit showed 0%-success and error-prone models wasting rotation slots; leading with best performers improves throughput.
- **Duplicate prompt skip**: When the same set of issue IDs and lesson count is sent to the same model again, we skip the fixer and rotate to the next model. *Why*: Full-prompt hashes rarely matched; hashing issue IDs + lesson count detects same-issues-same-context and avoids redundant LLM calls.
- **Proportional batch reduce**: When the fix prompt exceeds the context cap, batch size is reduced proportionally (cap/promptLength) instead of halving. *Why*: Halving wasted iterations when only slightly over cap; proportional reduction converges in 1–2 steps.
- **Rotation reset per push iteration**: At the start of each push cycle (after the first), the model index resets to the first model so each cycle gets a "best model first" attempt instead of continuing from where the previous cycle left off. *Why*: Later push iterations were reusing the last model from the previous cycle (often one that had just 500'd or timed out), wasting time.
- **ALREADY_FIXED multi-model dismissal**: When 3+ consecutive models return ALREADY_FIXED for the same issue (any explanation), dismiss as already-fixed. Counter resets when the fixer makes changes or the issue is verified. *Why*: The existing same-explanation counter only fired when explanation text matched; a separate any-explanation counter catches the broader pattern where multiple models independently agree the issue is resolved.
- **couldNotInject in-loop dismissal**: At the start of each fix iteration, issues that have hit the could-not-inject threshold (file not in repo + no-change cycles) are dismissed and removed from the queue; if the queue is empty afterward, the run exits as all fixed. Create-file issues use a lower threshold (1) so we dismiss after one couldNotInject when the path was clearly "create this file". *Why*: The threshold was only checked at push-iteration start; inside the fix loop the same issues were retried 10+ times (output.log audit). Applying the check every iteration stops the loop; lower create-file threshold avoids retrying when the file is never created.
- **Apply-failure and no-changes handling**: When the fixer's search/replace fails to match (no files written), we treat it as no meaningful changes, skip verification, and persist a short "Previous attempt: …" for the next fix prompt. Per-file S/R failure count and consecutive no-changes use tuned thresholds (3 and 2) so we dismiss as remaining earlier instead of burning iterations. *Why*: output.log audit — the model wasn't getting explicit apply-failure feedback; passing it into the next attempt and bailing sooner reduces wasted runs. See [DEVELOPMENT.md](DEVELOPMENT.md) "Fix loop audits (output.log)".
- **Solvability for new comments**: When new bot comments arrive mid-fix-loop, they are run through the same solvability check (e.g. (PR comment), lockfiles) before being added to the queue; unsolvable ones are dismissed and not sent to the fixer. *Why*: New comments were previously added without solvability, so (PR comment) and other unfixable paths entered the queue and burned iterations (prompts.log audit).
- **Missing test files stay actionable**: If a review asks for a test/spec file that does not exist yet, PRR keeps that issue open as a create-file target instead of dismissing it as stale. *Why*: For missing-test comments, non-existence is often the thing the fixer is supposed to change.
- **Coverage-only wording on explicit test files stays in create-file flow**: If the review path already points at a missing `*.test.ts` file, PRR preserves that path even when the body says "coverage is missing here" instead of repeating "add tests". *Why*: The path itself is already strong evidence that the requested fix is to create or fill in that test file.
- **ALREADY_FIXED batch filter**: Issues the fixer has already said ALREADY_FIXED 2+ times are excluded from the next batch fix prompt (they are still dismissed at 3× by the existing counter). *Why*: Batch prompts were re-including those issues and the fixer would again return ALREADY_FIXED, wasting large prompts (prompts.log audit).
- **STALE→YES override (snippet not visible)**: When the batch verifier returns STALE but the explanation says "can't evaluate", "doesn't show", "only shows the beginning", or "incomplete", we override to YES so the issue is not falsely dismissed. *Why*: Judge instructions say use YES when code is not visible; the verifier often used different phrasings, causing 48 false STALE verdicts in one audit.
- **Hedged visibility (truncated snippet/excerpt suggests)**: Explanations that hedge on truncated context (e.g. "the truncated snippet suggests…", "the truncated excerpt suggests…") are treated as missing-code visibility, so we keep the issue open instead of accepting low-confidence STALE/NO. *Why*: "Suggests" or "appears to" with truncated context is uncertainty, not evidence the issue is fixed or obsolete.
- **Weak-identifier stale retargeting**: When a comment's line is out of range and the only backtick-extracted tokens are built-in/type names (e.g. `BigInt`, `symbol`, `Map`), PRR keeps the issue solvable with a context hint instead of dismissing as stale. *Why*: Those tokens are poor anchors; using "identifier not found" for them produced incorrect stale dismissals.
- **Single-issue focus mode**: When batch fixes fail, tries one issue at a time with randomization
- **Dynamic model discovery**: Auto-detects available models for each fixer tool
- **Stalemate detection & bail-out**: Detects when agents disagree, bails out after N cycles with zero progress
- **Large-prompt batch reduce**: When a fix prompt exceeds ~200k chars and fails (error or no-changes), the next fix iteration immediately uses a smaller batch size. *Why*: Oversized prompts cause gateway 500s and timeouts; reducing batch size on the next attempt keeps prompts within limits without burning rotation slots.

### Git Integration
- **Auto-stashing**: Handles interrupted runs gracefully by stashing/restoring local changes
- **Auto-rebase on push rejection**: If remote has new commits, automatically rebases and retries
- **Rebase vs merge detection**: When finishing after conflict resolution, we detect rebase (`.git/rebase-merge`) using the repo’s absolute path so the right command runs (`rebase --continue` vs `commit`). *Why*: PRR runs in a workdir that’s often not the process cwd; a relative `.git` path would miss `rebase-merge` and wrongly run `commit` during a rebase, leaving a stuck state.
- **Push retry cleanup**: If the post-rejection rebase fails (e.g. conflicts or "rebase-merge directory already exists"), we try `rebase --abort` first, then fall back to full git cleanup only if abort fails. *Why*: Abort restores commits; full cleanup is for stuck/corrupt state so the next run isn’t blocked.
- **Non-interactive rebase continue**: All `rebase --continue` paths use `continueRebase(git)`, which sets `GIT_EDITOR=true` so git never opens an editor. *Why*: In headless/workdir runs there’s no TTY; the configured editor would fail with "Standard input is not a terminal" or "problem with the editor 'editor'". One helper keeps behavior consistent.
- **Base branch merge (explicit refspec):** When merging the PR's base branch (e.g. `v2.0.0`) into the PR branch, PRR fetches the base with an explicit refspec (`+refs/heads/<branch>:refs/remotes/origin/<branch>`) so the tracking ref is always updated. *Why*: On `--single-branch` clones the default fetch config only includes the PR branch; a plain `git fetch origin v2.0.0` would not update `origin/v2.0.0`, leaving a stale ref and the merge-base check incorrectly reporting "already up-to-date", so the PR would stay "dirty" on GitHub. Explicit refspec forces the ref to match the remote tip every run.
- **Auto-conflict resolution**: Uses LLM tools to resolve merge conflicts automatically. Resolution is **3-way** (base + ours + theirs), with **sub-chunking** at AST boundaries when a conflict region exceeds the model’s segment cap, and **validation** (parse TS/JS) before write/stage. When the main path fails, a **top+tails fallback** runs (whole-file story + top of conflict + tail OURS/theirs). Parse validation failures trigger up to two retries with the error (and location) in the prompt. *Why*: Two-way merge forces the model to guess; proper merge needs the common ancestor. Oversized regions are split at statement boundaries. Fallback gives a second chance without changing the default path. See [tools/prr/CONFLICT-RESOLUTION.md](tools/prr/CONFLICT-RESOLUTION.md).
- **Conflict prompt injection skip**: File-content injection is skipped for conflict-resolution prompts. *Why*: The conflict prompt already embeds each file; re-injecting would duplicate content (e.g. CHANGELOG twice), blow prompt size, and cause 504s.
- **Large conflicted files (chunked embed)**: For files over ~30k chars with conflicts, only the conflict sections (with context) are embedded in the prompt, not the full file. *Why*: Full-file embed doubles prompt size and causes 504s; sections are enough for correct `<search>`/`<replace>` output.
- **Token auto-injection**: Ensures GitHub token is in remote URL for push authentication; fetch and pull also use the token when the remote has no credentials (one-shot auth URL), so "Checking for conflicts" and pull never hang on a password prompt. **Why:** Repos cloned without token in the URL would otherwise block during fetch with no visible output; timeout + token fix it (see CHANGELOG).
- **CodeRabbit auto-trigger**: Detects manual mode and triggers review on startup if needed
- Batched commits with LLM-generated messages (not "fix review comments")
- **Thread replies (GitHub feedback)**: With `--reply-to-threads`, PRR posts a short reply on each review thread when it fixes or dismisses an issue (e.g. "Fixed in \`abc1234\`." or "No changes needed — already addressed before this run."). Optional `--resolve-threads` collapses replied threads. **WHY:** Reviewers see visible feedback in the PR conversation instead of only in PRR's exit summary; one reply per thread keeps noise low and leaves room for human follow-up. See [docs/THREAD-REPLIES.md](docs/THREAD-REPLIES.md).

### Token & cost optimizations
- **Fix iterations default**: `--max-fix-iterations` defaults to `0` meaning *unlimited* — the fix loop runs until all issues are resolved or another exit (e.g. stalemate). *Why*: Previously 0 was used literally so the loop ran zero times; we now map 0 to "no cap" so the default behaves as documented.
- **Think-tag stripping**: Models like Qwen emit `<think>` reasoning blocks; we strip them from responses and ask Qwen not to emit them. *Why*: Saves ~30% output tokens and avoids breaking parsers that expect responses to start with "YES"/"NO".
- **Verifier rejection cap**: After the verifier rejects an issue twice (fix or ALREADY_FIXED claim), we dismiss it as "exhausted" and stop retrying. *Why*: Fixer/verifier stalemates otherwise loop indefinitely.
- **No-verified-progress exit**: After two consecutive push iterations with zero new verified fixes, we exit cleanly. *Why*: Same issues keep failing; re-run after manual edits or new bot comments.
- **Dismissal-comment pre-check**: Before calling the LLM to generate a "Note:" comment, we check a ±7 line window for an existing Note:/Review: comment, and also skip when the reason already describes a code change (already-fixed). *Why*: Avoids redundant LLM calls when a comment was already added or the fix is self-documenting.
- **Skip dismissal LLM for already-fixed**: We no longer call the LLM to generate a Note for issues dismissed as already-fixed; code/diff is self-documenting. *Why*: Audit showed 62% of dismissal LLM responses were EXISTING; skipping saves tokens.
- **Relax file constraint on retry**: When the fixer returns CANNOT_FIX/WRONG_LOCATION and mentions another file, we persist that path and allow it on the next attempt so the fixer can edit the correct file. *Why*: Prompts.log audit showed 7 identical 33k-char prompts for one cross-file issue; persisting the other file avoids burning all models and can resolve on retry.
- **Persisted dedup cache**: LLM dedup results are stored in state keyed by comment ID set; repeat runs with the same comments skip the dedup LLM step. *Why*: In-memory cache reset each run; persisting saves tokens and latency.
- **Heuristic dedup same-caller**: Comments on the same file that share the same primary symbol (e.g. method name) and the same caller file (e.g. "runner.py:146") are merged even when authors differ. *Why*: Prompts.log audit showed duplicate issues from cursor vs claude describing the same async/caller mismatch; merging them avoids duplicate fix attempts.
- **Dedup GROUP validation + prompt guard**: Dedup now rejects malformed `GROUP:` lines when any index is out of range or the canonical index is not in the group, and the prompt explicitly says valid indices are only `1..N`. *Why*: A prompts.log audit showed the model returning `GROUP: 2,5,7` for only 3 comments; rejecting invalid groups avoids wrong merges and the prompt reduces those hallucinations up front.
- **Verifier strength for API/signature fixes**: Fixes whose comment mentions async/await, caller, signature, or TypeError are verified with a stronger model when available. *Why*: Weak default verifier approved a fix that missed the call-site update (e.g. print_results still calling generate_report() without await/args); stronger model catches call-site bugs.
- **Verifier expanded context for type/signature issues**: When a review comment mentions async/await, signatures, TypeErrors, or callers, the verifier sees up to 500 lines of the file (vs default 200). *Why*: Type/signature fixes often involve function bodies and their call sites; the default window was too narrow, causing false "never assigned" rejections.
- **Lifecycle-aware verification context**: Comments about leaks, stale cache entries, missing cleanup, or unbounded maps/sets now get lifecycle-aware snippets that include declaration, usage, and cleanup sites across the file, and they bypass the risky "pattern absent" auto-verify shortcut. *Why*: These issues are about control flow over time, not a single line. A narrow local snippet can make a broken cleanup path look fixed.
- **Ordering-aware analysis context**: Comments about newest-vs-oldest retention, `fromEnd`, or history trimming now use either full-file context or multi-range ordering excerpts during analysis. *Why*: These bugs usually depend on the interaction between data ordering and a later selection call; a single local excerpt often misses half the bug.
- **Dismissal-comment skips**: We skip the dismissal-comment LLM when the reason says "file no longer exists" or "file not found", and we post-filter generated comments that only restate the surrounding code. *Why*: Avoids sending a prompt for a missing file and avoids inserting generic "extracts metrics"-style noise.
- **Multi-file nudge**: When TARGET FILE(S) lists multiple files and the review mentions callers (await, file:line), the fix prompt adds a line urging updates to implementation and every call site. *Why*: Reduces fixer updating only one file and leaving call sites broken.
- **Wider batch snippets**: When context headroom ≥100k chars, batch verification uses 2500/3000 char limits per comment/code snippet (vs 2000/2000). *Why*: Reduces false positives from truncation.
- **Rotation by success rate**: Legacy model rotation orders models by persisted success rate (best first). *Why*: Low-success models no longer get tried before proven performers.
- **CodeRabbit analysis chain stripping**: Comment bodies are sanitized to remove CodeRabbit "Analysis chain" and "Script executed" blocks before analysis/fix prompts. *Why*: CodeRabbit embeds 5–15 shell runs per comment (~200–1500 chars each); the analyzer only needs the actual finding, not script output—saves ~30% on affected prompts.
- **No-op change skip**: Identical search/replace blocks from the fixer are skipped. *Why*: Prevents wasted verification and keeps file-change counts accurate.
- **All-no-op skip verification**: When every fixer change block was a no-op (search === replace), we treat the iteration as "no changes" and skip the verification LLM call, going straight to rotation. *Why*: Avoids running the verifier on unchanged code; saves latency and keeps behavior consistent with git state.
- **Skip model recommendation for 1–2 issues**: The separate model-recommendation LLM call runs only when there are 3+ unresolved issues; otherwise we use default rotation. *Why*: Saves ~29s and tokens on simple runs.
- **Skip predict-bots when --no-wait-bot**: When `--no-wait-bot` is set, we skip the LLM "likely new bot feedback" prediction after commit. *Why*: Prediction is display-only; skipping saves ~26s when the user isn't waiting for bot reviews.
- **Predict-bots changed-files guard**: The display-only predictor skips tiny meta-only diffs (e.g. small `.gitignore` changes), tells the model to output only files present in the commit diff, and filters predictions to `changedFiles`. *Why*: A prompts.log audit showed the predictor hallucinating `scripts/build-skills-docs.js` from a `.gitignore`-only diff; filtering to actual changed files saves tokens and removes noisy UX output.
- **Lesson caps for large batches**: When fixing 10+ issues at once, we cap global and per-file lessons so the prompt stays under ~100k chars. *Why*: Prevents gateway timeouts and prompt poisoning from oversized prompts.
- **LLM dedup only for 3+ issues**: The LLM dedup step runs only for files with at least 3 remaining issues after heuristic dedup. *Why*: For 2-comment files, heuristic grouping is enough; skipping the LLM saves tokens with no meaningful loss.
- **maxFixIterations 0 = unlimited**: `--max-fix-iterations 0` is treated as unlimited (not zero). *Why*: Without this, 0 meant zero iterations and the run did analysis-only with no fix attempts.
- **File injection by issue count & dynamic budget**: Injected file contents are chosen by how many issues reference each file (most first); total injection budget is tied to the model’s context cap. *Why*: Puts the injection cap toward files most likely to need search/replace; avoids overshooting small-context or underusing large-context models.
- **Batch injection filter (rounds 2+)**: In later fix rounds, file injection is limited to files that still have at least one unfixed issue via `allowedPathsForInjection`. *Why*: Already-fixed files waste context budget; filtering keeps the prompt focused and leaves room for files that need changes.
- **Single-issue full file context**: Single-issue fix prompts send the full file (up to 600 lines) instead of a short snippet. *Why*: Models responded INCOMPLETE_FILE/UNCLEAR when given only 15-30 lines; full file gives enough context for correct fixes.
- **Rewrite escalation for non-injected files**: Files mentioned in the prompt but not injected (or with repeated S/R failures) are escalated to full-file rewrite. *Why*: When the model never saw file content, search/replace usually fails; asking for the full file avoids matching failures.
- **Delay full-file escalation for simple issues**: For files where all targeting issues have importance ≤ 3 and ease ≤ 2, we only escalate to full-file rewrite when the file was not injected (not when over S/R failure threshold). *Why*: Full-file rewrites are expensive and time out more; for simple issues we rely on S/R first.

### Robustness
- Hash-based work directories for efficient re-runs
- **State persistence**: Resumes from where it left off, including tool/model rotation position and dedup cache (comment set → duplicate grouping). *Why*: Dedup is deterministic for the same comment set; persisting avoids re-running the dedup LLM on every run.
- **Model performance tracking**: Records which models fix issues vs fail, displayed at end of run; used to sort rotation order (best first). *Why*: Tries proven models before chronic low performers.
- **5-layer empty issue guards**: Prevents wasted fixer runs when nothing to fix
- **Graceful shutdown**: Ctrl+C saves state immediately; double Ctrl+C force exits
- **Session vs overall stats**: Distinguishes "this run" from "total across all runs"
- **Prompt size and injection caps**: Base prompt + injected file content are capped (e.g. 200k total) with a minimum injection allowance so the model still sees key files when the base prompt is large. *Why*: Prevents gateway 500s from oversized requests while avoiding "zero injection" when the base is already big.
- **No-changes parsing**: When the fixer reports "no changes", the explanation is parsed from prose only; content inside `<change>`, `<newfile>`, and `<file>` blocks is ignored. *Why*: Prevents false positives from code or test fixtures that happen to contain phrases like "already fixed" or "no changes".
- **Empty snippet handling**: When the judge or fix-verifier has no code snippet for an issue, we show an explicit placeholder instead of an empty block (e.g. "snippet unavailable — do NOT respond STALE"). *Why*: Empty blocks forced the model to guess; the placeholder steers toward YES-with-explanation when code isn't visible and avoids false STALE.
- **Grouping rule (same method, different fix)**: Comment dedup does not group comments that target the same method but require different fixes (e.g. "add method" vs "change call site"). *Why*: Wrong merges cause one fix to address both or drop nuance; the rule reduces false groupings observed in audits.
- **Recap/meta bare-file filtering**: Summary/status recap blocks are filtered before path inference, and bare filenames are only treated as actionable when the comment wording clearly points to a file-specific fix. *Why*: Review recaps like "| Location | Suggestion |" were leaking `banner.ts`, `logger.ts`, and `reply.ts` into the queue as fake file issues.
- **Incomplete-snippet verdict recovery**: Explanations that admit the model could not actually see enough code now keep the issue open even if the model answered `NO`, not just `STALE`. *Why*: "Fixed" is not trustworthy when the verifier explicitly says the relevant code was truncated or not visible.
- **504/gateway timeout: two retries with backoff**: On 504 or request timeout, we retry up to twice with 10s then 20s delay. *Why*: Single retry was often insufficient for transient gateways; two retries give the gateway time to recover.
- **AAR exhausted list**: The After-Action Report lists every exhausted issue (path:line) so operators know which need human follow-up. *Why*: Exhausted issues were only summarized by count; listing them makes follow-up actionable.
- **Judge rule (NO when code already implements)**: Batch verification prompt instructs the judge to respond NO and cite code when the current code already addresses the review. *Why*: Reduces unnecessary ALREADY_FIXED fix attempts when the judge would otherwise say YES.
- **Model recommendation wording**: We ask "explain why these models in this order" instead of "brief reasoning". *Why*: Models echoed "brief reasoning" literally; the new wording yields actionable explanation.
- **Credential redaction in push logs**: All push and rebase error/debug output is sanitized so `https://token@host` is never logged. *Why*: Git errors can contain remote URLs with tokens; redacting prevents credential leakage.
- **Worktree-safe rebase detection**: Rebase-vs-merge and "rebase still in progress?" use a shared helper that resolves the real git dir when `.git` is a file (worktrees). *Why*: In worktrees the check would otherwise fail; one implementation keeps completeMerge and pull conflict loop correct.

## Installation

This repo contains **prr** (PR Resolver), **pill** (Program Improvement Log Looker), **split-plan** (PR decomposition planner), **split-exec** (execute split plan), and **story** (PR narrative & changelog). All use a shared library under `shared/`; tool code lives under `tools/prr/`, `tools/pill/`, `tools/split-plan/`, `tools/split-exec/`, and `tools/story/`.

```bash
npm install
npm run typecheck

# Run prr directly
node dist/tools/prr/index.js <pr-url>
```

### Story: PR or branch narrative & changelog

The **story** tool builds a narrative, feature catalog, and changelog (Added/Changed/Fixed/Removed) from a PR or branch. Three modes: **PR** (title/body + commits + files), **single branch** (commit history only, no comparison), **two branches** (`--compare <branch>`; order auto-detected, story is about the branch you passed first). See **[tools/story/README.md](tools/story/README.md)** for full documentation and WHYs.

### Split-plan: PR decomposition planner

The **split-plan** tool analyzes a large PR (diffs, commits, dependencies), discovers open PRs on the same base branch as “buckets,” and writes a human-editable `.split-plan.md` with a dependency analysis and a proposed split into smaller, reviewable PRs. *Why*: LLM agents often produce PRs that mix refactors, features, and fixes; splitting by concern keeps reviews human-sized. **split-exec** reads that plan and iteratively cherry-picks commits into existing or new PR branches and opens new PRs. See **[tools/split-plan/README.md](tools/split-plan/README.md)** and **[tools/split-exec/README.md](tools/split-exec/README.md)** for full documentation and WHYs.

### Pill: Program Improvement Log Looker

**pill** audits a project using its output.log and prompts.log (from prr, story, split-exec, or a previous pill run) and appends an improvement plan to **pill-output.md** and **pill-summary.md**. It is analysis-only: no fixers, verification, or commits. *Why*: Logs are evidence of behavior (failures, retries, model rotations); turning that into an actionable plan helps improve the project without duplicating prr’s fix loop. Pill runs on close only when you pass **`--pill`** (prr, story, split-exec, split-plan). See **[tools/pill/README.md](tools/pill/README.md)** for full documentation and WHYs.

```bash
# Or link globally (prr, pill, split-plan, split-exec, and story available)
npm link
prr --version     # See the cat!
pill --help       # Pill CLI
split-plan --help  # PR decomposition planner
split-exec --help  # Execute split plan (cherry-pick, push, create PRs)
story --help      # PR narrative & changelog
```

## Configuration

**Operator env quick reference** (see `.env.example` for comments):

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | GitHub API access |
| `ELIZACLOUD_API_KEY` / provider keys | LLM gateway or direct API |
| `PRR_LLM_MODEL` | Pin the primary fixer/verifier model |
| `PRR_VERIFIER_MODEL` | Stronger model for batch verification (when default is weak) |
| `PRR_FINAL_AUDIT_MODEL` | Model for adversarial final-audit pass only |
| `PRR_STRICT_FINAL_AUDIT` | `1` / `true` — exit **2** when final audit overrides keep issues verified |
| `PRR_MAX_CONCURRENT_LLM` | In-flight LLM cap (default `1`) |
| `PRR_ELIZACLOUD_EXTRA_SKIP_MODELS` | Comma-separated ids **added** to the built-in ElizaCloud skip list (`shared/constants.ts` **`ELIZACLOUD_SKIP_MODEL_IDS`**) |
| `PRR_ELIZACLOUD_INCLUDE_MODELS` | Comma-separated ids to **remove** from the built-in skip list (re-enable after transient timeouts) |
| `PRR_SESSION_MODEL_SKIP_FAILURES` | Skip a model for the rest of the run after N zero-fix verification failures (`0` = off) |
| `PRR_DIMINISHING_RETURNS_ITERATIONS` | Warn after N consecutive iterations with no new verified fixes (`0` = off) |
| `PRR_EXIT_ON_STALE_BOT_REVIEW` | `1` / `true` — exit setup **before clone** if bot review SHA ≠ PR HEAD (stale inline comments) |
| `PRR_EXIT_ON_UNMERGEABLE` | `1` / `true` — exit setup **before clone** when GitHub reports **`mergeable: false`** or **`mergeableState: dirty`** and **`--merge-base` is not set** |
| `PRR_CLEAR_ALL_DISMISSED_ON_HEAD` | `1` / `true` — on PR HEAD change, clear **all** dismissals (default: only **`already-fixed`**) |
| `PRR_DISABLE_LATENT_MERGE_PROBE` | `1` / `true` — skip **`git merge-tree`** dry-merge vs `origin/<prBranch>` during sync (default: probe on) |
| `PRR_DISABLE_LATENT_MERGE_PROBE_BASE` | `1` / `true` — skip the **second** dry-merge vs `origin/<prBase>` (GitHub mergeable/dirty); default runs when base ≠ PR branch |
| `PRR_MATERIALIZE_LATENT_MERGE` | `1` / `true` — when the PR-tip probe predicts conflicts, run **`git merge origin/<branch> --no-commit --no-ff`** before pull so LLM conflict resolution can run early |
| `PRR_MATERIALIZE_LATENT_MERGE_BASE` | `1` / `true` — when the **PR-vs-base** probe predicts conflicts, run **`git merge origin/<prBase> --no-commit --no-ff`** for early LLM resolution |
| `PRR_BOT_LOGIN` | GitHub login for thread-reply idempotency when using `--reply-to-threads` |

**CLI (related):** pass **`--merge-base`** when GitHub reports the PR as not mergeable / dirty and you want PRR to merge the PR base before the fix loop.

Create a `.env` file (see `.env.example`):

```bash
# Required
GITHUB_TOKEN=ghp_xxxx

# LLM for verification (anthropic or openai)
PRR_LLM_PROVIDER=anthropic
PRR_LLM_MODEL=claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=sk-ant-xxxx

# Or use OpenAI
# PRR_LLM_PROVIDER=openai
# PRR_LLM_MODEL=gpt-4o
# OPENAI_API_KEY=sk-xxxx

# Default fixer tool (rotates automatically when stuck)
# If not set, prr will auto-detect which tool is installed
# PRR_TOOL=cursor

# Optional: max concurrent LLM requests (default 1). Raise to reduce wall-clock time when the backend allows.
# PRR_MAX_CONCURRENT_LLM=3
# Optional: min delay in ms between starting successive requests per slot (default 6000). Override if tuning rate limits.
# PRR_LLM_MIN_DELAY_MS=6000
# Optional: comma-separated ElizaCloud model IDs to include even if on the skip list (e.g. if timeouts were gateway-specific).
# PRR_ELIZACLOUD_INCLUDE_MODELS=openai/gpt-4o-mini,anthropic/claude-3.7-sonnet
```

**Concurrency (optional)**  
- **`PRR_MAX_CONCURRENT_LLM`** (integer 1–32, default unset ⇒ 1): Maximum number of LLM requests in flight at once. Analysis batches, verification, and (when using llm-api) parallel fix groups all share this cap. **WHY:** Default 1 keeps behavior unchanged and avoids 429s; raising it (e.g. to 3) lets analysis and fix run in parallel and can cut wall-clock time significantly when the backend (e.g. ElizaCloud) supports it.  
- **`PRR_LLM_MIN_DELAY_MS`** (integer ≥ 0, default unset ⇒ 6000): Minimum milliseconds between starting successive requests per slot. **WHY:** Spacing requests reduces burst 429s; override only when tuning for a specific gateway.

**ElizaCloud skip-list override (optional)**  
- **`PRR_ELIZACLOUD_INCLUDE_MODELS`** (comma-separated model IDs): Models to *include* in rotation even if they are on the default skip list (e.g. `openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-3.7-sonnet`). **WHY:** Those models are skipped by default because audits showed timeouts or 0% fix rate on some gateways; if your environment is different, set this to re-enable them (e.g. `PRR_ELIZACLOUD_INCLUDE_MODELS=openai/gpt-4o-mini`). Full IDs or short names (e.g. `gpt-4o-mini`) both work.

**Fix-loop hygiene (optional)**  
- **`PRR_SESSION_MODEL_SKIP_FAILURES`** (integer, default **4**; set **`0`** to disable): After this many cumulative verification failures for a tool/model pair **with no verified fix in this process**, skip that model until the next run; a verified fix clears the skip. **WHY:** Audit runs showed 0%-success models still consuming rotation slots; skipping for the rest of the session saves tokens without editing the static skip list in code.  
- **`PRR_DIMINISHING_RETURNS_ITERATIONS`** (integer, default **10**; set **`0`** to disable): Emit one **warning** when this many consecutive fix iterations produce **no** new verified fixes. **WHY:** Gives operators a visible cue to intervene (merge base, manual edits, or stop) instead of burning API budget quietly.

**Clone / fetch (optional)**  
- **`PRR_CLONE_TIMEOUT_MS`** (default 900000): Max ms for the initial clone. Large repos or slow connections may need more (e.g. 600000 for 10 min). Progress is logged every 30s.
- **`PRR_CLONE_DEPTH`** (optional): If set to a positive integer (e.g. `1`), clone uses **`git clone --depth`** (shallow clone). Faster on huge repos; trade-off: incomplete history.
- **`PRR_FETCH_TIMEOUT_MS`** (default 60000): Max ms for fetch during update/merge. Increase for slow networks. Non-integer env values use the default; **`--verbose`** logs a debug line if the value is invalid.
- **`PRR_LLM_TASK_TIMEOUT_MS`** (optional): Max ms per concurrent pool worker for LLM batch verification and parallel fix groups. Unset or `0` = no cap; env values below 5000 ms clamp to 5000.
- **Latent merge probe (sync):** After **`git fetch`**, **`checkForConflicts`** runs **`git merge-tree --write-tree`** on **`HEAD`** vs **`origin/<prBranch>`** (Git 2.38+) so PRR can warn about conflicts **before** `git status` shows an in-progress merge. A **second** probe runs **`HEAD`** vs **`origin/<prBase>`** when the PR’s GitHub base differs from the PR branch — closer to **mergeable / dirty** than the PR-tip probe alone. **`PRR_MATERIALIZE_LATENT_MERGE=1`** / **`PRR_MATERIALIZE_LATENT_MERGE_BASE=1`** start the matching real **`git merge --no-commit`**. **`PRR_DISABLE_LATENT_MERGE_PROBE=1`** / **`PRR_DISABLE_LATENT_MERGE_PROBE_BASE=1`** turn each probe off (e.g. huge repos).

**Provider model catalog (optional)**  
- **`PRR_MODEL_CATALOG_PATH`**: Absolute or relative path to a `model-provider-catalog.json` override. **WHY:** Forks or air-gapped runs can point at a custom snapshot; default is the repo’s `generated/model-provider-catalog.json`.
- **`PRR_DISABLE_MODEL_CATALOG_SOLVABILITY=1`**: Skips solvability check **0a6** (no dismissal of “both ids in catalog” model-typo advice). **WHY:** Escape hatch if framing regex misfires or you want every comment analyzed by the LLM regardless.
- **`PRR_DISABLE_MODEL_CATALOG_AUTOHEAL=1`**: Skips deterministic file rewrite for those comments (dismissal still applies when solvability is enabled). **WHY:** Inspect or fix strings manually without PRR touching the workdir.

**Audit / exit (optional)**  
- **`PRR_STRICT_FINAL_AUDIT`**: Set to `true` or `1` to exit with code **2** when the run succeeds but **audit overrides** exist (issues kept verified despite final audit UNFIXED). Default exit remains **0** in that case.
- **`PRR_FINAL_AUDIT_MODEL`**: Model id for the **adversarial final-audit** pass only. If unset, PRR uses **`PRR_VERIFIER_MODEL`** if set, else **`PRR_LLM_MODEL`**. **WHY:** Small default verifiers can mark UNFIXED by repeating review text while the prompt already shows fixed code; pinning a stronger model (often the same as the fixer) reduces false re-queues.

On 429 (rate limit), PRR calls `notifyRateLimitHit()` and temporarily halves effective concurrency for 60s so the next run backs off without a code change.

### Troubleshooting (state, summary, logs)

- **Where state lives:** Per-PR resolver state is **`.pr-resolver-state.json`** at the **root of the clone workdir** (same directory as the PR checkout — see verbose lines like **Reusing existing workdir** or **Workdir preserved**). Lessons may live under **`.prr/`** inside that clone; resolver state is **not** only under **`.prr/`**.
- **Stale or contradictory decisions:** If the debug issue table or **RESULTS SUMMARY** looks wrong after a rebase, force-push, or manual edits, delete **`.pr-resolver-state.json`** in that workdir and re-run PRR (or remove the workdir with **`--no-keep-workdir`** on a previous run, then run again so clone is fresh). **WHY:** Head-change rules clear **verified** (and some dismissals), but a corrupted or hand-edited file can still confuse a run.
- **Same comment ID in both verified and dismissed:** PRR enforces **verified ∩ dismissed = ∅** on **load** and when marking verified/dismissed; overlap at end-of-run is unexpected — treat as a bug and **delete the state file** after capturing **`output.log`**. Debug logs may still list **Overlap IDs** during the run while repair runs.
- **`verifiedFixed` huge vs current PR (yellow warning):** Often stale IDs from older PR heads; pruning uses **`currentCommentIds`** for display. Clearing state resets counts.
- **Final audit re-queues:** **RESULTS SUMMARY** shows **Final audit re-queued: N** when the adversarial pass said **UNFIXED** for issues that were previously verified (safe-over-sorry). Details and paths appear in the **After Action Report** block and in **`output.log`**.
- **Re-verify everything:** **`--reverify`** ignores cached verification for another pass without deleting state (see CLI table).
- **State committed to git by mistake:** Run **`prr`** with **`--clean-state`** on the same PR URL to remove **`.pr-resolver-state.json`** from git tracking in the workdir (cleanup mode); use **`--clean-all`** for broader cleanup. See **`prr --help`**.
- **`PRR_FETCH_TIMEOUT_MS`:** Non-numeric values fall back to the default; with **`--verbose`**, a debug line notes invalid values. Check for typos if your setting seems ignored.
- **`PRR_LLM_TASK_TIMEOUT_MS`:** Optional per pool-task wall-clock cap (ms) for concurrent LLM batches / fix groups (`runWithConcurrency`). Unset or `0` = no cap. Env values below `5,000` ms are clamped to `5,000`. Invalid values disable the cap and log a debug line when verbose. Programmatic override: `runWithConcurrency(tasks, n, { taskTimeoutMs })` (no clamp; for advanced use / tests).
- **Partial base-merge resolutions:** When merge with **`origin/<base>`** fails part-way, PRR stores resolved file text in state for the next run. If **`origin/<base>`** moves to a new commit before you re-run, that cache is **cleared** so you don’t reuse content from an old merge attempt.
- **Model catalog missing:** If **`generated/model-provider-catalog.json`** is absent, solvability **0a6** (dismiss bogus “model typo” noise) is **skipped** with a one-time console warning — run **`npm run update-model-catalog`** (or set **`PRR_MODEL_CATALOG_PATH`**).

### Why These Defaults?

- **Claude Sonnet 4.5** for verification: Best balance of accuracy and speed. Opus is overkill for yes/no verification. Haiku misses edge cases.
- **Cursor** as default fixer: Most capable agentic coding tool. Falls back to others automatically.

## Usage

```bash
# Basic usage - auto-detects installed CLI tool
prr https://github.com/owner/repo/pull/123

# Shorthand syntax
prr owner/repo#123

# Auto-push mode - full automation loop
prr https://github.com/owner/repo/pull/123 --auto-push

# Use specific fixer tool
prr https://github.com/owner/repo/pull/123 --tool claude-code

# Dry run - show issues without fixing
prr https://github.com/owner/repo/pull/123 --dry-run
```

### Story (examples)

```bash
# PR
story https://github.com/owner/repo/pull/123
story owner/repo#456

# Single branch (commit history only)
story owner/repo@feature/siwe
story https://github.com/owner/repo/tree/feature/siwe

# Two branches (story from older → newer; primary branch = first arg)
story https://github.com/owner/repo/tree/v2-develop --compare v1-develop

# Write to file; verbose; tune context size
story owner/repo#456 --output CHANGELOG.md
story owner/repo@branch -v --max-commits 200 --max-files 500
story --help   # PR narrative & changelog
```

Requires the same config as prr: `GITHUB_TOKEN` and an LLM provider (e.g. `ELIZACLOUD_API_KEY` or `ANTHROPIC_API_KEY`). Logs: `story-output.log`, `story-prompts.log`.

```bash
prr https://github.com/owner/repo/pull/123 --keep-workdir

# Re-verify all issues (ignore verification cache)
prr https://github.com/owner/repo/pull/123 --reverify

# Custom context size for LLM batching (default: 400k chars)
prr https://github.com/owner/repo/pull/123 --max-context 200000

# All options
prr https://github.com/owner/repo/pull/123 \
  --tool cursor \
  --model claude-4-sonnet-thinking \
  --auto-push \
  --max-fix-iterations 10 \
  --max-push-iterations 3 \
  --poll-interval 120 \
  --max-context 400000 \
  --reverify \
  --keep-workdir \
  --verbose
```

### CLI Options Reference

| Option | Default | Description |
|--------|---------|-------------|
| `--tool <name>` | `cursor` | Fixer tool: cursor, claude-code, aider, opencode, codex, llm-api |
| `--model <model>` | (auto) | Override model for fixer tool |
| `--auto-push` | **on** | Push after fixes verified, wait for re-review, loop |
| `--no-auto-push` | off | Disable auto-push (just push once) |
| `--max-fix-iterations <n>` | unlimited | Max fix attempts per push cycle |
| `--max-push-iterations <n>` | unlimited | Max push/re-review cycles |
| `--max-stale-cycles <n>` | 1 | Bail out after N complete tool/model cycles with zero progress |
| `--poll-interval <sec>` | 120 | Seconds to wait for re-review |
| `--max-context <chars>` | 400000 | Max chars per LLM batch (~100k tokens) |
| `--reverify` | off | Re-check all cached "fixed" issues |
| `--dry-run` | off | Show issues without fixing |
| `--no-commit` | off | Don't commit (for testing) |
| `--no-push` | off | Commit but don't push |
| `--no-bell` | off | Disable terminal bell on completion |
| `--keep-workdir` | on | Keep work directory after completion |
| `--no-batch` | off | Disable batched LLM calls |
| `--verbose` | on | Extra debug output on the console. **`prompts.log`** (in CWD or `PRR_LOG_DIR`) is **not** controlled by this flag: it records full prompt/response text when the **in-process** LLM runs (`LLMClient` in the main process). It may stay **empty** if the run never calls that path (e.g. exits at merge conflicts first) or fixers run only in a **subprocess** (see AGENTS.md). Use **`PRR_DEBUG_PROMPTS=1`** for per-prompt files under `~/.prr/debug/`. |
| `--reply-to-threads` | off | Post a short reply on each review thread when PRR fixes or dismisses an issue. Use `PRR_REPLY_TO_THREADS=true` to enable via env. **WHY:** Gives reviewers visible feedback in the PR; opt-in so default runs stay unchanged. |
| `--no-reply-to-threads` | (default) | Do not post replies on review threads. |
| `--resolve-threads` | off | When replying, also resolve the review thread (collapse with checkmark). **WHY:** Optional; some teams prefer to resolve threads only after human review. |

Defaults marked **on** (e.g. `--auto-push`, `--keep-workdir`) are true by default; use `--no-auto-push` or `--no-keep-workdir` to disable them.

**Note on `--no-*` options**: Commander.js handles these specially. `--no-commit` sets an internal flag to `false`, not a separate `noCommit` option. This is why you use `--no-commit` to disable committing (the default is to commit).

## GitHub Actions (run when requested)

You can run PRR from GitHub Actions **only when requested**: manually from the Actions tab or by adding the **run-prr** label on the PR.

### In this repo (PRR itself)

- **From the PR:** Add the **run-prr** label to run on that PR (no need to open the Actions tab). Create the label in the repo if it doesn’t exist yet (e.g. when adding the label, choose “Create new label” and name it `run-prr`).
- **From Actions:** **Actions → Run PRR (client) → Run workflow**, then enter the PR number.

The workflow runs PRR with `--no-wait-bot` (one push cycle, then exit). Add the label again or re-run manually for another cycle.

**PRR as a reviewer in the GitHub UI:** After each run, PRR submits a **formal Pull Request Review** (the card that appears in the PR's "Reviews" section), so PRR shows up like CodeRabbit or a human reviewer instead of only posting comments. You can also **request PRR as a reviewer**: add a bot user (or GitHub App) as a collaborator, set the workflow env `PRR_REVIEWER_LOGIN` to that bot's login (e.g. `prr-bot` or `my-app[bot]`), then when someone requests that reviewer on the PR, the workflow runs.

### In any other repo

1. **Add a client workflow** (e.g. `.github/workflows/run-prr-client.yml`) that calls the server workflow:

```yaml
name: Run PRR
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to run PRR on'
        required: true
        type: number
  pull_request:
    types: [labeled]

concurrency:
  group: prr-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  prr:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'run-prr'
    uses: OWNER/prr/.github/workflows/run-prr-server.yml@babylon
    with:
      pr_number: ${{ github.event_name == 'workflow_dispatch' && inputs.pr_number || github.event.pull_request.number }}
      prr_repo: 'OWNER/prr'
      prr_ref: 'babylon'
    secrets:
      PRR_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      ELIZACLOUD_API_KEY: ${{ secrets.ELIZACLOUD_API_KEY }}
      # or ANTHROPIC_API_KEY / OPENAI_API_KEY
```

Replace `OWNER` with the GitHub org/user that hosts the PRR repo (e.g. `elizaOS`), and use the branch you want (`@main` or `@v1`). **Important:** When using a branch in `uses:` (e.g. `@babylon`), pass the same value as `prr_ref` (e.g. `prr_ref: 'babylon'`) so the job checks out that branch; otherwise the default branch is used and the run may fail.

2. **Configure secrets** in that repo:

- **Token**: Pass `PRR_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` (as above) to use the workflow's built-in token — no extra secret. Use a PAT only if you need cross-repo access or higher rate limits.
- **One LLM key**: Add a repository secret for at least one of:
  - `ELIZACLOUD_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`

3. **Run it**: Add the **run-prr** label on the PR, or Actions → Run PRR → Run workflow → enter the PR number.

The workflow checks out the PRR repo, builds it, and runs PRR on the given PR. It uses `--no-wait-bot` so the job exits after one push cycle (no waiting for bot re-review); push again or re-run for another cycle.

**Why pass the caller's token?** The job runs in the repo that triggered the workflow. Passing `PRR_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` uses that repo's default token, so you don't create a separate PAT. PRR uses it to read the PR, post comments, and push fixes. Use a PAT only when you need cross-repo access or higher API rate limits. (GitHub doesn't allow a secret named `GITHUB_TOKEN` in reusable workflows, so we use `PRR_GITHUB_TOKEN` and map it to `GITHUB_TOKEN` inside the job.)

## How It Works

### The Fix Loop

```text
┌─────────────────────────────────────────────────────────────┐
│  1. FETCH     → Get review comments from GitHub             │
│  2. ANALYZE   → LLM checks: "Is this issue still present?"  │
│  3. FIX       → Run fixer tool (Cursor, Claude Code, etc.)  │
│  4. VERIFY    → LLM checks: "Does this diff fix the issue?" │
│  5. LEARN     → Record what worked/failed for next attempt  │
│  6. REPEAT    → Until all issues resolved or max iterations │
│  7. AUDIT     → Final adversarial check before commit       │
│  8. COMMIT    → Squash into one clean commit                │
└─────────────────────────────────────────────────────────────┘
```

### Escalation Strategy

When fixes fail, prr escalates through multiple strategies:

```text
┌─────────────────────────────────────────────────────────────┐
│  BATCH MODE           → Try all issues at once              │
│      ↓ fail                                                 │
│  SINGLE-ISSUE MODE    → Focus on 1-3 random issues          │
│      ↓ fail                                                 │
│  ROTATE MODEL         → Try different model family          │
│      ↓ fail                                                 │
│  ROTATE TOOL          → Switch to next fixer tool           │
│      ↓ fail                                                 │
│  DIRECT LLM API       → Last resort, direct API call        │
│      ↓ fail                                                 │
│  BAIL OUT             → Commit partial progress, exit       │
└─────────────────────────────────────────────────────────────┘
```

*Why single-issue mode?* Batch prompts with 10+ issues can overwhelm LLMs. Single-issue = smaller context = better focus. Issues are **randomized** so hard issues don't block easy ones.

### Why Each Step Matters

1. **Fetch Comments**: Gets all review comments via GitHub GraphQL API. Works with humans, bots (CodeRabbit, Copilot, Claude), or any reviewer.
   - *Why parse ALL bot comments*: Bots may post multiple comments across re-reviews. Only reading the latest missed issues from earlier reviews. We parse every comment, filter noise (short messages, trigger commands), and recover path-less items with actionable language.
   - *Why noise filter*: When reading all comments, test messages and trigger commands would pollute the issue list. The filter runs before parsing so junk never enters the pipeline.
   - *Why include path-less items*: Some bot comments describe real issues without citing a file. Including them with a synthetic `(PR comment)` path lets downstream solvability checks decide whether they're actionable — at zero LLM cost if not.

2. **Analyze Issues**: For each comment, asks the LLM: "Is this issue still present in the code?" 
   - *Why*: Review comments may already be addressed, or partially addressed. We don't want to re-fix solved problems.
   - Uses strict prompts that require citing specific code evidence.

3. **Generate Prompt**: Builds a fix prompt including:
   - All unresolved issues with code context
   - "Lessons learned" from previous failed attempts (analyzed by LLM)
   - *Why lessons*: Prevents flip-flopping. If attempt #1 tried X and it was rejected, attempt #2 knows not to try X again.
   - *Why LLM-analyzed*: Generic "tool failed" messages aren't helpful. LLM analyzes the diff and rejection to generate actionable guidance.

4. **Run Fixer**: Executes the AI coding tool in the cloned repo.
   - **Model rotation**: Interleaves model families - tries Claude, then GPT, then Gemini before exhausting any single family
   - **Tool rotation**: Cursor → Claude Code → Aider → Direct LLM API when models exhausted
   - *Why interleave families*: Same-family models often fail the same way. Switching families gives fresh perspective.
   - *Why rotation*: Different models have different strengths. If one gets stuck, another might succeed.

5. **Verify Fixes**: For each changed file, asks the LLM: "Does this diff address the concern?"
   - *Why verify*: Fixer tools can make changes that don't actually fix the issue. Catches false positives early.
   - *Why "Code before fix" in verifier prompt*: The verifier now sees a "Code before fix" snippet (from the diff) alongside "Current Code (AFTER)" so it can compare before vs after and determine whether the issue was actually fixed instead of pattern-matching on current code alone; reduces false rejections when the fix was correct.

6. **Check for New Comments**: Before declaring "done", checks if any NEW review comments were added during the fix cycle.
   - *Why*: Bot reviewers or humans might add new issues while you're fixing others. Ensures nothing slips through.

7. **Final Audit**: Re-verifies ALL issues with a stricter adversarial prompt.
   - *Why clear cache first*: Verification cache can have stale entries from previous runs. The audit clears it.
   - *Why adversarial*: Regular verification asks "is this fixed?" (LLMs tend toward yes). Adversarial asks "find what's NOT fixed" (catches more issues).
   - *Why dynamic batching*: Large PRs might have 50+ issues. Groups by character count (~400k default) to stay within context limits.

8. **Commit**: Generates a clean commit message via LLM describing the actual changes.
   - *Why LLM-generated*: Commit messages are permanent history. They should describe WHAT changed, not the review process.
   - *Why forbidden phrases*: LLMs default to "address review comments" - we explicitly forbid this and fall back to file-specific messages.

9. **Push** (if `--auto-push`): Pushes changes with automatic retry on rejection.
   - *Why auto-inject token*: The remote URL might not have the GitHub token (old workdir, manual clone). We inject it automatically before pushing.
   - *Why fetch+rebase on rejection*: If someone else pushed while prr was working (common with CodeRabbit), we rebase our changes on top instead of failing.
   - *Why 30s timeout*: Push should be fast. If it takes longer, something's wrong (network, auth prompt). 60s was too generous.

### Auto-Conflict Resolution

**The Problem**: Merge conflicts block the fix loop. Previously, prr would bail out with "resolve manually" - frustrating when the same LLM tools that fix review comments can also resolve merge conflicts.

**Solution**: Automatic conflict resolution using a two-stage approach:

```text
┌─────────────────────────────────────────────────────────────┐
│  Stage 1: Lock Files (bun.lock, package-lock.json, etc.)    │
│    └─ Delete and regenerate via package manager             │
│    └─ WHY: LLMs can't merge lock files correctly            │
│                                                              │
│  Stage 2: Code Files (LLM-powered)                          │
│    └─ Attempt 1: Use fixer tool (Cursor, Aider, etc.)       │
│    └─ Attempt 2: Direct LLM API fallback                    │
│    └─ Check for conflict markers after each attempt         │
└─────────────────────────────────────────────────────────────┘
```

**Conflict scenarios handled:**
- **Remote sync conflicts**: Previous interrupted merge/rebase left conflict markers
- **Pull conflicts**: Branch diverged while prr was working
- **Stash conflicts**: Interrupted run had uncommitted changes
- **Base branch merge**: PR conflicts with target branch (main/master). PRR fetches the base branch with an explicit refspec so the merge sees the latest base tip (see Git Integration: "Base branch merge (explicit refspec)"); if the merge has conflicts, PRR resolves them with the LLM and pushes the merge commit before the fix loop.

**Why two attempts for code files?**
- Fixer tools are good at agentic changes but sometimes miss conflict markers
- Direct LLM API gives precise control for targeted resolution
- Second attempt catches what first attempt missed

**Why check both git status AND file contents?**
- Git might mark a file as resolved (not in `status.conflicted`)
- But file might still contain `<<<<<<<` markers if tool staged prematurely
- Double-check catches false positives

**Fallback and parse retries**
- If the main strategy (chunked or single-shot) fails for a file, PRR tries a **top+tails fallback**: chunk the entire file to build a short "story", then for each conflict send only the **top** (context + start of conflict) and **tails** (last lines of OURS and THEIRS) plus base top/tail; the model produces a full resolution from that. *Why*: We don't process the whole file this way unless we need to; when the main path has already failed, this gives the model a different view (how each side ends) and often succeeds.
- For TS/JS we **validate** resolved content (parse) before write/stage. If validation fails (e.g. `'*/' expected`), we **retry** resolution up to twice with the parse error (and location) in the prompt so the model can fix syntax. *Why*: Many parse failures are trivial (unclosed comment, missing comma); a few retries with the exact error avoid giving up on fixable output.
- See [tools/prr/CONFLICT-RESOLUTION.md](tools/prr/CONFLICT-RESOLUTION.md) for flow, constants, and the top+tails design.

### Bail-Out Mechanism

**The Problem**: AI agents can get into stalemates. The fixer says "done", the verifier says "not fixed", and this loops forever wasting time and money.

**Solution**: Track "no-progress cycles" and bail out gracefully:

```text
┌─────────────────────────────────────────────────────────────┐
│  Cycle = All tools tried × All models on each tool           │
│                                                              │
│  If a full cycle completes with zero verified fixes:         │
│    → Increment noProgressCycles counter                      │
│    → If noProgressCycles >= maxStaleCycles: BAIL OUT         │
│                                                              │
│  Bail-out sequence:                                          │
│    1. Try direct LLM API one last time                       │
│    2. Record what was tried and what remains                 │
│    3. Commit/push whatever WAS successfully fixed            │
│    4. Print clear summary for human follow-up                │
│    5. Exit cleanly (don't loop all night)                    │
└─────────────────────────────────────────────────────────────┘
```

**Why bail out?**
- Agents disagree: Fixer says "already fixed", verifier disagrees
- Issues genuinely beyond automation (conflicting requirements, unclear spec)
- Prevents infinite loops and wasted API costs
- Lets humans step in when automation is stuck

**Why track cycles, not individual attempts?**
- One "cycle" = all tools × all models tried
- Single failures are normal (model might just need a different approach)
- Full cycle failures indicate genuine stalemate
- More robust than counting consecutive failures

**Why default to 1 cycle?**
- Conservative default: step in early to debug
- Increase to 2-3 once you trust the system
- Use `--max-stale-cycles 0` to disable (unlimited retries)

**Bail-out output**:
```text
════════════════════════════════════════════════════════════════
  BAIL-OUT: Stalemate Detected
════════════════════════════════════════════════════════════════

  Reason: 1 complete cycle(s) with zero verified fixes
  Max allowed: 1 (--max-stale-cycles)

  Progress Summary:
    ✓ Fixed: 3 issues
    ✗ Remaining: 2 issues
    📚 Lessons learned: 7

  Remaining Issues (need human attention):
    • src/foo.ts:42
      "Consider using async/await instead of..."
════════════════════════════════════════════════════════════════
```

## Work Directory

- **What it is:** The **clone** of the **repository under review** (PR branch checkout), where PRR runs git and fixers. **Not** the prr tool’s own source tree and **not** required to equal `process.cwd()`.
- Location: `~/.prr/work/<hash>`
- Hash is based on `owner/repo#number` - same PR reuses same directory
- Cleaned up by default on success
- Use `--keep-workdir` to preserve for debugging

## State File

State is persisted in `<clone-workdir>/.pr-resolver-state.json` (the PR checkout path above):

```json
{
  "pr": "owner/repo#123",
  "branch": "feature-branch",
  "iterations": [...],
  "lessonsLearned": [...],
  "verifiedComments": [
    {
      "commentId": "comment_id_1",
      "verifiedAt": "2026-01-23T10:30:00Z",
      "verifiedAtIteration": 5
    }
  ],
  "currentRunnerIndex": 0,
  "modelIndices": { "cursor": 2, "llm-api": 0 },
  "noProgressCycles": 0,
  "bailOutRecord": null
}
```

**Why these fields:**
- `verifiedComments`: Tracks WHEN each verification happened (not just what). Enables verification expiry.
- `currentRunnerIndex`: Resume from the same tool after interruption. Prevents restarting rotation from scratch.
- `modelIndices`: Per-tool model position. If Cursor was on model #2, resume there.
- `noProgressCycles`: How many complete tool/model cycles completed with zero progress. Persists across restarts.
- `bailOutRecord`: Documents WHY automation stopped, what remains, for human follow-up.

**Why not just store tool/model names?** Indices are resilient to model list changes. If we add new models, existing indices still work.

## Team Lessons Sharing

prr learns from each fix attempt and stores "lessons learned" to avoid repeating mistakes.

### Two-Tier Storage

| Location | What | Who Controls |
|----------|------|--------------|
| `.prr/lessons.md` | **Full history** - all lessons, no limits | prr (completely) |
| `CLAUDE.md` | **Synced summary** - recent lessons only | prr (section only) |
| `CONVENTIONS.md` | **Synced summary** - if Aider detected | prr (section only) |

**Key insight**: `.prr/lessons.md` is our canonical file (we rewrite it freely). Other files like `CLAUDE.md` may have user content, so we only update a delimited section.

### Auto-Sync Targets

prr auto-detects which tools you use and syncs to their config files:

| Target | File | When Synced |
|--------|------|-------------|
| Cursor + Claude Code | `CLAUDE.md` | Always |
| Aider | `CONVENTIONS.md` | If `.aider.conf.yml` or `CONVENTIONS.md` exists |
| Cursor (native) | `.cursor/rules/prr-lessons.mdc` | If `.cursor/rules/` exists |

### Compaction for Synced Files

Synced files get a **compacted** version to prevent bloat:
- **15 global lessons** (most recent)
- **20 files** with the most lessons  
- **5 lessons per file** (most recent)

The full history stays in `.prr/lessons.md`.

### Format Example

`.prr/lessons.md` (full, we control completely):
```markdown
# PRR Lessons Learned

## Global Lessons
- When fixing TypeScript strict null checks, always add explicit null guards
- Avoid changing import styles - match existing patterns
- ... (all lessons, no limit)

## File-Specific Lessons
### src/components/Button.tsx
- Line 45: This component expects nullable props
- ... (all lessons for this file)
```

`CLAUDE.md` (synced section, preserves user content):
```markdown
# Project Configuration

<!-- User's existing content stays here -->

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global
- When fixing TypeScript strict null checks, always add explicit null guards
- _(5 more in .prr/lessons.md)_

### By File
**src/components/Button.tsx**
- Line 45: This component expects nullable props
<!-- PRR_LESSONS_END -->
```

### When Lessons Are Committed

Lessons are **committed with your code fixes** - they're not a separate step:

```text
Fix loop runs
    ↓
Lessons added (when fixes rejected, etc.)
    ↓
Export lessons to .prr/lessons.md + CLAUDE.md  ← BEFORE commit
    ↓
Commit (includes code fixes AND lessons)
    ↓
Push
    ↓
Team gets everything in one atomic update
```

**WHY commit together?** Lessons explain the fixes. If you push fixes without lessons, teammates miss context about what was tried and why.

### Why This Approach?

1. **Full history preserved**: `.prr/lessons.md` keeps everything
2. **User content safe**: CLAUDE.md's existing content isn't touched. We never delete repo-owned sync targets: final cleanup only removes files prr created this run (we record which existed at detection and re-detect after clone so we know what was in the repo).
3. **Multi-tool support**: Works with Cursor, Claude Code, Aider
4. **No bloat**: Synced files get only recent/relevant lessons
5. **Team sync**: `git pull` gives everyone the latest
6. **Atomic commits**: Fixes and lessons travel together

## Requirements

**Runtime:**
- Node.js >= 18 (or Bun)

**GitHub Access:**
- GitHub personal access token with `repo` scope (`GITHUB_TOKEN`)

**LLM API Keys** (for verification and some runners):
- `ANTHROPIC_API_KEY` - Required for verification (if using Anthropic), and for `claude-code`, `aider`, `llm-api` runners
- `OPENAI_API_KEY` - Required for verification (if using OpenAI), and for `codex`, `aider`, `llm-api` runners

**Fixer CLI Tools** (depending on `--tool` option; at least one required):
- `--tool cursor`: `cursor-agent` (Cursor login required)
- `--tool opencode`: `opencode` (configure API keys per opencode docs)
- `--tool aider`: `aider` (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
- `--tool claude-code`: `claude` or `claude-code` (`ANTHROPIC_API_KEY`)
- `--tool codex`: `codex` or `openai-codex` (OpenAI Codex access / `OPENAI_API_KEY`)
- `--tool llm-api`: no CLI (direct API; `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)


| `--tool` value | CLI Binary | Requirements |
|----------------|------------|--------------|
| `cursor` | `cursor-agent` | Cursor account, login via `cursor-agent login` |
| `claude-code` | `claude` or `claude-code` | `ANTHROPIC_API_KEY` |
| `aider` | `aider` | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| `opencode` | `opencode` | (check opencode docs) |
| `codex` | `codex` or `openai-codex` | `OPENAI_API_KEY` |
| `llm-api` | (none - direct API) | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |


### Cursor CLI Setup

If you're new to Cursor's CLI agent, you'll need to install and authenticate first:

```bash
# Detect OS/arch (use to pick the right binary)
uname -s
uname -m

# Install cursor-agent (macOS ARM64)
curl -fsSL https://www.cursor.com/download/stable/agent/darwin/arm64 -o cursor-agent
chmod +x cursor-agent
sudo mv cursor-agent /usr/local/bin/

# Install cursor-agent (macOS Intel)
curl -fsSL https://www.cursor.com/download/stable/agent/darwin/amd64 -o cursor-agent
chmod +x cursor-agent
sudo mv cursor-agent /usr/local/bin/

# Install cursor-agent (Linux x86_64)
curl -fsSL https://www.cursor.com/download/stable/agent/linux/amd64 -o cursor-agent
chmod +x cursor-agent
sudo mv cursor-agent /usr/local/bin/

# Install cursor-agent (Linux ARM64)
curl -fsSL https://www.cursor.com/download/stable/agent/linux/arm64 -o cursor-agent
chmod +x cursor-agent
sudo mv cursor-agent /usr/local/bin/

# Login (required before first use!)
cursor-agent login

# Verify installation and list available models
agent models
# Or: cursor-agent --list-models
```

If you're unsure which platform you're on, check `uname -s` and `uname -m`. For manual downloads, see <https://www.cursor.com/download>.

This opens a browser window to authenticate with your Cursor account. You only need to do this once - your credentials are saved locally.

Without logging in first, you'll see authentication errors when prr tries to run the fixer.

**Dynamic Model Discovery**: prr automatically discovers available models by running `agent models` on startup. No hardcoded model lists to maintain.

Model names change over time — see `docs/MODELS.md` for latest (e.g. Claude 4.6, GPT-5). Use `agent models`, `cursor-agent --list-models`, or `curl https://api.cursor.com/v0/models` for the canonical list. The table below shows **illustrative examples**:

| Model | Notes |
|-------|-------|
| `auto` | Let Cursor pick |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (see docs/MODELS.md) |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 (example) |
| `gpt-4o` | OpenAI (example) |
| `o3` | OpenAI reasoning (when available) |

**Model rotation strategy**: prr interleaves model families for better coverage:


```text
Round 1: claude-sonnet-4-5 (Claude) → gpt-4o (GPT) → o3 (OpenAI)
Round 2: next in rotation ...
... then next tool ...
// Review: interleaving models enhances diversity in responses, reducing similar failure patterns.
```


*Why interleave families?* Same-family models often fail the same way. If Claude Sonnet can't fix something, Claude Opus probably can't either. But GPT might succeed.

```bash
# Example: override model (bypasses rotation)
prr https://github.com/owner/repo/pull/123 --model claude-sonnet-4-5-20250929

# Let prr rotate through models automatically (recommended)
prr https://github.com/owner/repo/pull/123
```

## Debugging

### Debug Output Files

When `PRR_DEBUG_PROMPTS=1` is set, prr saves prompts and responses to debug files:

```bash
# Enable debug output
export PRR_DEBUG_PROMPTS=1
prr https://github.com/owner/repo/pull/123

# Operational log — what happened, when, and why
cat ~/.prr/debug/output.log

# Full prompt/response log — what the LLM actually saw
cat ~/.prr/debug/prompts.log

# Standalone debug files (requires PRR_DEBUG_PROMPTS=1)
ls ~/.prr/debug/*/*.txt
# or: find ~/.prr/debug -name '*.txt'
```

Files are saved under `~/.prr/debug/<timestamp>/` with descriptive names.

To view debug files:

```bash
# List all debug files (recursive, since files are in timestamp subdirs)
find ~/.prr/debug -name '*.txt' -type f

# Or use a recursive glob
ls ~/.prr/debug/*/*.txt

# View most recent
ls -lt ~/.prr/debug/*/*.txt | head -5
```

### Common log messages

- **"Overlap IDs (verifiedFixed ∩ dismissed)"** — A comment ID appeared in both verified and dismissed state (e.g. from an older run or state bug). State load now cleans this automatically; you may see "Cleaned N overlap" once. If it recurs, reset state: delete `.pr-resolver-state.json` in the workdir or run with `--reset-state` (see [State File](#state-file)).
- **"Tracked file not found for review path: X"** — The comment's path didn't match a repo file. PRR tries extension variants (e.g. `tsconfig.js` → `tsconfig.json`, or `.d.ts` in `types/`) before dismissing; if still missing, the issue is dismissed as missing-file.
- **"No model configured; defaulting to: …"** — You didn't set `PRR_LLM_MODEL`; PRR chose a default. Set `PRR_LLM_MODEL` to pin a specific model.
- **"Configured model unavailable; using: …"** — Your configured model was skipped (e.g. on the skip list) or not available; PRR fell back. Set `PRR_LLM_MODEL` to another model, or `PRR_ELIZACLOUD_INCLUDE_MODELS` to re-enable a skipped model (see AGENTS.md "Model skip list").

## License

MIT with one condition:

**Hours Saved Clause**: By using this tool, you agree to track the hours saved from not manually addressing PR review comments. Post your hours saved (with optional war stories) in a GitHub issue:

→ [Report Hours Saved](https://github.com/elizaOS/prr/issues/new?title=Hours+Saved&labels=hours-saved&body=Hours+saved:%0A%0AStory+(optional):)

We're building the case that cats sitting on PRs is a valid engineering strategy. 🐱
