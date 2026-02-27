# PRR Architecture

This document explains the high-level architecture of PRR (PR Resolver), a system for automatically resolving GitHub PR review comments using AI coding assistants.

## Core Philosophy

**Modularity via Procedural Code**: PRR's architecture emphasizes:
- Small, focused functions over large classes
- Explicit dependencies over hidden state  
- Pure functions for business logic
- Side effects isolated to clearly marked boundaries

**WHY**: This makes the codebase easier to understand, test, and refactor compared to deeply nested object hierarchies.

## System Overview

```mermaid
graph TB
    subgraph "Entry Point"
        CLI[CLI Parser<br/>src/cli.ts]
        Main[Main Entry<br/>src/index.ts]
    end
    
    subgraph "Core Resolver"
        Resolver[PR Resolver<br/>src/resolver.ts]
        ResolverProc[Resolver Procedures<br/>src/resolver-proc.ts]
    end
    
    subgraph "Workflow Orchestration"
        RunOrch[Run Orchestrator<br/>Outer loop: push iterations]
        PushLoop[Push Iteration Loop<br/>Single push cycle]
        FixLoop[Fix Loop<br/>Individual fix attempts]
    end
    
    subgraph "External Services"
        GitHub[GitHub API<br/>Fetch PR/Comments]
        LLM[LLM Client<br/>Anthropic/OpenAI/Gemini]
        Tools[AI Coding Tools<br/>Cursor/Claude/Aider/etc]
    end
    
    subgraph "State Management"
        StateCtx[State Context<br/>Comment status/verification]
        LessonsCtx[Lessons Context<br/>Learned failures]
        StateFile[(State File<br/>.pr-resolver-state.json)]
    end
    
    Main --> CLI
    CLI --> Resolver
    Resolver --> ResolverProc
    ResolverProc --> RunOrch
    
    RunOrch --> PushLoop
    PushLoop --> FixLoop
    
    FixLoop --> GitHub
    FixLoop --> LLM
    FixLoop --> Tools
    FixLoop --> StateCtx
    
    StateCtx --> StateFile
    LessonsCtx --> StateFile
// Review: states are tied to the StateFile for cohesive data management across contexts
```

```text
Fallback (plain text):

┌─────────────────────────────────────────────────────────────┐
│                         CLI Entry                            │
│                      (src/cli.ts)                           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    Main Resolver                             │
│                   (src/resolver.ts)                         │
└────────┬───────────────────────────────────────────────────┘
         │
    ┌────┴────┬────────────┬───────────────┬──────────────┐
    ▼         ▼            ▼               ▼              ▼
┌────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│GitHub  │ │ Git Ops │ │ LLM      │ │ Runners  │ │ State    │
│  API   │ │         │ │ Client   │ │          │ │ Manager  │
└────────┘ └─────────┘ └──────────┘ └──────────┘ └──────────┘
```

---

## Key Subsystems

### 1. GitHub Integration (`src/github/`)

Handles all interactions with GitHub's API:
- Fetching PR information (title, description, files, comments, status)
- Extracting bot review comments from issue comments (Claude, Greptile)
- Posting verification comments
- Managing PR metadata

**Bot comment extraction:**
Two separate paths capture review feedback:
1. **Inline review threads** (`getReviewThreads()`): GraphQL-based, captures CodeRabbit, Copilot, humans
2. **Issue comments** (`getReviewBotIssueComments()`): REST-based, captures Claude, Greptile

WHY two paths: Some bots (Claude, Greptile) post structured reviews as issue/conversation comments, not inline threads. CodeRabbit is intentionally absent from the issue-comment path — it uses inline threads, and its summary comment would produce duplicate pseudo-issues.

**Bot name normalization:**
`normalizeBotName()` converts `claude[bot]` → `Claude` for cleaner prompt display. Only used in the issue-comment path. WHY NOT in inline threads: raw logins like `coderabbitai[bot]` serve as identity keys for dedup and verification tracking — normalizing them would break matching.

