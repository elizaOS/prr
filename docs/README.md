# PRR Documentation Index

Welcome to the PRR documentation! This directory contains comprehensive guides and flowcharts explaining how the PR Resolver system works. We document **why** design choices were made (not just what) so you can revisit decisions and avoid regressions — see also the main [README](../README.md) philosophy.

---

## 📚 Documentation Structure

### 🎯 [Quick Reference Guide](QUICK_REFERENCE.md)
**Best for**: Getting started quickly or looking up common patterns

**Contains**:
- One-page workflow overview
- Visual system diagram
- Common use cases
- Configuration tips
- Troubleshooting guide
- Success metrics explained

**Read this if**: You want to understand PRR at a glance or need quick answers.

---

### 🔄 [Flowchart Documentation](flowchart.md)
**Best for**: Understanding the detailed workflow and control flow

**Contains**:
- Main system flow (entry to exit)
- Orchestrator outer loop (push iterations)
- Push iteration inner loop (fix cycles)
- Fix iteration details (single attempt)
- Escalation strategy (when fixes fail)
- State management visualization
- LLM usage points
- Error recovery flows
- Tool integration architecture
- Performance optimizations explained

**Read this if**: You want to understand the step-by-step execution flow and decision points.

---

### 💊 Pill (Program Improvement Log Looker)

**Best for**: Auditing a project from its output.log and prompts.log, integrated with prr/story

**Contains**:
- What pill does (analysis-only, no fix/verify/commit) and why
- How prr/story run pill on close (`enablePill`, orig console refs, double-init guard)
- Log file names and prefix (prr vs story vs pill), CLI options, output files
- Architecture (cli, config, context, orchestrator, prompts)

**Read this if**: You run pill standalone or use pill integration from prr/story. Full doc: **[tools/pill/README.md](../tools/pill/README.md)**.

---

### 📉 Audit Improvements
Token-saving, exit-logic, and fix-loop improvements are documented in the [CHANGELOG](../CHANGELOG.md) under "Audit improvements" and "Output.log audit" headings.

**Conservative verification for lifecycle/cache/leak issues (2026-03)**:
- Lifecycle comments now receive broader symbol-lifecycle verification context rather than a tiny line-anchored snippet, and they are verified with the stronger lane when available.
- The risky "pattern absent after N rejections" auto-pass is disabled for these issues.
- **WHY**: Cleanup and leak bugs often live in distant creation/replacement/cleanup paths. A local snippet can look correct while the real leak still exists elsewhere in the file. PRR now prefers leaving those issues open over claiming a premature fix.

**Output.log audit follow-up (2026-02)** — rebase detection, push retry, non-interactive rebase:
- **Rebase detection**: `completeMerge` and the pull conflict loop use `--show-toplevel` to get the repo root so `.git/rebase-merge` is checked with an absolute path. **WHY**: Relative `.git` was resolved against process cwd, not the PRR workdir, so we often ran `commit` during a rebase and left `.git/rebase-merge` behind.
- **Push retry cleanup**: On failed fetch+rebase after push rejection, we try `rebase --abort` first, then `cleanupGitState` only if abort fails. **WHY**: Abort keeps commits; full cleanup is for stale state so the next run doesn’t hit "rebase-merge directory already exists".
- **Non-interactive rebase continue**: All `rebase --continue` calls go through `continueRebase(git)` in `git-merge.ts`, which sets `GIT_EDITOR=true` before running rebase. **WHY**: In headless/workdir there’s no TTY; the configured editor fails ("Standard input is not a terminal" / "problem with the editor 'editor'"). One helper keeps behavior consistent.
- **Dead code**: Removed unused `src/git/clone.ts`; clone/merge logic lives in `git-clone-core`, `git-merge`, and `git-lock-files` (see CHANGELOG "Fixed — Rebase detection, push retry cleanup").

**Output.log audit (2026-02)** — model and prompt behavior:
- **Model rotation & skip list**: Default llm-api/elizacloud lists ordered by fix success; models that 500/timeout or have 0% fix rate are in `ELIZACLOUD_SKIP_MODELS` and never selected. **WHY**: Reduces wasted rotation slots and improves throughput.
- **File injection**: Inject files by issue count (most first) and tie injection budget to model context cap. **WHY**: Better S/R success when cap is tight; avoids overshooting small-context or underusing large-context models.
- **Rewrite escalation**: Escalate to full-file rewrite for files not injected (LLM never saw content) or with repeated S/R failures. **WHY**: Avoids S/R matching failures when the model has no file content to copy from.
- **Duplicate prompt hash**: Use issue IDs + lesson count instead of full prompt so same-issues-same-context skips to rotation. **WHY**: Full-prompt hash rarely matched; avoids redundant LLM calls.
- **Proportional batch reduce**: Reduce batch by `cap/promptLength` instead of halving. **WHY**: Converges in 1–2 iterations instead of many.
- **504 retries**: Two retries with 10s/20s backoff. **WHY**: Transient gateways get a chance to recover.
- **AAR exhausted list**: List `path:line` for all exhausted issues in the After-Action Report. **WHY**: Makes human follow-up actionable.

