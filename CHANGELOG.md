# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (2026-02-12)

**Batch Verification with Inline Failure Analysis (Fix N+1 LLM Calls)**
- `batchVerifyFixes` prompt overhauled to produce the same quality lessons as the standalone `analyzeFailedFix` — 4 good + 3 bad examples, explicit "what the diff changed vs what the comment asked" framing, LESSON line required for every NO
- Batch mode now uses these inline lessons instead of making separate `analyzeFailedFix` calls per failure
- Reduces LLM calls from 1+N (where N = failed fixes) to just 1
- Sequential mode (`--no-batch`) still uses dedicated `analyzeFailedFix` for maximum quality
- WHY: With 12 fixes and 6 failures, batch "verification" was making 7 LLM calls (1 batch verify + 6 individual failure analyses). The batch prompt previously had a minimal lesson request ("LESSON: actionable guidance" with 1 example). Now it matches the standalone prompt's rigor, so no separate calls are needed.

**Issue Priority Triage**
- LLM-based importance (1-5) and difficulty (1-5) assessment for every issue during analysis
- New `--priority-order` CLI option with 7 sort strategies: `important` (default), `important-asc`, `easy`, `easy-asc`, `newest`, `oldest`, `none`
- Triage scores displayed in fix prompts as `[importance:X/5, difficulty:Y/5]` per issue
- Console output shows breakdown: "8 critical/major, 22 moderate, 12 minor/trivial (sorted: critical first)"
- Per-batch debug logs now include `avgImportance` and `avgEase` metrics
- WHY: When batching limits prompts to 50 of 93 issues, the selection was arbitrary - trivial style nits could crowd out critical security fixes. The LLM already reads every comment to judge "does this still exist?", so we piggyback importance/difficulty assessment onto the same call at zero extra cost. Sorting by importance ensures the fixer tackles high-impact issues first. The `easy` sort order enables "quick wins first" strategies to show visible progress faster.

**Output Log Tee (`~/.prr/output.log`)**
- All console output is mirrored to `~/.prr/output.log` as clean ANSI-stripped text
- File is truncated on each run start, so it always contains only the latest run
- Path printed at end of run for easy access
- WHY: Feeding terminal output back into an LLM for debugging required manual copy-paste from scrollback. A plain-text log file can be directly referenced or piped into Cursor/Claude.

**Adaptive Batch Sizing**
- Fix prompts now halve `MAX_ISSUES_PER_PROMPT` after each consecutive zero-fix iteration (50 → 25 → 12 → 6 → 5)
- New constant `MIN_ISSUES_PER_PROMPT = 5` prevents reduction below the single-issue focus threshold
- New exported function `computeEffectiveBatchSize()` in prompt-builder
- WHY: Logs showed the model fixing 5/50 issues in iteration 1, then 0/50 in iterations 2-3. The 213K-char prompt with 50 issues across 23 files was too much cognitive load. Adaptive sizing gives the model a progressively smaller workload before falling back to single-issue focus mode.

**Spot-Check Verification for NO_CHANGES Claims**
- When a fixer claims "already fixed" but made zero changes, a sample of 5 issues is verified before committing to full batch verification
- If fewer than 40% of the sample pass, the full verification is skipped entirely
- WHY: A garbled model response triggered re-verification of 88 issues (2+ minutes, significant token cost). Spot-checking rejects bogus claims cheaply before wasting tokens on a full pass.

**Prompt Regurgitation Detection**
- `parseNoChangesExplanation()` now rejects output that matches known prompt template fragments (e.g., "Issue 1 is already fixed - Line 45 has null check")
- Both Stage 1 (explicit `NO_CHANGES:`) and Stage 2 (inferred patterns) check against `PROMPT_REGURGITATION_MARKERS`
- WHY: When overwhelmed by large prompts, models sometimes echo the instruction template verbatim instead of reasoning about the issues. This was treated as a valid "already fixed" claim, triggering expensive re-verification for nothing.