**Key files:**
- `api.ts` - GitHub API client wrapper (bot filtering, normalization)
- `types.ts` - Type definitions for PR data (`PRInfo` includes title/body)

### 2. Git Operations (`src/git/`)

Manages local git repository operations:
- Cloning and updating repositories
- Creating commits with verification metadata
- Handling merge conflicts (including **large files**)
- Managing branches and merges

**Modular structure:**
- `git-clone-index.ts` - Cloning, pulling, diffing
- `git-commit-index.ts` - Commits, squashing, metadata
- `git-conflict-resolve.ts` - Conflict resolution orchestrator
- `git-conflict-chunked.ts` - Chunked resolution for large files (>50KB)
- `git-conflict-prompts.ts` - LLM prompts for conflicts
- `git-conflict-lockfiles.ts` - Lock file handling
- `git-lock-files.ts` - Dependency lock file detection
- `git-merge.ts` - Base branch merging
- `workdir.ts` - Working directory management

**Large File Conflict Resolution:**
PRR can now handle files of any size using three strategies:
1. **Heuristic** - Rule-based for package.json, lock files
2. **Chunked** - Split large files into conflict regions, resolve separately
3. **Standard** - Send entire file (<50KB) to LLM

See [Large File Conflict Resolution](./features/LARGE_FILE_CONFLICT_RESOLUTION.md) for details.

### 3. LLM Client (`src/llm/`)

Interfaces with LLM providers (Anthropic Claude, OpenAI):
- Verifying fixes
- Batch issue checking
- Conflict resolution
- Commit message generation

**Provider support:**
- ElizaCloud (unified gateway - all models via single API key)
- Anthropic (Claude Sonnet, Opus, Haiku)
- OpenAI (GPT-4, GPT-5)

**Provider auto-detection:**
Smart auto-detect prioritizes ElizaCloud → Anthropic → OpenAI based on which API keys are present. Simplifies configuration.

**Model validation at startup:**
Queries provider APIs (`GET /v1/models`) to discover accessible models. Filters internal rotation lists to prevent wasted retries on unavailable models.

**Batch analysis:**
Issue batches are capped at 50 per batch to prevent LLM response truncation. With 189 issues, batching only on prompt size caused haiku to summarize instead of listing per-issue results.

**Adaptive batch sizing:**
Fix prompts halve `MAX_ISSUES_PER_PROMPT` after each consecutive zero-fix iteration (50 → 25 → 12 → 6 → 5, minimum `MIN_ISSUES_PER_PROMPT`). WHY: A 213K-char prompt with 50 issues across 23 files produced a 5% fix rate. The model has too much to process and makes scattered, shallow changes. Progressively smaller batches improve focus before falling back to single-issue mode. See `computeEffectiveBatchSize()` in `prompt-builder.ts`.

**Issue priority triage:**
During the batch analysis phase, the LLM assesses both "does this issue still exist?" AND "how important/difficult is it?" in a single call (zero extra cost). Each issue receives:
- `importance` score (1-5): 1=critical security/data loss, 2=major bug, 3=moderate, 4=minor, 5=trivial style
- `ease` score (1-5): 1=one-line fix, 2=simple, 3=moderate, 4=complex multi-file, 5=major refactor

The response format extends from `ISSUE_ID: YES|NO|STALE: explanation` to `ISSUE_ID: YES|NO|STALE: I<1-5>: D<1-5>: explanation`. Parser uses graceful defaults (3/3) when ratings are omitted (e.g., for NO/STALE responses). Scores are propagated to all 11 `UnresolvedIssue` construction sites across the codebase.

WHY: When batching limits prompts to 50 of 93 issues, the selection was arbitrary — trivial style nits could crowd out critical security fixes. The LLM already reads every comment during analysis, so we piggyback assessment onto the same call. The `--priority-order` CLI option (default: `important`) sorts issues before batching, ensuring the fixer tackles high-impact issues first.