**Prompts.log audit (2026-02)** — conflict prompt size and large-file embedding:
- **Skip file injection for conflict prompts**: In `injectFileContents` (llm-api), prompts starting with `MERGE CONFLICT RESOLUTION` are returned unchanged (no file injection). **WHY**: The conflict prompt builder already embeds each file; re-injecting would duplicate content (e.g. CHANGELOG twice), causing 140k+ char prompts and 504s.
- **Chunked embed for large conflicted files**: For files over 30k chars with conflict markers, only conflict sections (with 7 lines context) are embedded; section headers show the actual line range; instructions tell the LLM to use the plain file path in `<change path="...">`. **WHY**: Full-file embed doubled prompt size and caused 504s; sections are enough for correct search/replace blocks.
- **Conflict model fallback and context cap**: When `getCurrentModel()` is undefined (e.g. setup phase), Attempt 2 falls back to `DEFAULT_ELIZACLOUD_MODEL` for ElizaCloud; "file too large" uses the effective model’s context limit. **WHY**: Avoids weak default (qwen-3-14b) that may 504; correct limit prevents wrongly skipping files that fit the actual model’s window.

**Prompts.log audit follow-up (2026-02)** — relax file constraint, dismissal skip, judge rule, model recommendation:
- **Relax file constraint**: When the fixer returns CANNOT_FIX/WRONG_LOCATION and mentions another file, we persist that path in `wrongFileAllowedPathsByCommentId` and merge it into `allowedPaths` on the next attempt so the fixer can edit the correct file. **WHY**: Audit showed 7 identical 33k-char prompts for one cross-file issue; persisting the other file avoids burning all models and can resolve the issue on retry.
- **Skip dismissal LLM for already-fixed**: We no longer call the LLM to generate a Note for `already-fixed` issues; code/diff is self-documenting. **WHY**: 62% of dismissal LLM responses were EXISTING; skipping saves tokens.
- **Judge rule**: Verification prompt now says "If the Current Code already implements what the review asks for, respond NO and cite the specific code." **WHY**: Reduces unnecessary ALREADY_FIXED fix attempts when the judge would otherwise say YES.
- **Model recommendation wording**: Prompt asks "explain why these models in this order" instead of "brief reasoning". **WHY**: Models echoed "brief reasoning" literally; the new wording yields actionable explanation.

**Prompts.log audit (2026-03) — grouping validation and predict-bots guard:**
- **Dedup GROUP validation**: `issue-analysis.ts` now rejects an entire `GROUP:` line when any referenced comment index is outside `1..N` or when the canonical index is not listed in that group. **WHY**: One dedup response returned `GROUP: 2,5,7` for only three comments; partially applying malformed groups risks merging the wrong issues.
- **Dedup prompt tightening**: The dedup prompt now explicitly says valid indices are only `1..N` for the current file and that the canonical index must be one of the listed indices. **WHY**: Tightening the prompt reduces malformed grouping responses before they hit the parser.
- **Predict-bots changed-files guard**: `bot-prediction-llm.ts` skips the display-only predictor for tiny meta-only diffs and filters predictions to files that are actually in `changedFiles`. **WHY**: The predictor hallucinated `scripts/build-skills-docs.js` from a `.gitignore`-only diff; changed-file filtering keeps the UX output grounded in the commit being pushed.

**Prompts.log audit (2026-02) — verifier before snippet, model rec skip, no-op skip verify, escalation delay, predict-bots skip:**
- **Verifier "Code before fix"**: Batch verification prompt now includes a "Code before fix" section (removed lines from the diff) alongside "Current Code (AFTER)" so the verifier can compare before vs after. **WHY**: Verifier was only seeing post-fix code; with before snippet it can determine whether the issue was actually fixed and reduce false rejections (audit: one correct fix took 17 iterations due to verifier rejections).
- **Skip model recommendation for fewer than 3 issues**: The separate model-recommendation LLM call runs only when there are 3+ unresolved issues; otherwise we use default rotation. **WHY**: Saves ~29s and tokens on simple runs.
- **All-no-op = no changes**: When every fixer change block was a no-op (search === replace), we treat the iteration as "no changes" and skip verification (runner returns `noMeaningfulChanges`; workflow skips `handleNoChangesWithVerification` and goes to rotation). **WHY**: Avoids running the verifier on unchanged code and keeps "file modified" accurate.
- **Delay full-file escalation for simple issues**: For files where all targeting issues have importance ≤ 3 and ease ≤ 2, we only escalate to full-file rewrite when the file was not injected (not when over S/R failure threshold). **WHY**: Full-file rewrites are expensive and time out more; for simple issues we rely on S/R first.
- **Skip predict-bots when --no-wait-bot**: The LLM "likely new bot feedback" prediction is skipped when `--no-wait-bot` is set. **WHY**: Prediction is display-only and runs after commit; skipping saves ~26s when the user isn't waiting for bot reviews.