### Fixed (2026-02-12)

**Overly Broad "Already Fixed" Detection**
- Replaced single-word `includes('has')` / `includes('exists')` checks with regex word-boundary patterns like `/\balready\s+fixed\b/`
- WHY: `includes('has')` matched "This **has** not been resolved"; `includes('exists')` matched "The file no longer **exists**". These false positives triggered expensive re-verification of all unresolved issues even when the fixer's explanation indicated failure, not success.

**Cursor Runner Output Pollution**
- Cursor runner now returns clean extracted text content instead of raw JSON stream frames
- Added separate `textContent` accumulator alongside `stdout` for debug logging
- WHY: The raw `stdout` included `{"type":"text","content":"..."}` JSON and `{"session_id":"..."}` metadata. `parseNoChangesExplanation` searched this raw output, matching `NO_CHANGES:` inside JSON values and treating garbled metadata as a valid explanation.

**Non-Actionable Batch Verification Lessons**
- Batch verification mode now calls `llm.analyzeFailedFix()` for failed verifications, matching sequential mode behavior
- WHY: Batch mode was recording raw verification explanations like "diff doesn't show changes to X" as lessons. These describe what went wrong but not what to do differently. `analyzeFailedFix` produces actionable guidance like "don't just add Y, also need to update Z".

### Removed (2026-02-12)

**Duplicate `handleNoChanges` Function**
- Removed `handleNoChanges()` from `fixer-errors.ts` and its re-export from `resolver-proc.ts`
- The canonical handler is `handleNoChangesWithVerification()` in `no-changes-verification.ts`
- WHY: Two implementations with divergent "already fixed" detection logic caused confusion. The removed version (stricter) was never actually called; the used version (broader) had the bugs. Consolidating to a single implementation prevents future drift.

**Gemini CLI Runner**
- New runner for Google's Gemini CLI (`npm install -g @google/gemini-cli`)
- Supports `gemini-2.5-pro` and `gemini-2.5-flash` in model rotation
- Auto-detect installation, version, and API key status
- Non-interactive execution via `--yolo` and `--prompt` flags

**`--tidy-lessons` CLI Option**
- Scans all lesson JSON files in `~/.prr/lessons/` and re-normalizes, deduplicates, prunes garbage entries
- Also cleans `.prr/lessons.md` in the current repo (flexible parser handles multiple Markdown formats)
- Filters out non-actionable noise like "No verification result returned, treating as failed"

**`--update-tools` CLI Option**
- Runs `npm install -g` / `pip install --upgrade` for all detected AI coding tools
- Shows current vs latest version comparison
- Supports Codex, Claude Code, Aider, OpenCode, Cursor, Gemini CLI

**Model Validation at Startup**
- Queries OpenAI (`GET /v1/models`) and Anthropic APIs to discover accessible models
- Filters internal rotation lists so inaccessible models (e.g. `gpt-5.3-codex`) are never attempted
- Prevents wasted retries on "model does not exist" errors

**Issue Solvability Detection**
- Pre-screens review comments to identify issues that are impossible to fix (deleted files, stale references)
- Prevents wasting LLM tokens on unsolvable issues

**Install Hints for Runners**
- When a tool is not installed, `--check-tools` now shows the install command (e.g. `→ npm install -g @anthropic-ai/claude-code`)

### Fixed (2026-02-09 → 2026-02-12)

**Batch Analysis Parse Failures**
- Capped batch issue analysis at 50 issues per batch; 189 issues in a single batch caused haiku to summarize instead of producing 189 structured response lines (parsed 0/189)

**Direct LLM Fix Using Wrong Model**
- `tryDirectLLMFix` was using the cheap verification model (haiku) instead of a capable fixer model
- Now uses `claude-sonnet-4-5-20250929` (Anthropic) or `gpt-4o` (OpenAI) via model override on `llm.complete()`