**Anthropic prompt caching:**
System prompts are sent as block-format content with `cache_control: { type: 'ephemeral' }` so Anthropic caches the prefix across calls. Static instruction headers for batch analysis and per-comment checks are extracted into system prompts (separated from dynamic issue data) to maximize cache hit rate.

WHY: PRR makes many sequential Anthropic calls with identical instructions (e.g., 2+ batches in `batchCheckIssuesExist`, N per-comment checks in `checkIssueExists`). Without caching, every call re-processes the same static instructions at full price. Cache reads cost 90% less than base input tokens — the first call pays a 1.25x write premium, but every subsequent call with the same prefix gets 90% discount.

Cache hit/miss stats are logged via `debug('Anthropic prompt cache', ...)` with estimated savings percentage. `LLMResponse.usage` includes `cacheCreationInputTokens` and `cacheReadInputTokens` for observability.

**Cheap model routing:**
Low-stakes text generation tasks (`generateCommitMessage`, `generateDismissalComment`) use inexpensive models — Haiku for Anthropic, GPT-4o-mini for OpenAI/ElizaCloud — instead of the default verification model (Sonnet). WHY: A one-line commit message doesn't need Sonnet's reasoning capability. Haiku ($1/$5 per MTok) produces equivalent quality at 1/3 the price of Sonnet ($3/$15 per MTok) for constrained text generation. The `CHEAP_MODELS` map is defined per-provider and used via the existing `options.model` override in `complete()`.

**`max_tokens` handling:**
- Anthropic: Set to 128,000 (required parameter). WHY: Anthropic's API won't accept a request without `max_tokens`. Setting it high ensures it's never the constraint — response length is controlled via prompt instructions, not this parameter. You only pay for tokens actually generated, not the budget ceiling. Previously hardcoded to 4096, which silently truncated responses mid-file.
- OpenAI: Omitted entirely (optional parameter). WHY: The hardcoded 4096 was truncating code-fix responses mid-file. Omitting lets the model use its natural context limit.

### 4. Analyzer (`src/analyzer/`)

Issue analysis and prompt building:
- `types.ts` - Core types: `UnresolvedIssue`, `IssueTriage`, `FixPrompt`
- `prompt-builder.ts` - Constructs fix prompts with PR context, lessons, adaptive batch sizing, triage labels
- `severity.ts` - Priority sorting by importance, difficulty, or chronological order

**PR context in prompts:**
Fix prompts include a "PR Context" section with the PR title, description (truncated to 500 chars), and base branch. This goes BEFORE the issues list so the fixer reads intent before specifics.

WHY 500 chars: PR descriptions can include templates, checklists, and embedded images. A 3000-char description would consume tokens better spent on actual issues. 500 chars captures the intent paragraph.

A `git diff <base>...HEAD --stat` instruction is added as step #0 in the Instructions section. WHY: Agentic fixers (Cursor, Claude Code, Aider) can execute shell commands. The `--stat` summary shows which files the PR touches without the full diff, giving the fixer scope awareness.

**Three prompt paths:**
1. `buildFixPrompt()` in `prompt-builder.ts` — batch mode, full PR context
2. `buildSingleIssuePrompt()` in `workflow/utils.ts` — single-issue fallback, title + baseBranch only (no body, to keep focus tight)
3. Inline template in `workflow/helpers/recovery.ts` — emergency fallback, no PR context (minimal prompt for maximum reliability)

**Priority sorting:**
The `sortByPriority()` function accepts 7 sort orders:
- `important` (default): Most important first (1=critical first)
- `important-asc`: Least important first (5=trivial first)
- `easy`: Easiest fixes first (1=one-liner first)
- `easy-asc`: Hardest fixes first (5=refactor first)
- `newest`: Newest comments first
- `oldest`: Oldest comments first (GitHub default)
- `none`: No sorting (preserve input order)