**Fetch timeout and token auth (2026-03)** — conflict check and pull no longer hang:
- **Fetch via spawn with 60s timeout**: Conflict check and remote-ahead check run `git fetch` via spawn; on timeout the error includes git stdout/stderr (e.g. password prompt). **WHY**: simple-git fetch could hang indefinitely; timeout + output make credential/network issues obvious.
- **GitHub token for fetch/pull**: When `origin` is HTTPS with no credentials, we use a one-shot auth URL (same as push) so fetch and pull never prompt for password. **WHY**: Headless runs have no TTY; token from config unblocks setup and fix-loop sync. See [CHANGELOG](../CHANGELOG.md) "Added (2026-03) — Git fetch: timeout, stdout on timeout, GitHub token auth".

**CLAUDE.md / sync target fix (2026-03)** — do not delete repo-owned files:
- **Sync target state in setWorkdir**: `setWorkdir` in `tools/prr/state/lessons-context.ts` now uses `Detect.autoDetectSyncTargets(ctx)` so both `syncTargets` and `originalSyncTargetState` are set. **WHY**: A local helper previously only set `syncTargets`; cleanup uses `didSyncTargetExist(ctx, 'claude-md')` to decide whether to remove CLAUDE.md — with an empty `originalSyncTargetState` we always assumed we had created it and deleted it at end of run, nuking the repo's CLAUDE.md when the user never ran `--clean-claude-md`.
- **Re-detect after clone**: In `tools/prr/workflow/run-setup-phase.ts`, after `cloneOrUpdateRepository()` we call `LessonsAPI.Detect.autoDetectSyncTargets(lessonsContext)` again. **WHY**: On first run the workdir is empty when we set workdir and detect; clone runs later and may check out CLAUDE.md. Without re-detection we would still record "didn't exist" and delete it at final cleanup. Re-running after clone ensures we only remove sync targets we actually created this run.

**Output.log audit follow-up (2026-03)** — allowed paths, CodeRabbit meta, (PR comment):
- **Runner allowed paths**: In `tools/prr/workflow/execute-fix-iteration.ts`, `allowedPathsForBatch` is built by expanding each issue with `getMigrationJournalPath`, `getConsolidateDuplicateTargetPath`, and `getImplPathForTestFileIssue` (same as prompt-builder). **WHY**: The prompt asked the fixer to edit e.g. `db/migrations/meta/_journal.json` for Drizzle migration issues, but the runner's allow-list used only `issue.allowedPaths`/`comment.path`, so journal edits were rejected as "disallowed file" and fixes never applied.
- **CodeRabbit meta comments**: `isCodeRabbitMetaComment` in `tools/prr/github/api.ts` now matches `<!-- This is an auto-generated reply` and `✅ Actions performed`; the same filter is applied to issue comments so those blurbs are not treated as fixable. **WHY**: CodeRabbit's confirmation blurb is not a code review; sending it to the fix loop wasted iterations and produced only UNCLEAR/WRONG_LOCATION.
- **(PR comment) dismissal**: In `tools/prr/workflow/helpers/solvability.ts`, issues whose path is the synthetic `(PR comment)` are dismissed as `not-an-issue` before any LLM call. **WHY**: The fixer cannot edit a non-file; every attempt fails and burns iterations.

**Prompts.log audit: ALREADY_FIXED counter, batch injection, single-issue full file, verifier context (2026-03)** — P1/P3/P5/P7:
- **ALREADY_FIXED multi-model dismissal (P1)**: New `consecutiveAlreadyFixedAnyByCommentId` counter in `tools/prr/state/types.ts`. Incremented in `no-changes-verification.ts` on every ALREADY_FIXED result; reset in `execute-fix-iteration.ts` when fixer makes changes and in `iteration-cleanup.ts` when verified. When count reaches `ALREADY_FIXED_ANY_THRESHOLD` (3), issue is dismissed. `assessSolvability` also checks the counter. **WHY**: The existing same-explanation counter only fired when explanation text matched. When 3+ different models independently say ALREADY_FIXED (with varying explanations), the issue is almost certainly resolved. Saves 3-5 wasted fix iterations per issue.
- **Batch injection filter (P3)**: New `allowedPathsForInjection` on `RunnerOptions` in `shared/runners/types.ts`. `injectFileContents` in `shared/runners/llm-api.ts` filters `sortedPaths` to the allowed set. `execute-fix-iteration.ts` passes `allowedPathsForBatch` as the filter. **WHY**: In later fix rounds, many files are already fixed. Injecting their contents wastes context budget. Filtering to files with unfixed issues keeps the prompt focused — observed 40-60% reduction in injected content on rounds 2+.
- **Single-issue full file context (P5)**: New `getFullFileContentForSingleIssue(workdir, path, maxLines=600)` in `tools/prr/workflow/utils.ts`. Used as default `codeSnippetOverride` in `resolver.ts` `buildSingleIssuePrompt`. **WHY**: Single-issue prompts were sending only 15-30 line snippets. Models responded INCOMPLETE_FILE/UNCLEAR because they couldn't see imports, types, or broader context. Full file (capped at 600 lines) gives enough context for correct fixes.
- **Verifier expanded context for type/signature issues (P7)**: New `commentMentionsApiOrSignature(fix)` in `tools/prr/workflow/fix-verification.ts`. `getCurrentCodeAtLine` accepts `expandForTypeSignature` flag, returning up to 500 lines (vs 200). Both sequential and batch verification pass the flag. **WHY**: For type/signature issues, the verifier needs to see function bodies and call sites. The 200-line default caused false "never assigned" rejections. 500 lines covers most function bodies and immediate call sites.