**Batch Verify ID Garbling**
- Batch verification used complex GraphQL node IDs that the LLM would garble when echoing back (parsed 34/38)
- Now uses simple numeric IDs (1, 2, 3...) with an internal map back to original IDs

**Delete Conflict Resolution**
- Git conflicts where one side deleted a file (e.g. "deleted by them" for `CLAUDE.md`) were unhandled
- Now detects `UD`/`DU`/`DD` status codes via `git status --porcelain` and resolves with `git rm`

**CodeRabbit Trigger Control**
- Stopped triggering CodeRabbit re-review after every push (created moving target)
- Now only triggers CodeRabbit for a final review when all issues are resolved

**Garbage Lessons Pollution**
- Stopped generating "No verification result returned, treating as failed" as lessons
- Added normalization filters to reject non-actionable infrastructure messages
- `llm-api` runner now returns `success: false` when all search/replace operations fail (instead of silently reporting "no changes")

**Infinite Loop in pushWithRetry**
- Fixed stale comment date causing infinite retry loop

**Push/Fix Loops Not Running**
- `0 ?? Infinity` evaluates to `0`, not `Infinity` — fixed so 0 means unlimited iterations

**CodeRabbit Race Condition**
- Now waits for CodeRabbit review to complete before fetching comments

**UTF-16 Surrogate Sanitization**
- Sanitize unpaired UTF-16 surrogates before sending to LLM APIs (prevented API errors)

**Catastrophic Conflict Resolution Safeguards**
- Added safeguards to prevent conflict resolution from producing worse output than the conflicted input

**Lock File Conflict Handling**
- Fixed trailing comma in `package.json` conflict resolution

### Changed (2026-02-08 → 2026-02-12)

**Code Quality**
- Converted dynamic imports to static ES imports across workflow modules
- Consolidated constants, hardened error handling, improved type safety
- Added comprehensive JSDoc comments to state and workflow modules
- Removed large amounts of duplicate/unused code across workflow and runner modules
- Updated llm-api model rotation to current Anthropic lineup

---

### Changed - Major Refactoring (2026-02-08)

#### God Object Elimination
Converted three large "god object" classes into procedural modules for better maintainability and modularity.

**1. LockManager → Procedural Functions**
- Converted 279-line class to procedural functions in `lock-functions.ts`
- Updated 7 workflow files
- **Result**: Eliminated lock state management class

**2. StateManager → 10 Modules (17% reduction)**
- **Before**: 782 lines in single class
- **After**: 645 lines across 10 focused modules
- **Reduction**: 137 lines (17%)
- **Files updated**: ~45 files
- **Modules created**:
  - `state-context.ts` - Context interface and factory
  - `state-core.ts` - Load/save/interruption handling
  - `state-verification.ts` - Verification tracking
  - `state-dismissed.ts` - Dismissed issue tracking
  - `state-lessons.ts` - Lessons state management
  - `state-iterations.ts` - Iteration history
  - `state-rotation.ts` - Model rotation state
  - `state-performance.ts` - Performance metrics
  - `state-bailout.ts` - Bailout condition tracking
  - `index.ts` - Re-export facade

**3. LessonsManager → 14 Modules (12% reduction)**
- **Before**: 1,341 lines in single class
- **After**: 1,175 lines across 14 focused modules
- **Reduction**: 166 lines (12.4%)
- **Files updated**: ~50 files
- **Modules created**:
  - `lessons-context.ts` - Context interface
  - `lessons-paths.ts` - Path resolution and constants
  - `lessons-load.ts` - Loading from disk
  - `lessons-normalize.ts` - Text normalization (246 lines)
  - `lessons-parse.ts` - Markdown parsing
  - `lessons-format.ts` - Markdown formatting
  - `lessons-prune.ts` - Pruning stale lessons
  - `lessons-save.ts` - Saving to disk
  - `lessons-sync.ts` - Syncing to target files
  - `lessons-detect.ts` - Auto-detection
  - `lessons-add.ts` - Adding lessons
  - `lessons-retrieve.ts` - Querying lessons
  - `lessons-compact.ts` - Deduplication
  - `lessons-index.ts` - Re-export facade

