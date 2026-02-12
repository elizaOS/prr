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

```text
┌─────────────────────────────────────────────────────────────┐
│                         CLI Entry                            │
│                      (src/cli.ts)                           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    Main Resolver                             │
│                   (src/resolver.ts)                         │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Orchestrates the end-to-end workflow:                │ │
│  │  • Fetch PR info & comments                           │ │
│  │  • Clone repository                                   │ │
│  │  • Analyze issues                                     │ │
│  │  │  ↓                                                  │ │
│  │  └──┬─────────────────────────────────────────────────┘ │
└────────┼───────────────────────────────────────────────────┘
         │
    ┌────┴────┬────────────┬───────────────┬──────────────┐
    ▼         ▼            ▼               ▼              ▼
┌────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│GitHub  │ │ Git Ops │ │ LLM      │ │ Runners  │ │ State    │
│  API   │ │         │ │ Client   │ │          │ │ Manager  │
└────────┘ └─────────┘ └──────────┘ └──────────┘ └──────────┘
```

## Key Subsystems

### 1. GitHub Integration (`src/github/`)

Handles all interactions with GitHub's API:
- Fetching PR information (files, comments, status)
- Posting verification comments
- Managing PR metadata

**Key files:**
- `api.ts` - GitHub API client wrapper
- `types.ts` - Type definitions for PR data

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
- `git-conflict-chunked.ts` - **NEW**: Chunked resolution for large files (>50KB)
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

### 4. Runners (`src/runners/`)

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
```text

**Runner output hygiene:** Runners return clean text in `RunResult.output`, not raw protocol frames. WHY: The Cursor runner streams JSON frames like `{"type":"text","content":"..."}`. Downstream consumers like `parseNoChangesExplanation()` search the output for patterns like `NO_CHANGES:` — raw JSON metadata caused false matches against embedded instruction text, triggering expensive re-verification of all issues.

### 5. State Management (`src/state/`)

Maintains session state across iterations:
- Verified fixes (prevents re-checking)
- Dismissed issues (skips false positives)
- Iteration history
- Runner/model rotation state
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

**Key files:**
- `state-context.ts` - State container
- `state-*.ts` - State operation modules (verification, lessons, iterations)
- `lessons-*.ts` - Lessons subsystem modules

### 6. Workflow Orchestration (`src/workflow/`)

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
- `fix-verification.ts` - Post-fix verification logic (both sequential and batch modes)
- `no-changes-verification.ts` - Handles fixer tools that make zero changes (spot-check verification, "already fixed" detection)
- `issue-analysis.ts` - Issue batching and analysis
- `graceful-shutdown.ts` - SIGINT handling
- `helpers/recovery.ts` - State recovery utilities
- `utils.ts` - `parseNoChangesExplanation()` with prompt regurgitation detection

### 7. UI & Reporting (`src/ui/`)

User-facing output and progress indicators:
- Spinners for long operations
- Progress bars for batched operations
- Timing summaries
- Token usage reports
- Model performance stats

## Data Flow

### Issue Resolution Flow

```text
1. Fetch PR comments from GitHub
   ↓
2. Pre-screen for solvability (skip deleted files, stale refs)
   ↓
3. Check if issues still exist (batch LLM call, max 50/batch)
   ↓
4. Filter out already-fixed issues (from state)
   ↓
5. For remaining issues:
   ├─ Build fix prompt with code context + lessons
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

## State Persistence

State is stored in `.prr-state.json` in the cloned repository:

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

## Configuration

Configuration comes from multiple sources (priority order):

1. **Command-line arguments** (`--model`, `--max-context`, etc.)
2. **Environment variables** (`.env` file)
3. **Defaults** (`src/constants.ts`)

Key configuration:
- `LLM_PROVIDER`: 'anthropic' | 'openai'
- `MODEL`: Specific model to use
- `MAX_CONTEXT_CHARS`: Context window size
- `MAX_STALE_CYCLES`: When to give up

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

## Performance Considerations

### Token Usage Optimization
- Batch issue checking (check 50 issues in one LLM call)
- Truncate large comments (max 2000 chars each)
- Limit code snippets (max 500 lines)
- Chunked conflict resolution (splits large files)
- **Spot-check verification**: When a fixer claims "already fixed" with no changes, sample 5 issues first. If < 40% pass, skip the full batch verification entirely. WHY: A garbled model response claiming "already fixed" triggered verification of 88 issues (2+ minutes, significant tokens). Spot-checking rejects bogus claims before committing to the expensive full pass.
- **Adaptive batch sizing**: Fewer issues per prompt when the model is struggling, reducing prompt size and cost before falling to single-issue mode

### Caching & State
- Verified fixes cached to avoid re-verification
- Dismissed issues skip analysis entirely
- Git clone is reused across iterations (unless conflicts)

### Parallelization
- Multiple issue verifications batched into single LLM call
- **Future**: Parallel chunk resolution for large files

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

**Output log tee:** Every run mirrors all console output (ANSI-stripped) to `~/.prr/output.log`. The file is truncated on each run start so it always contains only the latest session. WHY: Debugging prr often means feeding its output into another LLM for analysis. Terminal scrollback is hard to search and copy-paste loses formatting. A plain-text file can be directly referenced (`@~/.prr/output.log` in Cursor) or piped into any tool.

## Further Reading

- [Runners Documentation](./RUNNERS.md) - Deep dive into fixer tools
- [Large File Conflicts](./features/LARGE_FILE_CONFLICT_RESOLUTION.md) - Chunked resolution details
- [Development Guide](./DEVELOPMENT.md) - Contributing to PRR