**Non-mutating sort:** Returns a new array instead of sorting in-place. WHY: The `unresolvedIssues` array is shared state used by the fix loop, no-changes verification, and single-issue focus mode. Single-issue focus mode intentionally randomizes order — if we mutated the array, randomization and priority sort would fight each other on alternate iterations.

**Default triage:** Issues without LLM-assigned triage (recovery paths, new comments mid-cycle) default to `{ importance: 3, ease: 3 }` (middle of pack), not `5` (worst). WHY: These aren't necessarily trivial, they just haven't been analyzed yet. Putting them in the middle ensures they're not deprioritized.

### 5. Runners (`src/runners/`)

Fixer tools that make actual code changes:
- **Cursor** - Cursor Composer agent
- **OpenCode** - VS Code with Claude Code Composer
- **Aider** - Terminal-based AI pair programmer
- **Claude Code** - Anthropic's code editor
- **Codex** - Direct GPT integration
- **Gemini CLI** - Google's Gemini coding agent
- **LLM API** - Fallback direct API calls

Each runner implements the `Runner` interface:
```typescript
interface Runner {
  name: string;
  displayName: string;
  installHint?: string;  // Install command shown when tool not found
  run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunResult>;
}
```

**Runner output hygiene:** Runners return clean text in `RunResult.output`, not raw protocol frames. WHY: The Cursor runner streams JSON frames like `{"type":"text","content":"..."}`. Downstream consumers like `parseNoChangesExplanation()` search the output for patterns like `NO_CHANGES:` — raw JSON metadata caused false matches against embedded instruction text, triggering expensive re-verification of all issues.

### 6. State Management (`src/state/`)

Persistent state lives in `.pr-resolver-state.json` in the repo workdir. WHY this name: Unambiguous (not just "state") and tool-prefixed so it's clear it belongs to PRR and doesn't collide with other tools' state files.

Maintains session state across iterations:
- Verified fixes (prevents re-checking)
- Dismissed issues (skips false positives)
- Iteration history
- Runner/model rotation state
- **Final audit and verification cache:** When the final audit finds issues still unfixed, PRR calls `unmarkVerified()` for each before re-entering the fix loop. WHY: Otherwise the next iteration would skip re-verification (they remain in verifiedFixed), report no changed files, and loop indefinitely.
- **Lessons learned** - Tracks failure patterns

**Lessons System:**
When fixes fail, PRR learns:
- What failed and why
- Which models/runners to avoid
- File-specific patterns

Lessons are:
- Stored globally and per-repository
- Synced to `CLAUDE.md` / `CONVENTIONS.md` for human review
- Included in future fix prompts to avoid repeating mistakes
- Deduplicated via Jaccard similarity (0.6 threshold) to prevent bloat

**Key files:**
- `state-context.ts` - State container
- `state-*.ts` - State operation modules (verification, lessons, iterations)
- `lessons-*.ts` - Lessons subsystem modules

### 7. Workflow Orchestration (`src/workflow/`)

Breaks down the main resolver loop into focused phases:

**Startup Phase** (`startup.ts`):
- Initialize configuration
- Load state and lessons
- Set up working directory

**Setup Phase** (`run-setup-phase.ts`):
- Clone/update repository
- Ensure gitignore entries
- Recover verification state
- Check for remote conflicts
- Merge base branch if needed

**Main Loop** (`run-main-loop.ts`):
- Analyze unresolved issues
- Generate fix prompt
- Run fixer tool
- Verify fixes
- Handle iteration results
- Rotate models/runners as needed

**Cleanup Phase** (`final-cleanup.ts`):
- Commit verified fixes
- Push to remote
- Print summaries
- Clean up working directory