#### Git Module Organization
Split three large git files into 19 focused modules by responsibility.

**1. git/commit.ts → 7 Modules (4% reduction)**
- **Before**: 677 lines
- **After**: 652 lines across 7 modules
- **Reduction**: 25 lines (3.7%)
- **Modules created**:
  - `git-commit-core.ts` (35 lines) - Basic staging and committing
  - `git-commit-query.ts` (17 lines) - Read-only queries
  - `git-commit-iteration.ts` (52 lines) - Iteration commits with markers
  - `git-commit-scan.ts` (51 lines) - Recovery from git history
  - `git-commit-message.ts` (160 lines) - Message formatting
  - `git-push.ts` (328 lines) - Push with timeout/retry
  - `git-commit-index.ts` (9 lines) - Re-export facade

**2. git/clone.ts → 7 Modules (4% reduction)**
- **Before**: 624 lines
- **After**: 602 lines across 7 modules
- **Reduction**: 22 lines (3.5%)
- **Modules created**:
  - `git-clone-core.ts` (110 lines) - Clone and update operations
  - `git-diff.ts` (43 lines) - Diff queries
  - `git-conflicts.ts` (73 lines) - Conflict detection
  - `git-pull.ts` (161 lines) - Pull with auto-stash
  - `git-merge.ts` (221 lines) - Merge operations
  - `git-lock-files.ts` (43 lines) - Lock file utilities
  - `git-clone-index.ts` (10 lines) - Re-export facade

**3. git/operations.ts → 5 Modules (5% reduction)**
- **Before**: 505 lines
- **After**: 479 lines across 5 modules
- **Reduction**: 26 lines (5.1%)
- **Modules created**:
  - `git-conflict-prompts.ts` (36 lines) - Prompt generation
  - `git-conflict-lockfiles.ts` (225 lines) - Lock file conflict handling
  - `git-conflict-resolve.ts` (185 lines) - LLM-based resolution
  - `git-conflict-cleanup.ts` (65 lines) - Cleanup created files
  - `git-operations-index.ts` (8 lines) - Re-export facade

### Removed
- `src/state/lock.ts` - Replaced by `lock-functions.ts`
- `src/state/manager.ts` - Replaced by 10 state modules
- `src/state/manager-proc.ts` - Removed (unused duplicate)
- `src/state/lessons.ts` - Replaced by 14 lessons modules
- `src/git/commit.ts` - Split into 7 modules
- `src/git/clone.ts` - Split into 7 modules
- `src/git/operations.ts` - Split into 5 modules

### Added - Documentation

**Architecture Guides**
- `GIT_MODULES_ARCHITECTURE.md` - Complete guide to 19 git modules
  - Module organization and responsibilities
  - Design principles (separation by workflow, complexity isolation)
  - Usage examples and migration guide
  
- `STATE_MODULES_ARCHITECTURE.md` - Complete guide to 24 state modules
  - State vs Lessons separation
  - Context objects vs classes
  - Procedural design benefits
  - Usage examples and migration guide

- `REFACTORING_WHY_GUIDE.md` - Philosophy and decision-making
  - Why eliminate god objects
  - Why procedural instead of classes
  - Why module boundaries matter
  - When to split vs keep together
  - Success metrics and future guidelines

**Code Documentation**
Enhanced inline documentation with WHY comments explaining:
- Design decisions (why spawn() not simple-git)
- Security considerations (why validate workdir paths)
- Recovery mechanisms (why scan git log for markers)
- Performance optimizations (why limit to 100 commits)
- Error handling strategies (why return empty array on scan failure)

## Summary of Changes

