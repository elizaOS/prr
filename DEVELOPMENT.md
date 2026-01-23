# PRR Developer Documentation

This document provides technical context for developers working on prr.

## Design Philosophy

prr is designed around **human-in-the-loop** automation, not full autonomy:

1. **Human initiates**: User explicitly runs prr on a specific PR
2. **Human can interrupt**: Ctrl+C at any time, state is preserved
3. **Human can inspect**: Workdir persists, user can examine/modify files
4. **Human decides when done**: Even with `--auto-push`, user can stop anytime

This contrasts with fully autonomous agents that create PRs without human involvement. prr assumes a human made the PR, received review feedback, and wants help addressing it - not a replacement for the human developer.

**Technical implications**:
- State persistence is critical (resume after interruption)
- Workdir preservation by default (inspect before pushing)
- Verbose logging (understand what's happening)
- No silent failures (human needs to know)

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
  FINAL AUDIT (adversarial re-check of ALL issues)
  Commit when audit passes
  Push if --auto-push
  Wait for re-review
```

**Why two loops?** The inner loop fixes issues quickly. The outer loop handles the reality that bot reviewers may add NEW comments after you push. Auto-push mode keeps going until the PR is clean.

### 2. Verification System

**The Problem**: How do we know an issue is actually fixed?

**Naive approach**: Trust the fixer tool. *Why bad*: Tools make changes that don't address the actual issue.

**Better approach**: LLM verification after each fix. *Why still problematic*: 
- Single LLM call can be wrong (false positives)
- Verification is cached forever - stale entries persist
- Lenient prompts lead to "looks good to me" without evidence

**Our solution**: Multi-layer verification with final audit:

```
Layer 1: Initial verification (per fix)
  └─ "Does this diff address the concern?" 
  └─ Results cached with timestamp/iteration for expiry
  
Layer 2: New comment check (before audit)
  └─ Fetch latest comments from GitHub
  └─ Compare against known comments
  └─ WHY: Bot reviewers might add new issues during fix cycle
  
Layer 3: Final audit (before declaring done)
  └─ Clear ALL cached verifications first
  └─ Re-check EVERY issue with stricter prompt
  └─ Adversarial: "Find issues NOT properly fixed"
  └─ Requires citing specific code evidence
  └─ Only audit results determine what's "fixed"
  └─ If audit fails: re-enter fix loop (don't exit!)
```

**Why clear cache before audit?** Prevents stale false positives from surviving. If an issue was wrongly marked "fixed" 10 iterations ago, the audit catches it.

**Why adversarial prompt?** Regular verification asks "is this fixed?" - LLMs tend toward yes. Adversarial asks "find what's NOT fixed" - catches more issues.

**Why check for new comments?** If we don't, we might push code that has new unresolved issues. The new comment check ensures we don't declare victory prematurely.

**Why re-enter fix loop on audit failure?** Early versions would exit after printing failed audit results. Now we populate unresolvedIssues and continue fixing.

### 3. Model & Tool Rotation

**The Problem**: AI tools get stuck. They'll make the same mistake repeatedly.

**Solution**: Rotate through different models and tools with family interleaving:

```
Model rotation (interleaved by family):
  Round 1: sonnet-4.5 (Claude) → gpt-5.2 (GPT) → gemini-3-pro (Gemini)
  Round 2: opus-4.5 (Claude) → gpt-5.2-high (GPT) → gemini-3-flash (Gemini)
  
Tool rotation (after MAX_MODELS_PER_TOOL_ROUND models tried):
  Cursor → Claude Code → Aider → Direct LLM API
  (then back to Cursor with next model in rotation)

Strategy per failure:
  1st fail: Rotate to next model (different family)
  2nd fail: Rotate to next model (different family again)
  After MAX_MODELS_PER_TOOL_ROUND: Switch tool, reset that tool's model index
  All tools exhausted all models: Reset all indices, start fresh round
```

**Why interleave model families?** Same-family models fail the same way:
- If Claude Sonnet can't fix it, Claude Opus probably can't either
- But GPT might have a completely different approach
- Interleaving gives each attempt a "fresh perspective"

**Why MAX_MODELS_PER_TOOL_ROUND (default 2)?** 
- Prevents getting stuck cycling through all Cursor models
- Forces tool rotation earlier for better coverage
- Each tool tries 2 models before we switch tools

**Why dynamic model discovery for Cursor?**
- Model lists change frequently (new releases, deprecations)
- Running `cursor-agent models` gives authoritative list
- Prioritization logic selects diverse, capable models
- Fallback to hardcoded list if discovery fails

**State persistence**: Tool index and per-tool model indices saved to state file. Resuming continues from same position instead of restarting rotation.

### 4. Lessons Learned System

**The Problem**: Fixer tools flip-flop. Attempt #1 adds a try/catch. Verification rejects it. Attempt #2 adds the same try/catch. Loop forever.

**Solution**: Record what didn't work, analyze failures with LLM, and include in future prompts:

```
Lessons store: ~/.prr/lessons/<owner>/<repo>/<branch>.json
{
  "global": [],
  "files": {
    "src/auth.ts": ["Fix rejected: try/catch doesn't handle the edge case - need early return"],
    "src/api.ts:45": ["Validation must preserve backward compatibility - don't change function signature"]
  }
}
```

**Why LLM-analyzed lessons?** Generic "tool failed" messages aren't actionable:
- BAD: "cursor failed: Process exited with code 1"
- GOOD: "Fix rejected: The null check was added but doesn't cover the undefined case mentioned in review"

The LLM analyzes: original issue + attempted diff + rejection reason → actionable guidance.

**Why prune stale lessons?** Transient failures pollute the lessons store:
- "Connection stalled" - not actionable, will retry
- "Cannot use this model" - transient config issue
- "Process exited with code X" - doesn't help future attempts

On startup, `pruneStaleLessons()` removes these patterns.

**Why file-scoped?** Lessons about `auth.ts` aren't relevant when fixing `api.ts`. Reduces prompt noise.

**Why branch-permanent?** Issues recur when you resume work. Lessons survive across runs.

**Why deduplicated?** One lesson per `file:line`. If we learn something new about line 45, it replaces the old lesson.

### 5. Context Size Management

**The Problem**: LLMs have context limits. 36 review comments × 3KB each = 108KB prompt. Too big.

**Solution**: Dynamic batching based on actual content size:

```typescript
// Default: 400k chars (~100k tokens)
// Fills batches until limit reached
for (const issue of issues) {
  const issueSize = buildIssueText(issue).length;
  if (currentSize + issueSize > maxContextChars) {
    batches.push(currentBatch);
    currentBatch = [];
  }
  currentBatch.push(issue);
  currentSize += issueSize;
}
```

**Why dynamic?** Fixed batch sizes waste context (small issues) or overflow (large issues). Dynamic batching is efficient.

**Why 400k default?** Claude 4.5 handles 200k tokens. 400k chars ≈ 100k tokens. Leaves room for response.

**Why configurable?** Smaller models need smaller batches. `--max-context 100000` for GPT-4 class.

### 6. Code Snippet Extraction

**The Problem**: Review comment is attached at line 50, but the issue is about lines 100-150.

**Solution**: Parse LOCATIONS metadata from comment body:

```markdown
<!-- LOCATIONS START
packages/rust/src/runtime.rs#L100-L150
LOCATIONS END -->
```

**Why?** Bot reviewers (CodeRabbit, etc.) attach comments at convenient lines but reference code elsewhere. We need the actual code to verify fixes.

### 7. Git Authentication

Token is embedded in the HTTPS remote URL for authentication:
```
https://TOKEN@github.com/owner/repo.git
```

This is stored in `.git/config` within the workdir. We accept this tradeoff because:
- Workdirs are local-only (`~/.prr/work/`)
- Not committed to any repository
- Simpler than SSH key setup or credential helpers
- User controls their own machine security

### 8. Auto-Stashing for Interrupted Runs

**The Problem**: User interrupts prr (Ctrl+C). Local changes exist but aren't committed. Next run does `git pull` which fails: "Your local changes would be overwritten".

**Solution**: Auto-stash before pull, auto-pop after:

```typescript
// Before pull
if (!status.isClean()) {
  await git.stash(['save', 'prr-auto-stash-before-pull']);
  stashed = true;
}

// Pull
await git.pull('origin', branch);

// After pull (if we stashed)
if (stashed) {
  await git.stash(['pop']);  // Restore changes
}
```

**Why not just fail?** User experience. Interruptions happen. prr should handle them gracefully.

**Why stash instead of commit?** Changes might not be ready to commit. They might be work-in-progress that would fail verification.

**What about stash conflicts?** If `stash pop` conflicts, we return with `stashConflicts` list. The caller can handle this (show warning, continue without changes, etc.).

### 8. Lock File Conflict Resolution

**The Problem**: `bun.lock`, `package-lock.json`, etc. conflict on merge. LLM can't fix them properly.

**Solution**: Delete and regenerate:

```
1. Detect lock file conflicts
2. Delete the lock files
3. Run package manager install (bun install, npm install, etc.)
4. Stage regenerated files
5. Continue merge
```

**Why delete/regenerate?** Lock files are auto-generated. Merging them manually is error-prone. Fresh generation is reliable.

**Why whitelist commands?** Security. Only run known-safe commands (bun install, npm install, etc.), not arbitrary shell.

### 9. Commit Message Generation

**The Problem**: Early versions produced commit messages like:
```
fix: address review comments

Issues addressed:
- src/cli.ts: _⚠️ Potential issue_ | _🔴 Critical_
<details><summary>...
```

This is awful for git history. Commit messages are permanent and should describe WHAT changed.

**Solution**: LLM-generated commit messages with strict rules:

```typescript
// Prompt includes:
// 1. Conventional commit format requirement
// 2. Focus on ACTUAL CODE CHANGES
// 3. FORBIDDEN PHRASES list (explicit)

const forbiddenPatterns = [
  /address(ed|ing)?\s+(review\s+)?comments?/i,
  /address(ed|ing)?\s+feedback/i,
  /based on\s+(review|feedback)/i,
  // ... more
];

// Check output, fallback if forbidden phrase detected
if (hasForbidden) {
  return `fix(${mainFile}): improve implementation based on code review`;
}
```

**Why forbidden phrases?** LLMs default to "address review comments" - it's the most likely completion. We must explicitly forbid it.

**Why file-based fallback?** If forbidden phrase detected, we generate from file names. At least it mentions WHAT files changed.

**Why not just tell the LLM to avoid it?** We do! But LLMs don't always follow instructions. The fallback catches failures.

## State Files

### Workdir State (`<workdir>/.pr-resolver-state.json`)
```json
{
  "pr": "owner/repo#123",
  "branch": "feature-branch",
  "headSha": "abc123...",
  "iterations": [...],
  "lessonsLearned": [...],  // Legacy, now uses LessonsManager
  "verifiedFixed": ["comment_id_1", ...],  // Legacy string array
  "verifiedComments": [  // NEW: detailed verification with timestamps
    {
      "commentId": "comment_id_1",
      "verifiedAt": "2026-01-23T10:30:00Z",
      "verifiedAtIteration": 5,
      "passed": true,
      "reason": "The null check was added at line 45"
    }
  ],
  "currentRunnerIndex": 0,     // NEW: tool rotation position
  "modelIndices": {            // NEW: per-tool model rotation position
    "cursor": 2,
    "llm-api": 0
  },
  "interrupted": false,
  "interruptPhase": null,
  "totalTimings": { "Fetch PR info": 500, ... },
  "totalTokenUsage": [{ "phase": "Analyze", "inputTokens": 1000, ... }]
}
```

**Why `verifiedComments` with timestamps?** Enables verification expiry. If a verification is N iterations old, re-check it.

**Why `currentRunnerIndex` and `modelIndices`?** Resume rotation from where we left off. Without this, every restart begins with the same tool/model.

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

## CLI Implementation Notes

### Commander.js `--no-*` Options

**The Problem**: Commander.js handles `--no-X` options specially. They don't create `opts.noX`, they create `opts.X` with inverted boolean.

```typescript
// WRONG - this doesn't exist!
const noCommit = opts.noCommit;  // undefined

// RIGHT - Commander sets opts.commit to false when --no-commit is passed
const noCommit = !opts.commit;   // true when --no-commit passed, false otherwise
```

**Why this matters**: We had a bug where `--no-commit` was ignored because we were reading the wrong property.

**Pattern for all `--no-*` options**:
```typescript
.option('--no-commit', 'Make changes but do not commit')
// In parseArgs:
noCommit: !opts.commit,  // --no-commit -> opts.commit=false -> noCommit=true
```

## Security Considerations

### Shell Injection Prevention
- `--model` validated against `/^[A-Za-z0-9._\/-]+$/`
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

### False Positives (issues marked fixed but aren't)
**Symptoms**: prr says "All issues resolved!" but review comments aren't actually addressed.

**Causes**:
1. Stale verification cache from previous runs
2. Final audit parsing failed (check logs for `parsed: 0`)
3. Code snippet didn't include the relevant lines

**Fixes**:
```bash
# Force re-verification of all cached issues
prr <url> --reverify

# Clear state and start fresh
rm ~/.prr/work/<hash>/.pr-resolver-state.json
prr <url>

# Check what's in the cache
cat ~/.prr/work/<hash>/.pr-resolver-state.json | jq '.verifiedFixed'
```

### False Negatives (issues marked unresolved but are fixed)
**Symptoms**: prr keeps trying to fix things that are already correct.

**Causes**:
1. Code snippet too small - LLM doesn't see the fix
2. Strict verification prompt - LLM can't find "evidence"
3. Review comment is vague - LLM doesn't know what to look for

**Fixes**:
```bash
# Check what the verification LLM sees
prr <url> --verbose --no-batch

# The logs will show each issue and the code snippet provided
```

### Final Audit Parsing Failures
**Symptoms**: Log shows `Final audit results → { total: 36, parsed: 0, unfixed: 0 }`

**Why this is bad**: `parsed: 0` means no audit responses were parsed. The fail-safe kicks in and marks all unparsed issues as UNFIXED.

**Causes**:
1. LLM didn't follow the `[1] FIXED:` format
2. Response was truncated
3. Model confusion from too-large batch

**Fixes**:
```bash
# Reduce batch size
prr <url> --max-context 100000

# Check the raw LLM response (verbose mode)
prr <url> --verbose
```

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