**Comment parsing: parse all bot comments, noise filter, path-less gap (2026-03)**:
- **Bot noise filter**: New `isBotNoiseComment(body)` in `tools/prr/github/api.ts` filters comments < 60 chars, "IGNORE THIS", and bare trigger commands before parsing. **WHY**: When parsing ALL bot comments, noise pollutes the issue list. The 60-char threshold is conservative — real reviews are always longer.
- **Parse all bot comments**: `getReviewBotIssueComments` iterates ALL comments from known bots, not just the latest. Sort removed; unique IDs per comment (`ic-${comment.id}-${i}`). Non-structured comments fall back to `inferPathLineFromBody`. **WHY**: Previously only the latest comment per bot was parsed, missing issues from earlier reviews that were never re-posted. Zero missed issues is the goal.
- **Path-less items included**: `parseMarkdownReviewIssues` no longer drops items without file paths. Items >= 100 chars with actionable language get `path: '(PR comment)'`. Downstream `assessSolvability` dismisses at zero LLM cost. **WHY**: Some bot comments describe real issues without citing a file. Including them lets solvability decide; the 100-char minimum and actionable regex filter noise.

**Output.log + prompts.log audit (2026-03) — Cycle 12: in-loop dismissal, new-comment solvability, ALREADY_FIXED filter, STALE→YES**
- **couldNotInject in-loop**: In `tools/prr/workflow/push-iteration-loop.ts`, at the start of each fix iteration we filter `unresolvedIssues` by `couldNotInjectCountByCommentId >= COULD_NOT_INJECT_DISMISS_THRESHOLD`, dismiss those issues, remove them from the queue, and if the queue is empty set `allFixed` and break. **WHY**: The threshold was only checked in `findUnresolvedIssues` (push-iteration start). Inside the fix loop the same issues were retried 10+ times; applying the check every iteration stops the loop (output.log audit).
- **New-comment solvability (P1)**: `processNewBotReviews` in `tools/prr/workflow/fix-loop-utils.ts` accepts optional `workdir` and `stateContext`. When both are set, each new comment is run through `assessSolvability` before adding; unsolvable (e.g. (PR comment), lockfile) are dismissed. Dismissed and solvable comment IDs are added to `existingCommentIds` before the solvability loop so they are not re-fetched. **WHY**: New comments were added without solvability, so (PR comment) and other unfixable paths entered the queue and burned iterations (prompts.log audit).
- **ALREADY_FIXED batch filter (P3)**: In `tools/prr/workflow/execute-fix-iteration.ts`, `issuesForPrompt` excludes issues with `consecutiveAlreadyFixedAnyByCommentId >= 2` in addition to already-verified. **WHY**: Batch prompts were re-including issues the fixer had already said ALREADY_FIXED 2×; excluding them avoids re-sending until dismissal at 3× (prompts.log audit).
- **STALE→YES override (P2)**: In `tools/prr/llm/client.ts`, the override that flips STALE to YES when the explanation indicates "code not visible" now also matches "can't evaluate", "cannot assess/determine/verify", "(code|snippet|excerpt) doesn't show", "only shows" + (not|beginning|start|first|lines N), "incomplete" + (show|visible|implementation), and "not visible/shown/included in excerpt/code/snippet". "only shows" is tightened so legitimate STALE (e.g. "only shows re-export") is not flipped. **WHY**: Judge instructions say use YES when you would say "not in excerpt"; the verifier used different phrasings, causing false STALE dismissals (prompts.log audit).