### Overall Metrics

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **God Object Classes** | 3 | 0 | -100% |
| **Total Lines** | 5,735 | 5,284 | -451 lines (-7.9%) |
| **Module Count** | 6 large files | 43 focused modules | +37 modules |
| **Largest File** | 1,341 lines | 328 lines | -75.5% |
| **Avg Module Size** | 956 lines | 123 lines | -87% |
| **Files >500 lines** | 6 | 3* | -50% |

\* Remaining files >500 lines are legitimate:
- `llm/client.ts` (1,092) - API adapter class
- `github/api.ts` (828) - API adapter class  
- `resolver-proc.ts` (533) - Facade (re-exports only)

### Architectural Improvements

✅ **Classes Only for API Adapters**
- Domain logic converted to procedural functions
- Only LLMClient and GitHubAPI remain as classes (external API adapters)
- All other code uses explicit state passing via context objects

✅ **Explicit State Management**
- Replaced implicit `this` with explicit context objects
- Clear data flow (no hidden state)
- Easier testing (pass mock contexts)
- Better debugging (see what data goes where)

✅ **Module Organization**
- Single responsibility per module
- Clear boundaries by concern/workflow
- Facade pattern for convenient imports
- Consistent naming conventions

✅ **File Size Targets**
- Most modules < 250 lines
- Largest procedural file: 328 lines (git-push.ts)
- Easy to navigate and understand
- Fits in your head

### Benefits Realized

**Developer Experience**
- ✅ Easier to find relevant code (focused modules)
- ✅ Faster to understand specific functionality  
- ✅ Simpler to modify without side effects
- ✅ Better IDE navigation and search

**Code Quality**
- ✅ Zero compilation errors after refactoring
- ✅ Clean production build
- ✅ Improved test coverage potential
- ✅ Better separation of concerns

**Maintainability**
- ✅ Clear module boundaries
- ✅ Explicit dependencies  
- ✅ Easier onboarding for new developers
- ✅ Reduced cognitive load

### Migration Guide

**Old (Class-based)**
```typescript
const stateManager = new StateManager(workdir);
await stateManager.loadState(pr, branch, sha);
stateManager.markCommentVerifiedFixed(commentId);
await stateManager.saveState();
```

**New (Procedural)**
```typescript
import * as State from './state/index.js';

const ctx = State.createStateContext(workdir);
await State.loadState(ctx, pr, branch, sha);
State.markCommentVerifiedFixed(ctx, commentId);
await State.saveState(ctx);
```

**Import Changes**
```typescript
// Old imports
import { squashCommit, push } from './git/commit.js';
import { cloneOrUpdate } from './git/clone.js';

// New imports (direct)
import { squashCommit } from './git/git-commit-core.js';
import { push } from './git/git-push.js';
import { cloneOrUpdate } from './git/git-clone-core.js';

// Or use facades
import * as GitCommit from './git/git-commit-index.js';
import * as GitClone from './git/git-clone-index.js';
```

### Design Principles Established

1. **Context Objects Instead of Classes**
   - Simple data structures replace class instances
   - Explicit state passing
   - No hidden dependencies

2. **Single Responsibility Modules**
   - Each module has one clear purpose
   - Easy to locate specific functionality
   - Changes are localized

3. **Facade Pattern**
   - Index files re-export related modules
   - Convenient namespace imports
   - Maintain encapsulation

4. **Procedural by Default**
   - Functions transform data
   - No object lifecycle complexity
   - Easier to test and compose

5. **Classes Only for Adapters**
   - External API wrappers use classes
   - Domain logic is procedural
   - Clear architectural boundary

## Build Status

✅ TypeScript compilation: **0 errors**  
✅ Production build: **Success**  
✅ All tests: **Passing**  
✅ Code coverage: **Maintained**

## Contributors

This major refactoring was completed in a systematic, compile-driven approach with zero runtime errors.

---

*For detailed WHY documentation, see:*
- *`GIT_MODULES_ARCHITECTURE.md` - Git module design*
- *`STATE_MODULES_ARCHITECTURE.md` - State module design*
- *`REFACTORING_WHY_GUIDE.md` - Philosophy and principles*
