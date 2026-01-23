# PRR Developer Documentation

This document provides technical context for developers working on prr.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                           CLI (index.ts)                        │
│  - Entry point, signal handling, graceful shutdown              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       PRResolver (resolver.ts)                  │
│  - Main orchestration logic                                     │
│  - Fix loop: analyze → fix → verify → commit                    │
│  - Tool rotation and escalation strategies                      │
└─────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐    ┌───────────────────┐    ┌───────────────────┐
│  GitHub API   │    │   Fixer Runners   │    │    LLM Client     │
│  (github/)    │    │   (runners/)      │    │   (llm/client.ts) │
│               │    │                   │    │                   │
│ - PR info     │    │ - CursorRunner    │    │ - Verification    │
│ - Comments    │    │ - ClaudeCodeRunner│    │ - Issue detection │
│ - Status      │    │ - AiderRunner     │    │ - Conflict res.   │
│               │    │ - OpencodeRunner  │    │                   │
│               │    │ - CodexRunner     │    │                   │
│               │    │ - LLMAPIRunner    │    │                   │
└───────────────┘    └───────────────────┘    └───────────────────┘
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        State Management                         │
│  - StateManager (state/manager.ts) - workdir state              │
│  - LessonsManager (state/lessons.ts) - branch-permanent lessons │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

### Core
| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point, signal handlers |
| `src/cli.ts` | Argument parsing, validation |
| `src/config.ts` | Environment/config loading |
| `src/resolver.ts` | Main orchestration (1300+ lines) |
| `src/logger.ts` | Logging, timing, token tracking |

### GitHub Integration
| File | Purpose |
|------|---------|
| `src/github/api.ts` | Octokit wrapper, GraphQL queries |
| `src/github/types.ts` | PRInfo, ReviewComment, etc. |

### Git Operations
| File | Purpose |
|------|---------|
| `src/git/clone.ts` | Clone, fetch, conflict detection/resolution |
| `src/git/commit.ts` | Squash commit, push |
| `src/git/workdir.ts` | Hash-based workdir management |

### Fixer Tool Runners
| File | Purpose |
|------|---------|
| `src/runners/index.ts` | Auto-detection, rotation |
| `src/runners/cursor.ts` | Cursor Agent CLI |
| `src/runners/claude-code.ts` | Claude Code CLI |
| `src/runners/aider.ts` | Aider CLI |
| `src/runners/opencode.ts` | OpenCode CLI |
| `src/runners/codex.ts` | OpenAI Codex CLI |
| `src/runners/llm-api.ts` | Direct API (fallback) |

### LLM Verification
| File | Purpose |
|------|---------|
| `src/llm/client.ts` | Anthropic/OpenAI for verification |

### State Persistence
| File | Purpose |
|------|---------|
| `src/state/manager.ts` | Per-workdir state (iterations, verified fixes) |
| `src/state/lessons.ts` | Branch-permanent lessons (~/.prr/lessons/) |
| `src/state/types.ts` | State interfaces |

### Prompt Building
| File | Purpose |
|------|---------|
| `src/analyzer/prompt-builder.ts` | Build fix prompts with context |
| `src/analyzer/types.ts` | UnresolvedIssue, FixPrompt |

## Key Design Decisions

### 1. Two-Level Fix Loop
```
OUTER LOOP (push cycles):
  INNER LOOP (fix iterations):
    1. Analyze issues (LLM checks if still present)
    2. Build fix prompt
    3. Run fixer tool
    4. Verify fixes (LLM checks if addressed)
    5. Learn from failures
  Commit when verified
  Push if --auto-push
  Wait for re-review
```

### 2. Tool Rotation Strategy
When stuck (no progress for 2 iterations):
```
Tool A: Batch mode (all issues)
    ↓ (no progress)
Tool A: Single-issue focus mode (random 3 issues)
    ↓ (no progress)
Tool B: Batch mode
    ↓ ... repeat ...
Direct LLM API (last resort)
```

### 3. Lessons Learned System
- **File-scoped**: Lessons about `runtime.rs` only shown when fixing `runtime.rs`
- **Global**: Some lessons apply to all files
- **Branch-permanent**: Stored in `~/.prr/lessons/<owner>/<repo>/<branch>.json`
- **Deduplicated**: One lesson per `file:line`, latest wins

### 4. Code Snippet Extraction
Review comments may be attached at line X but reference code at lines Y-Z:
```
<!-- LOCATIONS START
packages/rust/src/runtime.rs#L1743-L1781
LOCATIONS END -->
```
We parse LOCATIONS from comment body to show the right code.