**Prompts.log audit: dedup, verifier strength, dismissal comments, multi-file (2026-03)** — Cycle 10:
- **Dismissal skip when file no longer exists**: In `tools/prr/workflow/dismissal-comments.ts`, we filter out issues whose dismissal reason matches "file no longer exists" / "file not found" before building the commentable list. **WHY**: Audit showed a dismissal-comment prompt sent for a file with reason "File no longer exists: stores/task.store.ts"; the LLM was asked to write a comment in a missing file, wasting tokens and producing a comment that would never be inserted.
- **Post-filter generic dismissal comments**: In `tools/prr/llm/client.ts` (`generateDismissalComment`), after parsing `COMMENT: Note: ...` we check if the comment mostly restates the surrounding code (2–8 words, ≥2 words appear in code); if so we return `needed: false`. **WHY**: gpt-4o-mini often produced comments like "extracts relevant metrics" that only narrate the code; they add no value and we skip inserting them.
- **Heuristic dedup same-caller**: In `tools/prr/workflow/issue-analysis.ts`, `callerFileFromBody(body)` extracts a caller file (e.g. "runner.py:146", "in runner.py"); heuristic dedup now merges two comments on the same file when they share the same primary symbol and the same caller file, even when authors differ. **WHY**: Audit showed dedup returning NONE for four comments; cursor and claude both described the same async/caller mismatch but weren't grouped, so duplicate issues reached the fix prompt.
- **Multi-file nudge**: In `tools/prr/analyzer/prompt-builder.ts`, when TARGET FILE(S) has multiple files and the review body mentions callers (calls, caller, await, file:line), we add: "This issue requires changes in **all** listed files — update the implementation and every call site so signatures match." **WHY**: The fixer had updated only reporting.py while runner.py was in TARGET FILE(S); the verifier correctly rejected because the call site wasn't updated; the nudge reduces incomplete multi-file fixes.
- **Verifier model floor for API/signature fixes**: In `tools/prr/workflow/fix-verification.ts`, `commentMentionsApiOrSignature(fix)` detects async/await, signature/caller/TypeError, method accepts/takes; such fixes are verified with a stronger model when available. **WHY**: The default verifier (e.g. qwen-3-14b) approved a fix that missed the call-site update (print_results still calling generate_report() without await/args); stronger verifier for API-related fixes reduces "fixed then broken at call site".

**Security & cleanup (2026-02)** — credential redaction, worktree, conflict-resolve, commit:
- **Credential redaction**: All push and rebase error/debug logs in `git-push.ts` use `redactUrlCredentials()` so `https://token@...` is never logged; same redaction is used for fetch timeout/error output in `git-conflicts.ts`. **WHY**: Git stderr and error messages can contain remote URLs with tokens; redacting prevents credential leakage.
- **Worktree rebase detection**: `getResolvedGitDir(git)` in git-merge.ts resolves the real git dir when `.git` is a file (worktree); used by `completeMerge` and the pull conflict loop in repository.ts. **WHY**: In worktrees the rebase-merge check would otherwise fail; one shared helper keeps behavior correct and consistent.
- **Sync target log**: "Removed sync target created by prr" is logged only when `git.rm` or fallback `git.add` succeeds. **WHY**: Avoids reporting success when both failed.
- **commit.ts**: Duplicate broken push/pushWithRetry code removed; file re-exports from git-push.ts. **WHY**: Single source of truth; fixes parse errors from mangled duplicate.

**Earlier audit items**: Dismissal-comment pre-check radius, no-op search/replace skip, lesson caps, dedup threshold, commit wording, think-tag stripping, verifier rejection cap, no-verified-progress exit — see CHANGELOG for full list and WHYs.

**Read this if**: You want to know why we reorder models, skip certain models, inject files by issue count, escalate to full-file rewrite, skip injection for conflict prompts, or embed only conflict sections for large files.

---

### 🤖 [Models Reference](MODELS.md)
**Best for**: Choosing or configuring LLM models, updating context limits

**Contains**:
- Claude (Anthropic) current and legacy models, API IDs, context windows, pricing
- OpenAI frontier and specialized models, Codex-optimized IDs
- How PRR uses this (e.g. `model-context-limits.ts`)

**Read this if**: You're adding a new model, tuning context limits, or checking provider IDs. Sourced from [Claude](https://platform.claude.com/docs/en/about-claude/models/overview) and [OpenAI](https://developers.openai.com/api/docs/models) docs.

---

### 🏗️ [Architecture Guide](ARCHITECTURE.md)
**Best for**: Contributors, maintainers, or deep technical understanding

**Contains**:
- High-level system architecture
- Directory structure and file purposes
- Key design patterns
- Data flow diagrams
- Critical performance optimizations
- Error handling & resilience strategies
- Extension points (how to add new tools/LLMs)
- Testing strategy
- Configuration reference
- Monitoring & observability
- Security considerations
- Future enhancements

**Read this if**: You're contributing code, extending functionality, or need to understand the design rationale.

---

## 🗺️ Documentation Map