**Other workflow modules:**
- `fix-verification.ts` - Post-fix verification logic (both sequential and batch modes). Skips issues already verified by recovery phases to avoid redundant LLM calls. Diff + snippet fetching parallelized via `Promise.all()`.
- `no-changes-verification.ts` - Handles fixer tools that make zero changes (spot-check verification, "already fixed" detection). Tries `parseResultCode()` first for structured RESULT: ALREADY_FIXED / UNCLEAR / WRONG_LOCATION / CANNOT_FIX; falls back to `parseNoChangesExplanation()` for legacy NO_CHANGES and inferred text. Extracts tail of fixer output as lesson when no structured explanation is found. WHY structured first: RESULT codes drive targeted lessons and routing (e.g. WRONG_LOCATION → "provide wider code context") without losing backward compatibility.
- `issue-analysis.ts` - Issue batching and analysis (wires triage scores from LLM results into `UnresolvedIssue` objects). Two-phase snippet fetching: sync solvability filter, then parallel fetch. LLM dedup calls parallelized across files. **Snippet accuracy:** `parseLineReferencesFromBody()` extracts line numbers from comment text (e.g. "around lines 52 - 93"); `getCodeSnippet()` merges them with `comment.line` and LOCATIONS into a single anchor set, then returns 20/30 lines of context before/after (capped at 500 lines). WHY: Review bots often anchor at line 1 but refer to lines 50–90 in the body — without parsing refs, the fixer never saw the relevant code. **Addressed hint:** Comments containing "✅ Addressed in commits ..." get an extra `contextHints` line so the analysis LLM explicitly verifies the current code still resolves the issue.
- `execute-fix-iteration.ts` - Runs a single fix iteration. Includes MD5-based duplicate prompt detection to skip identical prompt+model retries. **RESULT protocol:** When the fixer returns RESULT: NEEDS_DISCUSSION (e.g. only added a `// REVIEW:` comment), the "has changes" path treats it as progress (no verification run, consecutive failures reset). WHY: Discussion-only changes shouldn't trigger verification or count as failures.
- `fix-loop-rotation.ts` - Model/tool rotation and recovery strategies. Resets prompt tracker on rotation so new models aren't falsely detected as duplicates.
- `prompt-building.ts` - Sorts issues by `--priority-order`, displays triage breakdown in console
- `dismissal-comments.ts` - Adds inline code comments for dismissed issues. LLM generates comment text (developer-style "why", with EXISTING/SKIP/COMMENT options); insertion is programmatic (line-aware, bottom-to-top). JSON and other no-comment file types are skipped; issues verified this session are skipped to avoid re-insertion. Processes files in parallel, sequential within each file.
- `graceful-shutdown.ts` - SIGINT handling
- `helpers/recovery.ts` - Recovery strategies: single-issue focus mode, direct LLM API fix (with focused-section mode for large files), infrastructure failure detection. Timed via `startTimer`/`endTimer`.
- `helpers/solvability.ts` - Pre-screens issues for solvability (deleted files, stale refs, exhausted attempts). `recheckSolvability` parallelizes snippet fetching.
- `utils.ts` - `parseNoChangesExplanation()` with prompt regurgitation detection

### 8. UI & Reporting (`src/ui/`)

User-facing output and progress indicators:
- Spinners for long operations
- Progress bars for batched operations
- Timing summaries
- Token usage reports (including Anthropic cache hit/miss stats)
- Model performance stats
- **After Action Report**: Three-section AAR (Fixed This Session, Dismissed, Remaining) with suggested resolutions

### 9. Prompt Sanitization (`src/analyzer/prompt-builder.ts`)

Comment body cleanup before LLM ingestion:
- `sanitizeCommentForPrompt()` strips base64 JWT tokens from "Fix in Cursor" links, HTML metadata comments (`<!-- BUGBOT_BUG_ID -->`, `<!-- DESCRIPTION START/END -->`), `<details>/<summary>` blocks, `<picture>/<img>` tags, and other bot-specific noise.
- Applied to all prompt paths: fix prompts, dedup, batch analysis, verification, failure analysis, commit messages, and dismissal comments.