### 5. Conflict Resolution
```
1. Check GitHub mergeable status
2. Try git merge base branch
3. If conflicts:
   a. Lock files (bun.lock, etc.) → delete & regenerate
   b. Code files → run fixer tool
   c. Still conflicts → direct LLM API
   d. Still conflicts → abort merge, continue with review fixes
```

### 6. Session vs Overall Stats
- **Session**: Current run only (reset on start)
- **Overall**: Cumulative across all runs (persisted in state)
- Shown separately in timing/token summaries

## State Files

### Workdir State (`<workdir>/.pr-resolver-state.json`)
```json
{
  "pr": "owner/repo#123",
  "branch": "feature-branch",
  "headSha": "abc123...",
  "iterations": [...],
  "lessonsLearned": [...],  // Legacy, now uses LessonsManager
  "verifiedFixed": ["comment_id_1", ...],
  "interrupted": false,
  "interruptPhase": null,
  "totalTimings": { "Fetch PR info": 500, ... },
  "totalTokenUsage": [{ "phase": "Analyze", "inputTokens": 1000, ... }]
}
```

### Lessons Store (`~/.prr/lessons/<owner>/<repo>/<branch>.json`)
```json
{
  "owner": "elizaOS",
  "repo": "eliza",
  "branch": "feature-branch",
  "global": ["Fixer tool made no changes..."],
  "files": {
    "src/runtime.rs": ["Fix for runtime.rs:1743 rejected: ..."]
  }
}
```

## Security Considerations

### Shell Injection Prevention
- `--model` validated against `/^[A-Za-z0-9._-]+$/`
- All runners use `spawn(binary, args)` not `sh -c "..."`
- Prompts passed via file read, not shell interpolation

### Secrets
- API keys only from environment variables
- Never logged or included in prompts
- `.env` in `.gitignore`

## Development Setup

```bash
# Install dependencies
bun install

# Build
bun run build

# Run locally
bun dist/index.js https://github.com/owner/repo/pull/123

# Or link globally
bun link
prr --help
```

## Testing Tips

```bash
# Dry run (no changes)
prr <pr-url> --dry-run

# No commit (changes in workdir only)
prr <pr-url> --no-commit --keep-workdir

# Verbose output
prr <pr-url> --verbose

# Specific tool
prr <pr-url> --tool cursor --model claude-4-opus-thinking

# Disable batching (debug LLM calls)
prr <pr-url> --no-batch

# Inspect workdir
ls ~/.prr/work/

# Inspect lessons
cat ~/.prr/lessons/<owner>/<repo>/<branch>.json
```

## Common Issues

### Cursor Agent Not Found
```bash
# Check if installed
which cursor-agent

# Install
curl https://cursor.com/install -fsS | bash

# Login (required before first use)
cursor-agent login
```

### Lessons Flooding Context
If you see 50+ lessons, check:
1. Are they deduplicated? (should be one per file:line)
2. Is the LLM flip-flopping on fixes?
3. Consider clearing: `rm ~/.prr/lessons/<owner>/<repo>/<branch>.json`

### Merge Conflicts Won't Resolve
If conflicts persist after all attempts:
1. prr aborts the merge and continues with review fixes
2. Human must resolve base branch conflicts manually
3. Check `git status` in workdir for conflict markers

## Adding a New Runner

1. Create `src/runners/<name>.ts`:
```typescript
export class MyRunner implements Runner {
  name = 'myrunner';
  displayName = 'My Runner';
  
  async isAvailable(): Promise<boolean> { ... }
  async checkStatus(): Promise<RunnerStatus> { ... }
  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> { ... }
}
```

2. Add to `src/runners/index.ts`:
```typescript
import { MyRunner } from './myrunner.js';
export const ALL_RUNNERS: Runner[] = [
  // ... existing runners ...
  new MyRunner(),
];
```

3. Update `src/config.ts` FixerTool type if needed

## Token/Cost Tracking

Tokens are tracked per phase:
- `Analyze issues` - checking if issues still exist
- `Verify fixes` - checking if diffs address issues  
- `Resolve conflicts` - direct LLM conflict resolution
- `Direct LLM fix` - fallback fixer

Cost estimate uses rough rates:
- Input: ~$3/M tokens
- Output: ~$15/M tokens

## Graceful Shutdown

On Ctrl+C (SIGINT):
1. `resolver.gracefulShutdown()` called
2. State saved with `interrupted: true`, `interruptPhase: "fixing"`
3. Timing/token summaries printed
4. Exit with signal-specific code (130 for SIGINT)

On resume:
1. `wasInterrupted()` returns true
2. Can skip re-analysis of already-verified fixes
3. Caller must call `clearInterrupted()` after handling