```text
docs/
├── README.md (this file)           ← Start here
│
├── QUICK_REFERENCE.md              ← Quick start & common patterns
│   ├─ One-page workflow
│   ├─ Visual architecture
│   ├─ The fix loop (detailed)
│   ├─ Smart features
│   ├─ Common use cases
│   └─ Troubleshooting
│
├── flowchart.md                    ← Detailed flowcharts
│   ├─ Main system flow
│   ├─ Orchestrator loop
│   ├─ Push iteration loop
│   ├─ Fix iteration details
│   ├─ Escalation strategy
│   ├─ State management
│   ├─ LLM usage points
│   └─ Error recovery
│
├── MODELS.md                       ← Claude & OpenAI models reference
│   ├─ Latest & legacy Claude
│   ├─ OpenAI frontier & specialized
│   └─ PRR context limits usage
│
└── ARCHITECTURE.md                 ← Technical deep-dive
    ├─ System architecture
    ├─ Directory structure
    ├─ Design patterns
    ├─ Data flows
    ├─ Performance optimizations
    ├─ Extension points
    └─ Testing & security
```

---

## 🎓 Learning Path

### For End Users

1. **Start**: Read the [main README](../README.md) for what PRR does
2. **Quick Start**: Use [Quick Reference](QUICK_REFERENCE.md) for common patterns
3. **Deep Dive**: Check [Flowcharts](flowchart.md) to understand the workflow
4. **Troubleshoot**: Refer back to Quick Reference troubleshooting section

### For Contributors

1. **Start**: Read the [main README](../README.md)
2. **Workflow**: Study [Flowcharts](flowchart.md) to understand execution flow
3. **Architecture**: Read [Architecture Guide](ARCHITECTURE.md) for design patterns
4. **Code**: Explore the codebase with architectural context
5. **Extend**: Use extension points in Architecture Guide
6. **Test**: Follow testing strategy in Architecture Guide

### For Maintainers

1. **All above** + 
2. **Development Guide**: Read [DEVELOPMENT.md](../DEVELOPMENT.md) for conventions
3. **Changelog**: Review [CHANGELOG.md](../CHANGELOG.md) for evolution history
4. **Performance**: Study optimizations in Architecture Guide
5. **Monitoring**: Set up observability per Architecture Guide

---

## 📖 Key Concepts Explained

### Recent improvements (rotation, batch reduce, injection, no-changes)

- **Rotation reset**: At the start of each push iteration (after the first), the model index resets to the first in rotation. *Why*: The previous cycle often ended on a model that had just 500'd or timed out; retrying it first wastes time.
- **Large-prompt batch reduce**: When a fix prompt exceeds ~200k chars and fails (error or no-changes), the next fix iteration uses a smaller batch immediately. *Why*: Oversized prompts cause gateway 500s/timeouts; reducing batch size keeps prompts within limits.
- **Injection cap with floor**: Base + injected file content is capped (e.g. 200k total) with a minimum injection allowance so key files are still injected when the base is large. *Why*: Prevents 500s from oversized requests and avoids zero injection when base is already big.
- **No-changes parsing**: The NO_CHANGES explanation is parsed from prose only; content inside `<change>`, `<newfile>`, and `<file>` blocks is stripped first. *Why*: Code or fixtures inside those blocks can contain phrases like "already fixed", causing false positives.
- **Line-number stripping**: When matching search/replace from LLM output, only the injected line format `N | ` is stripped from each line, not arbitrary leading digits. *Why*: Injected file content is numbered; some LLMs echo that in `<search>`/`<replace>`. Stripping only `N | ` allows matches without corrupting real code.

See [CHANGELOG](../CHANGELOG.md) (Unreleased → Added 2026-02) for full WHYs and file references.

### The Three Loops

```text
┌─────────────────────────────────────────────────────────┐
│ OUTER LOOP (Run Orchestrator)                          │
│  • Purpose: Handle multiple push iterations            │
│  • Scope: Entire PR resolution workflow                │
│  • Exits: When all fixed or max push iterations        │
│  │                                                      │
│  │  ┌───────────────────────────────────────────────┐  │
│  │  │ PUSH ITERATION LOOP                           │  │
│  │  │  • Purpose: Single push cycle                 │  │
│  │  │  • Scope: Fetch → Fix → Verify → Push         │  │
│  │  │  • Exits: After push or bail-out              │  │
│  │  │  │                                            │  │
│  │  │  │  ┌─────────────────────────────────────┐  │  │
│  │  │  │  │ FIX ITERATION LOOP                  │  │  │
│  │  │  │  │  • Purpose: Single fix attempt      │  │  │
│  │  │  │  │  • Scope: Build → Run → Verify      │  │  │
│  │  │  │  │  • Exits: When fixed or max iters   │  │  │
│  │  │  │  └─────────────────────────────────────┘  │  │
│  │  │  │                                            │  │
│  │  └──┴────────────────────────────────────────────┘  │
│  │                                                      │
└──┴──────────────────────────────────────────────────────┘
```