WHY: Bot review comments embed massive base64-encoded JWTs (500+ chars per link) and HTML metadata that wastes tokens and pollutes LLM context. A typical CodeRabbit comment shrinks by 30-60% after sanitization, improving both cost and LLM comprehension.

### 10. Logging (`src/logger.ts`)

Three-tier logging system:
- **`output.log`**: All console output, ANSI-stripped. Truncated per run. Patches `console.log/warn/error` directly (excludes spinner noise).
- **`prompts.log`**: Full LLM prompts and responses. Each entry tagged with a searchable slug (e.g., `#0007/llm-anthropic`) that also appears as a one-liner in `output.log`.
- **Standalone debug files**: Individual prompt/response files in `~/.prr/debug/<timestamp>/` (when `PRR_DEBUG_PROMPTS=1`).

WHY dual logging: Inlining 5-50K prompts in `output.log` would drown the operational log. The slug system enables cross-file navigation: see something suspicious in `output.log`, Cmd+F the slug in `prompts.log` to jump to the full prompt.

---

## Data Flow

### Issue Resolution Flow

```text
1. Fetch PR comments from GitHub
   ├─ Inline review threads (GraphQL)
   └─ Bot issue comments (Claude, Greptile)
   ↓
2. Pre-screen for solvability (skip deleted files, stale refs)
   ↓
3. Check if issues still exist (batch LLM call, max 50/batch)
   ↓
4. Filter out already-fixed issues (from state)
   ↓
5. For remaining issues:
   ├─ Build fix prompt with PR context + code context + lessons
   ├─ Run fixer tool (Cursor/Aider/Gemini/etc.)
   ├─ Verify each fix (LLM check)
   ├─ Commit verified fixes
   └─ Record failures as lessons
   ↓
6. If progress: continue loop
   If stalled: rotate model/tool
   If no issues remain: trigger CodeRabbit final review, complete
```

### Conflict Resolution Flow

```text
1. Detect conflicted files during git operations
   ↓
2. Separate by conflict type
   ├─ Lock files → Delete & regenerate
   ├─ Delete conflicts (UD/DU/DD) → git rm (accept deletion)
   └─ Code files → Resolve with AI
       ↓
3. Attempt 1: Runner tool (Cursor/Aider)
   ↓
4. If conflicts remain → Attempt 2: Direct LLM API
   ├─ Try heuristic resolution first (package.json, etc.)
   ├─ If file >50KB → Use chunked strategy
   │   ├─ Extract conflict regions
   │   ├─ Resolve each chunk with context
   │   └─ Reconstruct full file
   └─ If file <50KB → Standard resolution
   ↓
5. Stage resolved files, continue workflow
```

### Escalation Flow

```text
Batch (50) → Batch (25) → Batch (12) → Batch (6) → Batch (5)
                                                        ↓
                                                Single-Issue (1-3)
                                                        ↓
                                                Model Rotation
                                                        ↓
                                                Tool Rotation
                                                        ↓
                                                Direct LLM API (focused-section)
                                                        ↓
                                                    Bail Out
```

---

## State Persistence

State is stored in `.pr-resolver-state.json` in the cloned repository:

```json
{
  "verifiedFixed": ["comment_123", "comment_456"],
  "dismissedIssues": ["comment_789"],
  "iterationCount": 3,
  "currentRunnerIndex": 1,
  "modelIndices": { "cursor": 2, "aider": 0 },
  "lastModelRotation": "2025-02-08T12:34:56.789Z",
  ...
}
```

Lessons are stored in `.prr/lessons.md` (markdown format) and `.prr/lessons.json` (machine-local JSON):
```json
{
  "global": [
    "Fix for src/foo.ts:42 rejected: Always check null before accessing properties"
  ],
  "files": {
    "src/foo.ts": [
      "Use ?? instead of || for nullish coalescing in TypeScript"
    ]
  }
}
```