### The Escalation Strategy

When fixes fail, PRR doesn't give up—it escalates:

```text
1. Batch Mode (optimistic)
   └─ Try fixing 50 issues at once

2. Adaptive Batching (progressive)
   └─ Halve batch size: 50 → 25 → 12 → 6 → 5

3. Single-Issue Mode (focused)
   └─ Pick 1-3 random issues for narrow context

4. Model Rotation (diversity)
   └─ Claude → GPT → Gemini (different families)

5. Tool Rotation (alternative)
   └─ cursor → claude-code → aider → gemini → ...

6. Direct LLM API (last resort)
   └─ Bypass tool wrappers, use API directly

7. Bail Out (graceful)
   └─ Commit partial progress, request human help
```

### State Management

PRR maintains state across interruptions:

```json
{
  "pr": "owner/repo#123",
  "iterations": [...],
  "commentStatuses": {
    "comment_123": {
      "status": "open",
      "classification": "exists",
      "fileContentHash": "abc123",
      "importance": 4,
      "ease": 3
    }
  },
  "verifiedFixed": ["comment_456"],
  "dismissedIssues": [
    {
      "commentId": "comment_789",
      "reason": "Already implemented via guard clause",
      "dismissedAt": "2026-02-25T00:00:00Z",
      "dismissedAtIteration": 3,
      "category": "already-fixed",
      "filePath": "src/example.ts",
      "line": 42,
      "commentBody": "Add null check"
    }
  ],
  "lessonsLearned": [...],
  "currentRunnerIndex": 2,
  "modelIndices": { "cursor": 3, "aider": 1 },
  "noProgressCycles": 0
}
```

**Why this matters**:
- Resume after Ctrl+C
- Skip redundant LLM analysis (caching)
- Track what was tried (lessons)
- Continue rotation from where it stopped

---

## 🎯 Common Questions

### Q: Which document should I read first?
**A**: Depends on your goal:
- **Just want to use PRR**: [Quick Reference](QUICK_REFERENCE.md)
- **Want to understand how it works**: [Flowcharts](flowchart.md)
- **Want to contribute or extend**: [Architecture](ARCHITECTURE.md)

### Q: How do I visualize the full workflow?
**A**: [Flowchart documentation](flowchart.md) has Mermaid diagrams showing:
- Main system flow
- Each loop in detail
- Decision points
- Error handling
- State changes

### Q: Where are the key files explained?
**A**: [Architecture Guide](ARCHITECTURE.md) has:
- Directory structure with file purposes
- Detailed description of each module
- Extension points for adding functionality

### Q: How do I troubleshoot issues?
**A**: [Quick Reference](QUICK_REFERENCE.md) has:
- Troubleshooting section
- Common problems & solutions
- How to read logs
- Exit reasons explained

### Q: What are the performance optimizations?
**A**: Both [Flowcharts](flowchart.md) and [Architecture](ARCHITECTURE.md) explain:
- Comment status caching
- Prefetched comments
- Two-phase deduplication
- Adaptive batch sizing
- Model family interleaving
- Spot-check verification

---

## 🔍 Finding Information

| I want to... | Document | Section |
|--------------|----------|---------|
| Understand the full workflow | [Flowcharts](flowchart.md) | All sections |
| See one-page overview | [Quick Reference](QUICK_REFERENCE.md) | System Overview |
| Learn common usage patterns | [Quick Reference](QUICK_REFERENCE.md) | Common Use Cases |
| Understand state management | [Flowcharts](flowchart.md) | State Management |
| Add a new AI tool | [Architecture](ARCHITECTURE.md) | Extension Points |
| Troubleshoot an issue | [Quick Reference](QUICK_REFERENCE.md) | Troubleshooting |
| Understand escalation | [Flowcharts](flowchart.md) | Escalation Strategy |
| See directory structure | [Architecture](ARCHITECTURE.md) | Directory Structure |
| Learn design patterns | [Architecture](ARCHITECTURE.md) | Key Design Patterns |
| Understand caching | [Architecture](ARCHITECTURE.md) | Performance Optimizations |
| Configure PRR | [Quick Reference](QUICK_REFERENCE.md) | Configuration Tips |
| Read success metrics | [Quick Reference](QUICK_REFERENCE.md) | Success Metrics |
| Choose or add LLM models / context limits | [Models Reference](MODELS.md) | Claude & OpenAI IDs, context, PRR usage |
| Use or integrate pill (log audit) | [tools/pill/README.md](../tools/pill/README.md) | Why analysis-only, hook, CLI, output files |

---

## 🖼️ Visual Guides

All documents include visual diagrams:

### Flowchart Document
- ✅ Mermaid flowcharts (10+ diagrams)
- ✅ ASCII art workflows
- ✅ State machine diagrams
- ✅ Data flow visualizations