**Lesson normalization** (`src/state/lessons-normalize.ts`): Raw text from fixers, batch verify, and no-changes handlers is normalized before storage. Design is *flexible on input, best-effort canonical form*: (1) inline backticks (e.g. `execSync`) are preserved for readable code references; (2) "tool/fixer made no changes" variants are canonicalized and kept instead of rejected so they can be deduped; (3) single-asterisk list lines and code-fence blocks are dropped to avoid junk. WHY: Lessons come from many sources; rejecting messy-but-valid input lost signal. Normalizing gives one consistent shape for `.prr/lessons.md` and CLAUDE.md without forcing callers to pre-sanitize.

---

## Cost Optimizations

### Token Usage
- Batch issue checking (check 50 issues in one LLM call)
- Truncate large comments (max 2000 chars each)
- Limit code snippets (max 500 lines)
- Chunked conflict resolution (splits large files)
- **Spot-check verification**: When a fixer claims "already fixed" with no changes, sample 5 issues first. If < 40% pass, skip the full batch verification entirely. WHY: A garbled model response claiming "already fixed" triggered verification of 88 issues (2+ minutes, significant tokens). Spot-checking rejects bogus claims before committing to the expensive full pass.
- **Adaptive batch sizing**: Fewer issues per prompt when the model is struggling, reducing prompt size and cost before falling to single-issue mode
- **Anthropic prompt caching**: System prompts marked with `cache_control` for 90% cheaper cache reads on repeated calls (batch analysis batches, per-comment checks)
- **Focused-section mode**: Direct LLM fixes on large files (>15K chars) send ±150 lines around the issue instead of the full file. WHY: The original approach embedded up to 100K chars (~25K tokens) of full file content. This wasted input tokens AND forced the LLM to reproduce the entire file in output — often hitting the output limit, causing the code extraction regex to fail silently.
- **Cheap model routing**: Commit messages and dismissal comments use Haiku/GPT-4o-mini instead of Sonnet — ~66% cheaper for simple text generation with no quality loss.
- **Infrastructure failure fast-path**: Skips `analyzeFailedFix` LLM calls when the failure is obviously infrastructure (quota, timeout, crash). WHY: Asking an LLM "why did this fail?" when the answer is "429 Quota exceeded" is pure token waste. Records a plain-text lesson instead.
- **Redundant verification skip**: Issues confirmed fixed by recovery phases are not re-verified in the main pass. WHY: Each skip saves one `verifyFix` call on a known-good result.

### Caching & State
- Verified fixes cached to avoid re-verification
- Dismissed issues skip analysis entirely
- Comment status caching with file content hash (skip LLM re-analysis for comments on unmodified files)
- Git clone is reused across iterations (unless conflicts)
- Anthropic prompt cache stats tracked for observability (creation/read tokens, savings %)

---

## Configuration

Configuration comes from multiple sources (priority order):

1. **Command-line arguments** (`--model`, `--max-context`, etc.)
2. **Environment variables** (`.env` file)
3. **Defaults** (`src/constants.ts`)

Key configuration:
- `LLM_PROVIDER`: 'anthropic' | 'openai' | 'elizacloud'
- `MODEL`: Specific model to use
- `MAX_CONTEXT_CHARS`: Context window size
- `MAX_STALE_CYCLES`: When to give up

---

## Error Handling & Resilience

- **Graceful shutdown** (`src/workflow/graceful-shutdown.ts`): Single Ctrl+C saves state and exits cleanly. Double Ctrl+C force exits.
- **State persistence** (`src/state/manager.ts`): Auto-save on every mutation. Resume from interruption.
- **Conflict auto-resolution** (`src/git/git-conflict-resolve.ts`): Lock files regenerated via package manager. Code files resolved by LLM (2 attempts).
- **Push retry with rebase** (`src/git/git-push.ts`): On rejection, pull + rebase + retry. Auto-inject GitHub token to remote URL.
- **Distributed locking** (`src/state/lock-functions.ts`): Prevents parallel instances on same PR. PID-based stale lock detection.