### Quick Reference
- ✅ ASCII workflow diagram
- ✅ System architecture
- ✅ Fix loop details
- ✅ Feature visualizations

### Architecture Guide
- ✅ Component diagram
- ✅ Directory tree
- ✅ Data flow paths
- ✅ Integration points

---

## 🛠️ Using These Docs

### Reading in GitHub
All Mermaid diagrams render automatically in GitHub's markdown viewer. Just browse the files.

### Reading Locally
Use a markdown viewer that supports Mermaid:
- VS Code with Markdown Preview Mermaid Support extension
- Obsidian
- Typora
- Or any Mermaid-compatible viewer

### Generating PDFs
```bash
# Install markdown-pdf or pandoc
npm install -g markdown-pdf

# Convert to PDF
markdown-pdf docs/flowchart.md
markdown-pdf docs/ARCHITECTURE.md
markdown-pdf docs/QUICK_REFERENCE.md
```

### Viewing in Browser
```bash
# Serve locally with live reload
npx live-server docs/

# Or use Python
cd docs && python3 -m http.server
```

---

## 🤝 Contributing to Docs

If you find errors or want to improve documentation:

1. **For typos/clarifications**: Submit a PR directly
2. **For new sections**: Discuss in an issue first
3. **For diagrams**: Use Mermaid syntax (compatible everywhere)
4. **For examples**: Keep them real-world and practical

**Doc style guide**:
- Use clear headings with emoji for visual hierarchy
- Include code examples where helpful
- Add ASCII/Mermaid diagrams for complex flows
- Link between documents (cross-reference related sections)
- Keep Quick Reference concise, Architecture detailed

---

## 📦 What's Where

```text
📁 prr/
│
├── 📄 README.md                  ← Project overview, features, installation
├── 📄 CHANGELOG.md               ← Version history, feature additions
├── 📄 DEVELOPMENT.md             ← Development guide, conventions
│
├── 📁 docs/                      ← **You are here**
│   ├── 📄 README.md              ← This index file
│   ├── 📄 QUICK_REFERENCE.md     ← Quick start & patterns
│   ├── 📄 flowchart.md           ← Detailed flowcharts
│   ├── 📄 MODELS.md              ← Claude & OpenAI models reference
│   └── 📄 ARCHITECTURE.md        ← Technical deep-dive
│
├── 📁 shared/                    ← Shared library (constants, runners, git, logger)
│   ├── 📄 constants.ts           ← Global thresholds and limits
│   ├── 📁 runners/               ← AI tool integrations (llm-api, cursor, etc.)
│   ├── 📁 git/                   ← Git operations
│   └── 📄 logger.ts              ← Logging utilities
│
├── 📁 tools/prr/                 ← PRR tool source code
│   ├── 📄 index.ts               ← Entry point
│   ├── 📄 resolver.ts            ← Main orchestrator
│   ├── 📁 workflow/              ← Workflow modules
│   ├── 📁 state/                 ← State management
│   ├── 📁 llm/                   ← LLM client
│   ├── 📁 github/                ← GitHub API & comment parsing
│   ├── 📁 analyzer/              ← Issue analysis & prompt building
│   └── ...
│
├── 📁 tools/pill/                ← Pill tool (Program Improvement Log Looker)
│   └── 📄 README.md               ← Pill docs: analysis-only, WHYs, hook, CLI
│
├── 📁 types/                     ← Shared type definitions
│
└── 📁 tests/                     ← Test files
```

---

## 🎓 Next Steps

1. **New to PRR?**
   - Read [main README](../README.md)
   - Try [Quick Reference](QUICK_REFERENCE.md)
   - Run: `prr --help` to see options and ensure tools/API keys are configured

2. **Want to understand the flow?**
   - Study [Flowcharts](flowchart.md)
   - Trace through one full cycle
   - Run: `prr PR_URL --dry-run --verbose`

3. **Ready to contribute?**
   - Read [Architecture](ARCHITECTURE.md)
   - Review [DEVELOPMENT.md](../DEVELOPMENT.md)
   - Explore the codebase with context

4. **Found an issue?**
   - Check [Quick Reference troubleshooting](QUICK_REFERENCE.md#-troubleshooting)
   - Review logs: `~/.prr/output.log`
   - Open a GitHub issue with logs

---

## 💡 Tips

- **Mermaid not rendering?** View on GitHub or use a compatible viewer
- **Want to print?** Use markdown-pdf or similar tool
- **Need quick answers?** Use browser's find (Ctrl+F) on Quick Reference
- **Deep technical question?** Search Architecture Guide
- **Understanding a workflow?** Flowcharts have step-by-step diagrams

---

## 🐈 The PRR Philosophy

> PRR sits on your PR and won't get up until it's ready.

These docs explain **how** the cat works its magic. Happy reading! 📚

---

**Last Updated**: 2026-03-03