---

## Extension Points

### Adding a New Runner

1. Implement `Runner` interface in `src/runners/your-runner.ts`
2. Export from `src/runners/index.ts`
3. Add detection logic in `detectAvailableRunners()`
4. Add to CLI help text

### Adding a New LLM Provider

1. Add provider type to `src/config.ts`
2. Implement client in `src/llm/client.ts`
3. Add environment variable validation
4. Update documentation

### Adding New Heuristic Resolution

1. Add file type detection in `tryHeuristicResolution()` (`src/git/git-conflict-chunked.ts`)
2. Implement resolution function (e.g., `resolveDockerfileConflict()`)
3. Return `{ resolved: true/false, content, explanation }`

---

## Code Organization Principles

### Module Structure
```text
src/subsystem/
├── subsystem-core.ts       # Core types and pure functions
├── subsystem-operations.ts # Stateful operations
├── subsystem-helpers.ts    # Utility functions
└── index.ts               # Public re-export facade
```

### Naming Conventions
- **Functions**: `verbNoun()` (e.g., `parseComment`, `buildPrompt`)
- **Types**: `PascalCase` (e.g., `ReviewComment`, `RunResult`)
- **Constants**: `SCREAMING_SNAKE_CASE`
- **Files**: `kebab-case.ts`

### Import Style
- Use explicit imports: `import { foo } from './module.js'`
- Always include `.js` extension (ES modules requirement)
- Prefer named exports over default exports

---

## Security Considerations

- **API key protection**: Loaded from `.env` only. Never logged or committed. Injected to remote URL when needed (push authentication).
- **Command injection prevention**: Model names validated with regex. PR URLs parsed and validated. No shell interpolation of user input.
- **Workdir isolation**: Hash-based unique directories (`~/.prr/work/<hash>`). Cleaned up by default (unless `--keep-workdir`).
- **State file security**: Added to `.gitignore` automatically. Contains no secrets (only PR metadata).
- **Distributed locking**: Prevents parallel instances. PID for stale lock detection. Auto-cleanup on graceful shutdown.

---

## Testing Strategy

PRR uses a combination of:
- **Unit tests** - For pure functions (parsers, formatters)
- **Integration tests** - For subsystems (git ops, LLM client)
- **End-to-end tests** - Full workflow with real repos

Run tests:
```bash
npm test                    # All tests
npm test -- git-ops        # Specific suite
```

---

## Debugging

Enable verbose logging:
```bash
prr -v <pr-url>  # Verbose mode
```

This shows:
- All LLM prompts and responses
- Git command execution
- State transitions
- Timing for each phase
- Anthropic prompt cache hit/miss stats

**Output log tee:** Every run mirrors all console output (ANSI-stripped) to `~/.prr/output.log`. The file is truncated on each run start so it always contains only the latest session. WHY: Debugging prr often means feeding its output into another LLM for analysis. Terminal scrollback is hard to search and copy-paste loses formatting. A plain-text file can be directly referenced (`@~/.prr/output.log` in Cursor) or piped into any tool.

---

## Further Reading

- **Flowcharts**: `docs/flowchart.md`
- [Runners Documentation](./RUNNERS.md) - Deep dive into fixer tools
- [PR Context in Prompts](./features/PR_CONTEXT_IN_PROMPTS.md) - Why fix prompts include PR metadata
- [Large File Conflicts](./features/LARGE_FILE_CONFLICT_RESOLUTION.md) - Chunked resolution details
- [Development Guide](./DEVELOPMENT.md) - Contributing to PRR
- **Changelog**: `CHANGELOG.md`
