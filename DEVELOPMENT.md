# PRR Developer Documentation

This document provides technical context for developers working on prr.

## Design Philosophy

prr is designed around **human-in-the-loop** automation, not full autonomy:

1. **Human initiates**: User explicitly runs prr on a specific PR
2. **Human can interrupt**: Ctrl+C at any time, state is preserved
3. **Human can inspect**: Workdir persists, user can examine/modify files
4. **Human decides when done**: Even with `--auto-push`, user can stop anytime

This contrasts with fully autonomous agents that create PRs without human involvement. prr assumes a human made the PR, received review feedback, and wants help addressing it - not a replacement for the human developer.

**Why human-in-the-loop drives the design:** When the human can interrupt (Ctrl+C), inspect the workdir, and decide when to push, the system must persist state, avoid silent failures, and keep the workdir usable. That’s why we save state on signal, close logs before exit, and never assume the process runs to completion.

**Technical implications**:
- State persistence is critical (resume after interruption)
- Workdir preservation by default (inspect before pushing)
- Verbose logging (understand what's happening)
- No silent failures (human needs to know)

## Architecture Overview

```text
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
│               │    │ - GeminiRunner    │    │                   │
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

Paths below are relative to the repo root. PRR-specific code lives under `tools/prr/`; shared modules (logger, git) under `shared/` (pill-output.md #8).

### Core


| File | Purpose |
|------|---------|
| `tools/prr/index.ts` | CLI entry point, signal handlers |
| `tools/prr/cli.ts` | Argument parsing, validation |
| `shared/config.ts` | Environment/config loading |
| `tools/prr/resolver.ts` | Main orchestration (delegates to workflow/) |
| `shared/logger.ts` | Logging, timing, token tracking |


### GitHub Integration


| File | Purpose |
|------|---------|
| `tools/prr/github/api.ts` | Octokit wrapper, GraphQL queries |
| `tools/prr/github/types.ts` | PRInfo, ReviewComment, etc. |


### Git Operations


| File | Purpose |
|------|---------|
| `shared/git/git-clone-index.ts` (+ core, pull, merge, etc.) | Clone, fetch, conflict detection, pullLatest with auto-rebase |
| `shared/git/commit.ts` | Squash commit, push with retry, token injection |
| `shared/git/workdir.ts` | Hash-based workdir management |


### Fixer Tool Runners


| File | Purpose |
|------|---------|
| `shared/runners/detect.ts` | Auto-detection, rotation |
| `shared/runners/cursor.ts` | Cursor Agent CLI |
| `shared/runners/claude-code.ts` | Claude Code CLI |
| `shared/runners/aider.ts` | Aider CLI |
| `shared/runners/opencode.ts` | OpenCode CLI |
| `shared/runners/codex.ts` | OpenAI Codex CLI |
| `shared/runners/gemini.ts` | Google Gemini CLI |
| `shared/runners/llm-api.ts` | Direct API (fallback) |


### LLM Verification


| File | Purpose |
|------|---------|
| `tools/prr/llm/client.ts` | Anthropic/OpenAI for verification |


### State Persistence


| File | Purpose |
|------|---------|
| `tools/prr/state/state-*.ts` | Per-workdir state modules (verification, iterations, rotation, bail-out) |
| `tools/prr/state/lessons-*.ts` | Branch-permanent lessons (~/.prr/lessons/) |
| `tools/prr/state/types.ts` | State interfaces (ResolverState, BailOutRecord, ModelPerformance) |


### Prompt Building


| File | Purpose |
|------|---------|
| `tools/prr/analyzer/prompt-builder.ts` | Build fix prompts with context |
| `tools/prr/analyzer/types.ts` | UnresolvedIssue, FixPrompt |

## Key Design Decisions

### 1. Two-Level Fix Loop with Bail-Out
```text
OUTER LOOP (push cycles):
  INNER LOOP (fix iterations):
    1. Analyze issues (LLM checks if still present)
    2. Build fix prompt
    3. Run fixer tool
    4. Verify fixes (LLM checks if addressed)
    5. Learn from failures
    6. Track progress: progressThisCycle += verifiedCount
    7. If no progress: rotate model/tool
    8. If cycle complete with zero progress: noProgressCycles++
    9. If noProgressCycles >= maxStaleCycles: BAIL OUT
  FINAL AUDIT (adversarial re-check of ALL issues)
  Commit when audit passes (or partial progress on bail-out)
  Push if --auto-push
  Wait for re-review
```

**Why two loops?** The inner loop fixes issues quickly. The outer loop handles the reality that bot reviewers may add NEW comments after you push. Auto-push mode keeps going until the PR is clean.

**Why bail-out in inner loop?** We want to commit/push partial progress even if some issues couldn't be fixed. Without bail-out, the inner loop would run forever on stubborn issues.

### 2. Verification System

**The Problem**: How do we know an issue is actually fixed?

**Naive approach**: Trust the fixer tool. *Why bad*: Tools make changes that don't address the actual issue.

**Better approach**: LLM verification after each fix. *Why still problematic*: 
- Single LLM call can be wrong (false positives)
- Verification is cached forever - stale entries persist
- Lenient prompts lead to "looks good to me" without evidence

**Why not trust GitHub's `isResolved` status?**
- GitHub marks threads as "outdated" when file changes, NOT "fixed"
- Humans mark resolved without verifying the fix
- Bot reviewers (CodeRabbit) don't always update status after PR updates
- We need ground truth: "Is the issue ACTUALLY addressed in the code?"

**Our solution**: Multi-layer verification with final audit:

```text
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

**Verification Cache Design** (`verifiedComments` in state):

```typescript
// WHY: Store WHEN verification happened, not just that it happened
// Enables expiry logic and re-verification after many iterations
{
  commentId: "comment_id_1",
  verifiedAt: "2026-01-23T10:30:00Z",
  verifiedAtIteration: 5
}
```

**Why iteration number in cache?**
- If 20 iterations passed since verification, code may have changed
- `findUnresolvedIssues` can check staleness: `currentIteration - verifiedAtIteration > threshold`
- Stale verifications get re-checked instead of blindly trusted
- `--reverify` flag forces re-verification of ALL cached items

### 3. System communication (handoffs)

Data flows between subsystems so the next step has the right context. Improving these handoffs reduces fixer/verifier stalemates and "no access to code" failures.

**Analyzer → Fixer**

- **Input:** Review comments + workdir. Solvability (sync) filters impossible issues; batch check (LLM) returns which still exist.
- **Output:** `UnresolvedIssue[]` with `codeSnippet` (current code at comment path/line), `explanation` (analysis), and optional `retargetedLine` when the cited line is out of range.
- **Handoff:** Fix prompt builder (`prompt-builder.ts`, `utils.buildSingleIssuePrompt`) receives these issues and injects **Current Code** and **Analysis** so the fixer sees the same code the analyzer saw. Snippets are refreshed after verify for changed files (`recheckSolvability`) so the next iteration shows post-fix state.

**Verifier → Fixer**

- **Input:** After the fixer runs, verification (batch or single) gets the **current diff** and answers YES/NO + explanation (and optional LESSON for batch).
- **Output:** For each NO we set `issue.verifierContradiction = explanation` (and lesson if present). This is persisted on the issue object for the rest of the session.
- **Handoff:** The next fix prompt (batch and single-issue) includes a **VERIFIER DISAGREES** block with that text and instructs: "Treat the verifier's explanation as the source of truth for what is still missing or wrong." Batch verify prompt explicitly says the NO explanation is "used as the source of truth for the next fix attempt" and must cite code/method/line.

**Lessons → Fixer**

- Failed verifications (and some no-changes results) add file-scoped or global lessons. Fix prompt builder injects **per-file lessons** inline with each issue (not only at the top) so the fixer sees them next to the code they apply to.

**No-changes re-check → Fixer**

- When the fixer claims "already fixed" but made no edits, we re-verify with the LLM. If the re-check says "still exists", we set `issue.verifierContradiction` so the next iteration sees the verifier's view and can try again (or rotate).

**Dismissal comments (review → LLM → file)**

- We pass **effectiveLine** (clamped to file length), **surroundingCode** (snippet with line numbers), review comment, and dismissal reason so the LLM has the code in the prompt. Prompt states "The code is provided above" and requires response format `EXISTING` or `COMMENT: Review: ...` only. Insertion uses the same effective line so we never ask the LLM about a line we don't show or insert past end of file.

**Where to change behavior**

- Verifier → Fixer: `fix-verification.ts` (sets `verifierContradiction`), `prompt-builder.ts` and `workflow/utils.ts` (VERIFIER DISAGREES block).
- Analyzer → Fixer: `issue-analysis.ts` (builds issues with snippets), `fix-loop-utils.ts` / `recheckSolvability` (refresh after verify). When refreshing snippets, `recheckSolvability` preserves `verifierContradiction` via `{ ...issue, codeSnippet }` so the next fix prompt and AAR see it.
- AAR "Verifier said": `push-iteration-loop.ts` sets `finalUnresolvedIssuesRef.current` from the same issue refs (so `verifierContradiction` is preserved); `final-cleanup.ts` passes them to `printAfterActionReport`. See `docs/audit-run-2026-02-22.md` (Actions executed).
- Dismissal: `workflow/dismissal-comments.ts` (effectiveLine, surroundingCode), `llm/client.ts` (`generateDismissalComment` prompt).

### 4. Model & Tool Rotation with Single-Issue Focus

**The Problem**: AI tools get stuck. They'll make the same mistake repeatedly.

**Solution**: Multi-layer escalation strategy with model rotation, tool rotation, and single-issue focus:

```text
Escalation on consecutive failures:
  1st fail (odd):  Try SINGLE-ISSUE MODE with current tool/model
  2nd fail (even): Rotate to NEXT MODEL (different family)
  3rd fail (odd):  Try single-issue with new model
  4th fail (even): Rotate tool after MAX_MODELS_PER_TOOL_ROUND
  ... continue until all tools/models exhausted ...
  Final: Direct LLM API as last resort
```

**Single-Issue Focus Mode** (`trySingleIssueFix`):

```typescript
// WHY: Batch prompts with 10+ issues can overwhelm the LLM
// WHY: Randomize to avoid hammering the same hard issue repeatedly
const shuffled = [...issues].sort(() => Math.random() - 0.5);
const toTry = shuffled.slice(0, 3);  // Try up to 3 random issues

for (const issue of toTry) {
  const prompt = buildSingleIssuePrompt(issue);  // Focused context
  const result = await runner.run(workdir, prompt);
  // ... verify and track ...
}
```

**WHY single-issue mode?**
- Batch prompts can exceed context or confuse LLMs
- Single issue = smaller context = faster, cheaper
- LLM can focus without distraction from other issues
- If one issue is genuinely hard, others might be easy

**WHY randomize?**
- Prevents hammering the same "first" issue over and over
- Hard issues get naturally skipped sometimes
- Easy issues get more chances to be fixed
- Observed: same issue failing 10+ times in a row without randomization

**Model rotation** (interleaved by family):

```text
Model rotation (interleaved by family):
  Round 1: claude-4-sonnet-thinking (Claude) → gpt-5.2 (GPT) → o3 (OpenAI)
  Round 2: claude-4-opus-thinking (Claude) → gpt-5.2-high (GPT) → gemini-3-flash (Gemini)
  
Tool rotation (after MAX_MODELS_PER_TOOL_ROUND models tried):
  Cursor → Claude Code → Aider → OpenCode → Codex → Gemini → Junie → Goose → OpenHands → Direct LLM API
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

### 5. Adaptive Batch Sizing

**The Problem**: The first iteration stuffed 50 issues into a single 213K-char prompt. The model fixed 5 (5% success). Iterations 2-3 sent the same 50-issue prompt and fixed 0 — the model was overwhelmed.

**Why not just reduce `MAX_ISSUES_PER_PROMPT`?** Fixed reduction wastes capacity on easy runs. With 10 simple issues, a small batch size means unnecessary iterations.

**Solution**: Halve the batch size after each consecutive zero-fix iteration:

```typescript
// src/analyzer/prompt-builder.ts
export function computeEffectiveBatchSize(consecutiveZeroFixIterations: number): number {
  if (consecutiveZeroFixIterations <= 0) return MAX_ISSUES_PER_PROMPT;  // 50
  const reduced = Math.floor(MAX_ISSUES_PER_PROMPT / Math.pow(2, consecutiveZeroFixIterations));
  return Math.max(MIN_ISSUES_PER_PROMPT, reduced);  // Floor: 5
}
// Iteration 1: 50 issues → 5 fixed → reset
// Iteration 2: 50 issues → 0 fixed → next time use 25
// Iteration 3: 25 issues → 0 fixed → next time use 12
// Iteration 4: 12 issues → 0 fixed → next time use 6
// Iteration 5: 6 issues → 0 fixed → next time use 5 (minimum)
```

**Why halve (exponential backoff)?** Linear reduction (50 → 49 → 48...) is too slow. Halving matches the severity — if 50 issues produced zero fixes, there's no reason to believe 49 will be better. Get to smaller batches quickly.

**Why MIN_ISSUES_PER_PROMPT = 5?** Below 5, single-issue focus mode is more efficient (it also includes focused context per issue). The adaptive sizing bridges the gap between "try everything" and "try one thing at a time."

**Where the counter resets**: Any iteration with verified fixes resets `consecutiveFailures` to 0, bringing batch size back to MAX. WHY: The model might have been overwhelmed by a specific mix of hard issues; after resolving some, the remaining set may be tractable at full batch size.

### 4a. Issue Priority Triage

**The Problem**: When adaptive batching limits prompts to 50 of 93 issues, the selection was arbitrary — trivial style nits could crowd out critical security fixes. All 93 issues had equal priority (essentially random GitHub thread creation order).

// Review: prioritizes issue urgency over age, ensuring critical fixes are addressed first
**Why not just process chronologically?** Older comments aren't necessarily more important. A critical security issue added yesterday should be fixed before a 2-week-old style nit.

**Solution**: LLM-based importance and difficulty assessment during the existing analysis phase:

```typescript
// src/llm/client.ts - Extended response format
// OLD: ISSUE_ID: YES|NO|STALE: explanation
// NEW: ISSUE_ID: YES|NO|STALE: I<1-5>: D<1-5>: explanation

// Prompt addition:
For issues that still exist (YES), also rate:
- I<1-5> importance: 1=critical security/data loss, 2=major bug, 3=moderate, 4=minor, 5=trivial style
- D<1-5> difficulty: 1=one-line fix, 2=simple, 3=moderate, 4=complex multi-file, 5=major refactor

For NO/STALE responses, you may omit the I/D ratings (they won't be used).

// Parser - two-stage with graceful defaults:
const match = line.match(/^([^:]+):\s*(YES|NO|STALE):\s*(.*)$/i);
if (match) {
  let [, id, response, rest] = match;
  let importance = 3, ease = 3;  // Graceful defaults
  const triageMatch = rest.match(/^I(\d):\s*D(\d):\s*(.*)$/i);
  if (triageMatch) {
    importance = Math.min(5, Math.max(1, parseInt(triageMatch[1], 10)));
    ease = Math.min(5, Math.max(1, parseInt(triageMatch[2], 10)));
    rest = triageMatch[3];
  }
  // ... store with importance/ease
}
```

**Why piggyback onto existing analysis call?** The LLM already reads every comment to judge "does this still exist?". Asking for two additional numbers costs essentially nothing (same context, ~5 extra tokens per issue in response).

**Why graceful defaults (3/3)?** 
- LLM may omit ratings for NO/STALE responses (they won't be used anyway)
- Old-format responses still parse correctly (backwards compatible)
- Default to middle of pack (3), not worst (5) — issues without triage aren't necessarily trivial

**Why clamp to 1-5?** LLMs sometimes output 0 or 6. Clamping ensures scores stay in range.

**Data flow** (11 construction sites):

```typescript
// src/analyzer/types.ts
export interface IssueTriage {
  importance: number;  // 1-5
  ease: number;        // 1-5
}

export interface UnresolvedIssue {
  comment: ReviewComment;
  codeSnippet: string;
  stillExists: boolean;
  explanation: string;
  triage?: IssueTriage;  // Optional - see WHY below
}
```

**Why `triage?` optional?** There are 11 places that construct `UnresolvedIssue` objects across 5 files. Making it required would break all of them simultaneously during implementation. Optional means:
- Type system accepts objects without triage
- Can add triage incrementally, one site at a time
- Recovery paths (audit failures, new mid-cycle comments) can use default values

**11 construction sites and their triage strategy**:

| File | Sites | Triage Source |
|------|-------|---------------|
| `workflow/issue-analysis.ts` | 7 | LLM result map (batch mode) or default `{3,3}` (sequential mode) |
| `workflow/main-loop-setup.ts` | 1 | `{2,3}` — audit failures are important (fooled verifier) |
| `workflow/fix-loop-utils.ts` | 2 | `{3,3}` — new comments, re-added (not yet analyzed) |
| `workflow/analysis.ts` | 1 | `{3,3}` — new comment mid-cycle |

**NOT** `llm/client.ts` audit site (~line 942): That constructs audit result objects `{ stillExists, explanation }`, NOT `UnresolvedIssue` — different type.

**Sorting** (`src/analyzer/severity.ts`):

```typescript
export type PriorityOrder =
  | 'important'      // Most important first (1=critical first)
  | 'important-asc'  // Least important first (5=trivial first)
  | 'easy'           // Easiest fixes first (1=one-liner first)
  | 'easy-asc'       // Hardest fixes first (5=refactor first)
  | 'newest'         // Newest comments first
  | 'oldest'         // Oldest comments first (GitHub default)
  | 'none';          // No sorting (preserve input order)

export function sortByPriority(issues: UnresolvedIssue[], order: PriorityOrder): UnresolvedIssue[] {
  if (order === 'none') return issues;
  const sorted = [...issues];  // NEVER mutate input
  sorted.sort((a, b) => {
    switch (order) {
      case 'important':
        return (a.triage?.importance ?? 3) - (b.triage?.importance ?? 3);
      // ... other cases
    }
  });
  return sorted;
}
```

**Why return new array (non-mutating)?** The `unresolvedIssues` array is shared state used by:
- Fix iteration loop
- No-changes verification
- Single-issue focus mode (which intentionally randomizes)

If we mutated, single-issue randomization and priority sort would fight each other on alternate iterations. Returning a new array means each consumer gets its own ordering.

**Where sorting happens** (`src/workflow/prompt-building.ts`):

```typescript
// WHY sort here, not in issue-analysis:
// Same unresolvedIssues array shared with single-issue mode (randomizes)
// and no-changes verification. Sorting at prompt boundary means we pick
// the best issues for the batch without affecting other consumers.
const sortedIssues = sortByPriority(unresolvedIssues, priorityOrder);
const { prompt, detailedSummary } = buildPrompt(sortedIssues, lessons, { maxIssues: effectiveMax });
```

**Triage labels in prompts** (`src/analyzer/prompt-builder.ts`):

```typescript
// WHY tell the fixer: The model should know which issues are critical
// (need careful handling) vs trivial style nits (can get quick fixes)
const triageLabel = issue.triage
  ? ` [importance:${issue.triage.importance}/5, difficulty:${issue.triage.ease}/5]`
  : '';
parts.push(`### Issue ${i + 1}: ${issue.comment.path}${triageLabel}\n`);
```

**Console display** (`src/workflow/prompt-building.ts`):

```typescript
// Console shows breakdown:
// "Priority: 8 critical/major, 22 moderate, 12 minor/trivial (sorted: critical first)"
const critical = triaged.filter(i => i.triage!.importance <= 2).length;
const moderate = triaged.filter(i => i.triage!.importance === 3).length;
const minor = triaged.filter(i => i.triage!.importance >= 4).length;
```

**Per-batch debug logging** (`src/llm/client.ts`):

```typescript
// Added to existing per-batch summary:
const avgImportance = countTriage > 0 ? (sumImportance / countTriage).toFixed(1) : 'N/A';
const avgEase = countTriage > 0 ? (sumEase / countTriage).toFixed(1) : 'N/A';
debug(`Batch ${batchIdx + 1}/${batches.length} results`, {
  parsed, expected, stillExists, alreadyFixed, stale, unparsed,
  avgImportance, avgEase  // NEW
});
```

**Strategy comparison**:

| Order | Use Case | Example |
|-------|----------|---------|
| `important` (default) | Tackle critical issues first | Security fixes before style nits |
| `easy` | Quick wins first | Show progress, build confidence |
| `newest` | Address recent feedback | Show responsiveness to reviewers |
| `oldest` | FIFO queue | GitHub's default behavior |
| `none` | Debug/comparison | Preserve original behavior |

**Why default to `important`?** Critical security issues should be fixed before trivial style nits. The fixer has limited context window and iteration budget — spend it on what matters most.

### 4b. Lessons Learned System

**The Problem**: Fixer tools flip-flop. Attempt #1 adds a try/catch. Verification rejects it. Attempt #2 adds the same try/catch. Loop forever.

**Solution**: Record what didn't work, analyze failures with LLM, and include in future prompts:

```text
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

**Failure Analysis Flow** (`analyzeFailure`):
```typescript
// WHY: "rejected: [reason]" isn't helpful; we need specific guidance
setTokenPhase('Analyze failure');

const prompt = `The fix for this issue was rejected:
  File: ${issue.comment.path}:${issue.comment.line}
  Original issue: ${issue.comment.body}
  Attempted changes: ${diff}
  Rejection reason: ${verifyResult.reason}
  
  Generate a 1-2 sentence lesson that will help the next fix attempt succeed.`;

const lesson = await this.llm.analyze(prompt);
this.lessonsManager.addFileLesson(issue.comment.path, lesson);
```

**Why not just add the rejection reason as a lesson?**
- Rejection reasons are often generic: "This doesn't fully address the concern"
- LLM analysis contextualizes: "The null check was added to line 45, but the issue mentions line 47 where the value is also used"
- Actionable guidance prevents the same mistake

**Why prune stale lessons?** Transient failures pollute the lessons store:
- "Connection stalled" - not actionable, will retry
- "Cannot use this model" - transient config issue
- "Process exited with code X" - doesn't help future attempts

On startup, `pruneTransientLessons()` removes these patterns:
```typescript
const transientPatterns = [
  /failed: Cannot use this model/i,
  /failed: Connection/i,
  /failed: timeout/i,
  /failed: ECONNREFUSED/i,
  /tool made no changes, may need clearer/i,
  // ... etc
];
```

**New vs Existing Lessons Tracking** (`LessonsManager`):

```typescript
// WHY: "22 lessons" is ambiguous
// "22 lessons (5 new)" shows progress is being made
private initialLessonCount = 0;     // Count at load time
private newLessonsThisSession = 0;  // Added this run

// Only incremented for TRULY new lessons (not updates)
if (!lessons.includes(lesson)) {
  lessons.push(lesson);
  this.newLessonsThisSession++;
}
```

**WHY track new lessons separately?**
- Resuming a run shows "Loaded 50 lessons" - user wonders if stuck
- "50 lessons (3 new this run)" clarifies progress is happening
- Helps distinguish "system is working" from "system is spinning"
- Displayed in summary: `📚 Lessons: 50 total (3 new this session)`

**Why file-scoped?** Lessons about `auth.ts` aren't relevant when fixing `api.ts`. Reduces prompt noise.

**Why branch-permanent?** Issues recur when you resume work. Lessons survive across runs.

**Why deduplicated?** One lesson per `file:line`. If we learn something new about line 45, it replaces the old lesson.

**Batch vs sequential lesson quality**:
Both batch and sequential verification modes now call `llm.analyzeFailedFix()` for failed verifications. WHY: Batch mode previously recorded raw verification explanations (e.g., "diff doesn't show changes to progressiveTrimMatch") as lessons. These describe what went wrong but not what to do differently. `analyzeFailedFix` produces actionable guidance (e.g., "Don't just add null check at line 45, also need to handle the undefined case at line 47") by analyzing the original issue, the attempted diff, and the rejection reason together.

### 4c. Two-Tier Lessons Storage

**The Problem**: Where should lessons live? If we write to CLAUDE.md, we might overwrite user content. If we use a hidden file, tools like Cursor/Claude Code won't read it.

**Solution**: Two tiers with different responsibilities:

```text
Tier 1: .prr/lessons.md (Canonical Source)
  └─ We control this file completely
  └─ Full history, no limits
  └─ Human-readable markdown
  └─ Team shares via git

Tier 2: CLAUDE.md, CONVENTIONS.md, etc. (Sync Targets)
  └─ We only update a DELIMITED SECTION
  └─ User's existing content preserved
  └─ Compacted to prevent bloat
  └─ Auto-detected based on repo contents
```

**Compaction for sync targets** (WHY: keep CLAUDE.md readable):
- 15 global lessons (most recent)
- 20 files with most lessons
- 5 lessons per file (most recent)
- Full history stays in `.prr/lessons.md`

**Auto-detection of sync targets**:
```typescript
// Always sync to CLAUDE.md (Cursor + Claude Code)
detected.push('claude-md');

// If Aider config exists → also sync there
if (existsSync('.aider.conf.yml') || existsSync('CONVENTIONS.md')) {
  detected.push('conventions-md');
}

// If Cursor rules directory exists → also sync there
if (existsSync('.cursor/rules/')) {
  detected.push('cursor-rules');
}
```

**Delimited section format** (preserves user content):
```markdown
<!-- User's existing CLAUDE.md content above -->

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from .prr/lessons.md - edit there for full history.

### Global
- Lesson 1
- Lesson 2
<!-- PRR_LESSONS_END -->
```

**When lessons are exported**:
- BEFORE each commit (so lessons are included with fixes)
- Final export at end of run (catches edge cases)
- NOT after commit (would require separate commit for lessons)

### 4d. NO_CHANGES Handling & Regurgitation Detection

**The Problem**: When a fixer tool makes zero changes, it may provide a reason. The system needs to distinguish three cases:
1. **Legitimately already fixed** — issues were resolved by previous iterations
2. **Garbled output** — the model echoed its own instructions instead of reasoning
3. **Genuine failure** — the model couldn't figure out what to change

**Why this is hard**: Cursor (and other runners) stream JSON frames. The raw stdout includes metadata like `{"session_id":"..."}` alongside actual text content. Searching raw output for patterns like "already fixed" produces false matches against embedded JSON values.

**Solution layers**:

```text
Layer 1: Clean runner output (src/runners/cursor.ts)
  └─ Extract only text content from JSON stream
  └─ WHY: Prevents downstream pattern matching against protocol metadata

Layer 2: Regurgitation detection (src/workflow/utils.ts)
  └─ PROMPT_REGURGITATION_MARKERS = known instruction fragments
  └─ If output matches known template text → reject as invalid
  └─ WHY: When overwhelmed, models echo "Issue 1 is already fixed -
     Line 45 has null check" verbatim from the instruction template.
     This looks like a valid explanation but isn't.

Layer 3: Strict "already fixed" patterns (src/workflow/no-changes-verification.ts)
  └─ Replaced .includes('has') with /\balready\s+fixed\b/
  └─ WHY: includes('has') matches "This has not been resolved";
     includes('exists') matches "The file no longer exists".
     Word-boundary regexes prevent single-word false positives.

Layer 4: Spot-check verification cap
  └─ Sample 5 issues before full verification of all unresolved
  └─ Skip if < 40% of sample pass
  └─ WHY: A garbled "already fixed" claim triggered verification of
     88 issues (2+ min, significant tokens). Sampling rejects
     bogus claims cheaply before committing to the full pass.
```

**Spot-check constants**:
```typescript
const SPOT_CHECK_SAMPLE_SIZE = 5;    // Issues to verify in sample
const SPOT_CHECK_PASS_THRESHOLD = 0.4;  // 40% must pass to justify full check
```

**Why 40% threshold?** If the fixer legitimately believes issues are fixed, at least 2/5 sampled issues should verify. Below that, the "already fixed" claim is almost certainly wrong and full verification would be wasted work.

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

**Why is `comment.line` unreliable?**
- GitHub attaches comments to "the line you clicked" - often the start of a function
- Bot reviewers add comments at one place but describe bugs at another
- The `line` field is where the comment was POSTED, not where the BUG IS

**Solution**: Parse LOCATIONS metadata from comment body:

```markdown
<!-- LOCATIONS START
packages/rust/src/runtime.rs#L100-L150
LOCATIONS END -->
```

**Implementation** (`getCodeSnippet`):
```typescript
// First check for LOCATIONS in comment body
if (commentBody) {
  const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
  if (locationsMatch) {
    // Parse line range from location URL
    const lineMatch = location.match(/#L(\d+)(?:-L(\d+))?/);
    // Use these lines instead of comment.line
  }
}

// Fallback: use comment.line ± context
```

**Why this matters**: Without correct code snippets, the fixer LLM doesn't see the actual bug. Early versions had 10+ failed iterations because the LLM was looking at the wrong code.

### 7. Git Authentication

Token is embedded in the HTTPS remote URL for authentication:
```text
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

### 9. Push Handling with Auto-Retry

**The Problem**: Push can fail for several reasons:
1. Remote has newer commits (CodeRabbit or someone pushed while we worked)
2. Token not in remote URL (old workdir, manual clone)
3. Network issues or timeout

**Solution**: Multi-layer push handling:

```typescript
// 1. Pre-push: Ensure token is in remote URL
const remoteUrl = execSync('git remote get-url origin');
if (!remoteUrl.includes('@') && githubToken) {
  const authUrl = remoteUrl.replace('https://', `https://${githubToken}@`);
  execSync(`git remote set-url origin "${authUrl}"`);
}

// 2. Push with rejection detection
const result = await push(git, branch);
if (result.rejected) {
  // 3. Fetch + rebase + retry
  await git.fetch('origin', branch);
  await git.rebase([`origin/${branch}`]);
  await push(git, branch);  // retry
}
```

**Why inject token before push?**
- Token might be missing from old workdirs
- Manual clones don't have token
- Without token, git prompts for credentials (causes timeout)

**Why rebase on rejection?**
- Merge would create ugly merge commits
- Rebase puts our fixes cleanly on top of remote
- History stays linear and readable

**Why 30s timeout (reduced from 60s)?**
- Push should be fast (network + auth negotiation)
- If it takes longer, something is wrong
- 60s was too long to wait for a hung process

**What if rebase has conflicts?**
- We abort the rebase (`git rebase --abort`)
- Return error asking for manual resolution
- User's local state is preserved

### 10. Divergent Branch Handling

**The Problem**: "Need to specify how to reconcile divergent branches" error when local and remote have diverged.

**Solution**: `pullLatest` fetches first, then rebases:

```typescript
// 1. Fetch to see what we're dealing with
await git.fetch('origin', branch);

// 2. Check divergence
const status = await git.status();
const { ahead, behind } = status;

if (ahead > 0 && behind > 0) {
  // 3. Diverged - rebase our commits on top of remote
  console.log(`Rebasing ${ahead} local commit(s) onto ${behind} remote commit(s)...`);
  await git.rebase([`origin/${branch}`]);
} else if (behind > 0) {
  // 4. Just behind - simple fast-forward
  await git.pull('origin', branch, { '--ff-only': null });
}
// If only ahead (or equal), nothing to pull
```

**Why fetch first instead of pull?**
- We need to know the divergence state before deciding strategy
- `git pull` without options fails on divergence
- Fetch is always safe (doesn't modify working tree)

**Why rebase instead of merge?**
- Our local commits are prr's fixes - they should go ON TOP of remote
- Merge would interleave commits, making history harder to read
- Rebase keeps the "prr did this" commits together

**Fallback if rebase fails:**
- Try merge instead
- If merge also fails (conflicts), abort and report
- User can manually resolve in workdir

### 11. CodeRabbit Auto-Trigger on Startup

**The Problem**: Some repos configure CodeRabbit in manual mode (`@coderabbitai review` required). If prr starts fixing issues without triggering CodeRabbit first, we might miss new review comments that CodeRabbit would add.

**Solution**: Check CodeRabbit status on startup, trigger if needed:

```typescript
// On startup, after fetching PR info:
const crResult = await this.github.triggerCodeRabbitIfNeeded(
  owner, repo, number, branch, headSha
);

// Returns:
// - mode: 'auto' | 'manual' | 'none' | 'unknown'
// - reviewedCurrentCommit: boolean
// - triggered: boolean
// - reason: string
```

**How it determines mode**:
1. Fetch `.coderabbit.yaml` from the repo
2. Check `reviews.auto_review` setting
3. If `auto_review: false` → manual mode
4. If `auto_review: true` or not specified → auto mode
5. If `request_changes_workflow` present → likely manual

**When we trigger**:
- Manual mode AND CodeRabbit hasn't reviewed current commit → trigger
- Auto mode → no trigger needed (CodeRabbit will pick it up)
- Already reviewed current commit → no trigger needed

**WHY trigger early?**
- CodeRabbit takes time to analyze
- By triggering on startup, review is ready by the time we finish fixing
- Avoids delay loop of: fix → push → wait for CodeRabbit → more comments → fix again

**Output on startup**:
```text
✓ CodeRabbit: already reviewed abc1234 ✓
  or
✓ CodeRabbit: triggered review (manual mode)
  CodeRabbit review requested - it will analyze while we work
  or
ℹ CodeRabbit: not configured for this repo
```

### 12. Model Performance Tracking

**The Problem**: Different models have different strengths. Some work well for a codebase, others don't. Without tracking, we can't learn from experience.

**Solution**: Track model performance per project in state file:

```typescript
// State includes:
modelPerformance: {
  "cursor/claude-4-sonnet-thinking": {
    fixes: 15,       // Issues successfully fixed
    failures: 3,     // Fix attempts that failed verification
    noChanges: 2,    // Times model made no changes
    errors: 1,       // Tool errors (connection, timeout)
    lastUsed: "2026-01-23T..."
  },
  "cursor/gpt-5.2": { ... }
}
```

**What we track**:
- `fixes`: Verification passed (issue resolved)
- `failures`: Verification failed (issue not resolved)
- `noChanges`: Model ran but made no changes (often means it didn't understand the task)
- `errors`: Tool errors (connection stalled, timeout, model unavailable)

**When we track**:
```typescript
// After verification completes:
if (verifiedCount > 0) {
  this.stateManager.recordModelFix(runner.name, model, verifiedCount);
}
if (failedCount > 0) {
  this.stateManager.recordModelFailure(runner.name, model, failedCount);
}

// On tool failure:
this.stateManager.recordModelError(runner.name, model);

// On no changes:
this.stateManager.recordModelNoChanges(runner.name, model);
```

**Output at end of run**:
```text
📊 Model Performance:
  cursor/claude-4-sonnet-thinking: 15 fixes, 3 failed (83% success)
  cursor/gpt-5.2: 5 fixes, 8 failed (38% success)
  cursor/o3: 2 no-change, 1 errors
```

**WHY track this?**
- Learn which models work for this codebase
- Prioritize better-performing models in future
- Skip models that consistently fail
- Help users understand tool effectiveness

**Future use**: Could use this data to auto-prioritize models (try best-performing first).

### 13. Bail-Out Mechanism (Stalemate Detection)

**The Problem**: AI agents can get into stalemates where no progress is made:
- Fixer says "already fixed", verifier disagrees → loop forever
- Multiple agents (CodeRabbit, LLM judge, fixer tool) have conflicting opinions
- Issues genuinely beyond automation capability (unclear spec, conflicting requirements)
- Observed: 5+ consecutive attempts where fixer makes NO changes, just retries

**Solution**: Track "no-progress cycles" and bail out gracefully:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          Progress Tracking                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  progressThisCycle: number    // Verified fixes in current cycle         │
│  noProgressCycles: number     // Cycles completed with zero progress     │
│  maxStaleCycles: number       // Threshold for bail-out (default: 1)     │
│                                                                          │
│  A "cycle" = all tools × all models tried once                           │
│                                                                          │
│  When ALL tools exhaust ALL models (cycle complete):                     │
│    if (progressThisCycle === 0) {                                        │
│      noProgressCycles++;                                                 │
│      if (noProgressCycles >= maxStaleCycles) → BAIL OUT                  │
│    } else {                                                              │
│      noProgressCycles = 0;  // Reset on progress                         │
│    }                                                                     │
│    progressThisCycle = 0;   // Reset for next cycle                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Implementation locations**:

| Component | File | Purpose |
|-----------|------|---------|
| `progressThisCycle` | `resolver.ts` | Track verified fixes per cycle |
| `noProgressCycles` | `state/manager.ts` | Persisted cycle counter |
| `maxStaleCycles` | `cli.ts` | CLI option (default: 1) |
| `BailOutRecord` | `state/types.ts` | Document why automation stopped |
| `executeBailOut()` | `resolver.ts` | Graceful bail-out sequence |

**Where bail-out is triggered** (in `resolver.ts`):

```typescript
// In tryRotation(), when all tools exhausted:
const checkBailOut = (): boolean => {
  if (this.progressThisCycle === 0) {
    const cycles = this.stateManager.incrementNoProgressCycles();
    if (cycles >= this.options.maxStaleCycles) {
      return true;  // Signal bail-out
    }
  } else {
    this.stateManager.resetNoProgressCycles();
  }
  this.progressThisCycle = 0;
  return false;
};

// In fix loop, after tryRotation() returns false:
if (this.stateManager.getNoProgressCycles() >= this.options.maxStaleCycles) {
  // Last resort: try direct LLM API
  const directFixed = await this.tryDirectLLMFix(...);
  if (!directFixed) {
    await this.executeBailOut(unresolvedIssues, comments);
    break;  // Exit fix loop
  }
}
```

**Bail-out sequence** (`executeBailOut()`):

```text
1. Record bail-out in state (for debugging/analysis)
   └─ Reason, cycles completed, remaining issues, tools tried
   
2. Print detailed summary
   └─ What was fixed, what remains, lessons learned
   └─ Tools/models exhausted, suggested next steps
   
3. Exit fix loop cleanly
   └─ Caller handles commit/push of partial progress
   └─ Whatever WAS fixed gets committed and pushed
```

**Why track cycles, not individual failures?**
- Individual failures are normal (model needs different approach)
- Consecutive failures might just mean hard issue (keep trying)
- Full cycle failure = "every tool, every model tried, zero progress"
- More robust signal that we're genuinely stuck

**Why default to 1 cycle?**
- Conservative: bail early, let human debug
- Prevents overnight loops burning API costs
- User can increase once they trust the system
- `--max-stale-cycles 2` for more patience

**Why persist noProgressCycles?**
- Survives Ctrl+C interruptions
- Resuming picks up where we left off
- Prevents "reset to 0" on each restart defeating the purpose

**BailOutRecord structure** (`state/types.ts`):

```typescript
interface BailOutRecord {
  timestamp: string;
  reason: 'no-progress-cycles' | 'max-iterations' | 'user-interrupt' | 'all-dismissed';
  cyclesCompleted: number;
  remainingIssues: Array<{
    commentId: string;
    filePath: string;
    line: number | null;
    summary: string;
  }>;
  partialProgress: {
    issuesFixed: number;
    issuesRemaining: number;
    lessonsLearned: number;
  };
  toolsExhausted: string[];
}
```

**Why document bail-outs?**
- Human needs to know where to pick up
- Pattern analysis: what types of issues cause stalemates?
- Feedback loop: improve prompts/lessons based on failures
- Accountability: prove automation tried before giving up

**Who makes the final call when agents disagree?**

The LLM verifier has final authority, with these rules:
1. Fixer says "already fixed" + Verifier confirms → Mark fixed
2. Fixer says "already fixed" + Verifier disagrees → Keep trying
3. All fixers fail + Verifier confirms unfixable → Bail with documented reason
4. All fixers fail + Verifier says should be fixable → Bail, flag for human

**Design decision: Why not just increase maxFixIterations?**
- Iterations ≠ cycles. 100 iterations with same model = same failure mode
- Cycles ensure diversity (different tools, different models)
- More meaningful progress metric

### 14. Empty Issue Guards (Defense in Depth)

**The Problem**: Code paths exist where `unresolvedIssues` array becomes empty but the fix loop continues. Running fixer tools with empty prompts wastes time and causes confusing errors.

**Solution**: 5 layers of guards:

```text
Layer 1: Before outer fix loop (resolver.ts)
  └─ if (unresolvedIssues.length === 0) break;
  
Layer 2: At START of each inner loop iteration (resolver.ts)
  └─ if (unresolvedIssues.length === 0) break;
  └─ WHY: After verification, issues may all be filtered out
  
Layer 3: After building prompt (resolver.ts)
  └─ if (prompt.length === 0 || unresolvedIssues.length === 0) break;
  └─ WHY: buildFixPrompt returns empty string for 0 issues
  
Layer 4: In buildFixPrompt (prompt-builder.ts)
  └─ if (issues.length === 0) return { prompt: '', ... };
  └─ WHY: Don't build meaningless "Fixing 0 issues" prompt
  
Layer 5: In every runner (cursor.ts, llm-api.ts, etc.)
  └─ if (!prompt || prompt.trim().length === 0) return error;
  └─ WHY: Final defense - runners refuse to run with empty prompt
```

**Why so many layers?**
- Complex control flow with multiple exit paths
- `unresolvedIssues` can be modified in many places (splice, filter, etc.)
- Better to catch early than waste a fixer run
- Each layer has different context and can provide clearer error messages

**What triggers this?**
- All issues verified fixed, but loop didn't exit properly
- State loaded from previous run where issues are already resolved
- Issues filtered out during verification but `allFixed` flag not set

### 15. Merge Conflict Resolution

**The Problem**: Merge conflicts block the entire fix loop. Previously, prr would bail out with "resolve manually" whenever conflicts were detected - frustrating because:
1. The same LLM tools that fix review comments can resolve merge conflicts
2. Users had to manually resolve, then re-run prr
3. Interrupted runs often left conflict markers that blocked the next run

**Solution**: Unified `resolveConflictsWithLLM()` method with two-stage approach:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                     Conflict Resolution Flow                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Trigger Points (all call resolveConflictsWithLLM):                      │
│    1. Initial conflict check (previous interrupted merge/rebase)         │
│    2. Pull conflicts (branch diverged from remote)                       │
│    3. Stash pop conflicts (interrupted run with local changes)           │
│    4. Base branch merge (PR conflicts with main/master)                  │
│                                                                          │
│  Stage 1: Lock Files (handleLockFileConflicts)                           │
│    └─ bun.lock, package-lock.json, yarn.lock, Cargo.lock, etc.           │
│    └─ Delete and regenerate via package manager                          │
│    └─ WHY: LLMs can't merge lock files - they're machine-generated       │
│                                                                          │
│  Stage 2: Code Files (LLM-powered)                                       │
│    └─ Attempt 1: Use fixer tool (Cursor, Claude Code, Aider, etc.)       │
│    └─ Attempt 2: Direct LLM API fallback for remaining conflicts         │
│    └─ Check BOTH git status AND file contents for conflict markers       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**WHY unified method?** Conflict resolution code was duplicated in 4 places with slight variations:
- Initial conflict detection after clone
- Pull conflicts when syncing with remote
- Stash pop conflicts from interrupted runs
- Base branch merge conflicts for PR updates

The old code had ~250 lines duplicated. Now all share `resolveConflictsWithLLM()` for:
- Consistent behavior across all conflict scenarios
- Single place to improve/fix conflict resolution logic
- Easier testing and maintenance

**WHY check early (before fix loop)?**
- Conflict markers (`<<<<<<<`) in files will cause fixer tools to fail confusingly
- They might try to "fix" the conflict markers as if they were code issues
- Better to detect and resolve conflicts upfront

**Lock file handling** (`handleLockFileConflicts`):

```typescript
// 1. Delete conflicted lock files
fs.unlinkSync(lockFilePath);

// 2. Regenerate via package manager (whitelisted commands only!)
const ALLOWED_COMMANDS = {
  'bun install': ['bun', 'install'],
  'npm install': ['npm', 'install'],
  'yarn install': ['yarn', 'install'],
  'pnpm install': ['pnpm', 'install'],
  'cargo generate-lockfile': ['cargo', 'generate-lockfile'],
  // ... etc
};

// Security: spawn with args array, NOT shell
spawn(executable, args, { shell: false });
```

**WHY delete/regenerate lock files?**
- Lock files are auto-generated from manifest (package.json, Cargo.toml)
- LLMs don't understand the lock file format semantics
- Attempting to merge them produces invalid or incorrect results
- Fresh generation from already-merged manifest is deterministic and correct

**WHY whitelist commands?**
- Security: only run known-safe commands
- Prevent arbitrary code execution from repo content
- A malicious repo could try to trick prr into running dangerous commands

**WHY disable install scripts?**
```typescript
safeEnv.npm_config_ignore_scripts = 'true';
safeEnv.YARN_ENABLE_SCRIPTS = '0';
safeEnv.BUN_INSTALL_DISABLE_POSTINSTALL = '1';
safeEnv.PNPM_DISABLE_SCRIPTS = 'true';
```
- Package managers run arbitrary scripts during install (postinstall, preinstall)
- These scripts come from dependencies and could be malicious
- We only need the lock file regenerated, not full install

**WHY spawn without shell?**
- `spawn(cmd, args, { shell: false })` prevents shell injection
- With `shell: true`, special characters in paths could be interpreted as shell commands
- A crafted filename like `; rm -rf /` could execute arbitrary commands

**Code file resolution**:

```typescript
// Attempt 1: Fixer tool (Cursor, Claude Code, etc.)
const conflictPrompt = this.buildConflictResolutionPrompt(codeFiles, baseBranch);
const runResult = await this.runner.run(workdir, conflictPrompt);

// Check for remaining conflict markers - BOTH sources!
const gitConflicts = (await git.status()).conflicted || [];
const markerConflicts = await findFilesWithConflictMarkers(workdir, codeFiles);
const remaining = [...new Set([...gitConflicts, ...markerConflicts])];

// Attempt 2: Direct LLM API (if conflicts remain)
for (const file of remaining) {
  const content = fs.readFileSync(file, 'utf-8');
  if (!content.includes('<<<<<<<')) continue;  // Already resolved
  
  const result = await this.llm.resolveConflict(file, content, branch);
  if (result.resolved) {
    fs.writeFileSync(file, result.content);
    await git.add(file);
  }
}
```

**WHY two attempts?**
- Fixer tools are good at agentic changes with full workspace context
- But they sometimes miss conflict markers or make partial fixes
- Direct LLM API gives precise control for targeted, per-file resolution
- Second attempt catches what first attempt missed

**WHY check both git status AND file contents?**
- Git might mark a file as resolved (not in `status.conflicted`)
- But the file might still contain `<<<<<<<` markers if the tool staged it prematurely
- `findFilesWithConflictMarkers()` scans actual file contents
- Double-check catches false positives from tools that stage before fully resolving

**Conflict prompt** (`buildConflictResolutionPrompt`):

```typescript
return `MERGE CONFLICT RESOLUTION

The following files have merge conflicts that need to be resolved:
${fileList}

These conflicts occurred while merging '${baseBranch}' into the current branch.

INSTRUCTIONS:
1. Open each conflicted file
2. Look for conflict markers: <<<<<<<, =======, >>>>>>>
3. For each conflict:
   - Understand what both sides are trying to do
   - Choose the correct resolution that preserves the intent of both changes
   - Remove all conflict markers
...
`;
```

**WHY "preserve intent of both"?**
- Naive resolution picks one side blindly
- Smart resolution merges both changes when possible
- The prompt guides the LLM to think about what each side was trying to accomplish

**Caller handling after resolution**:

```typescript
// If success: complete the merge
if (resolution.success) {
  await markConflictsResolved(git, codeFiles);
  await completeMerge(git, `Merge branch '${baseBranch}'`);
} else {
  // If failure: abort and let human handle
  console.log('Remaining conflicts:', resolution.remainingConflicts);
  await abortMerge(git);
}
```

**WHY abort on failure (not partial commit)?**
- Partial conflict resolution leaves repo in bad state
- Better to abort and preserve the conflict markers for human review
- User can see exactly what couldn't be resolved

### Delete Conflict Resolution

**The Problem**: Git conflicts where one side deleted a file (`CLAUDE.md` "deleted by them") lack traditional `<<<<<<<` markers. The existing resolution logic skipped these files silently.

**Solution**: Detect delete conflicts via `git status --porcelain` and resolve with `git rm`:

```typescript
// Detect UD (we modified, they deleted), DU (they modified, we deleted), DD (both deleted)
const deleteConflicts = await detectDeleteConflicts(git, codeFiles, workdir);
for (const dc of deleteConflicts) {
  await resolveDeleteConflict(git, dc, workdir);  // git rm <file>
  codeFiles.splice(codeFiles.indexOf(dc.file), 1);  // Don't try LLM resolution
}
```

**WHY accept deletion?** The remote branch reflects the team's intent. If they deleted a file, our local modifications to it are likely stale.

### Model Validation at Startup

**The Problem**: Models like `gpt-5.3-codex` would fail repeatedly with "model does not exist" errors, wasting retries and API calls.

**Solution**: Query OpenAI (`GET /v1/models`) and Anthropic APIs at startup to discover accessible models. Filter internal rotation lists so only available models are attempted.

### Issue Solvability Detection

**The Problem**: Review comments referencing deleted files or fundamentally stale code would waste LLM tokens on unsolvable issues.

**Solution**: Pre-screen review comments to identify issues that cannot be fixed (deleted files, stale references). These are dismissed before the fix loop begins.

### Batch Analysis Size Cap

**The Problem**: 189 issues in a single batch caused haiku to produce a 4K summary instead of 189 structured response lines (`parsed: 0/189`).

**Solution**: Cap batch issue analysis at 50 issues per batch. Batching was only gated on prompt size (chars), not response size (issue count). Now 189 issues → 4 batches of ~47 each.

### CodeRabbit Final-Push-Only Trigger

**The Problem**: Triggering CodeRabbit re-review after every push created a "moving target" with new comments appearing mid-fix.

**Solution**: Only trigger CodeRabbit for a final review when all issues are resolved. Intermediate pushes skip CodeRabbit.

### Lesson Cleanup (`--tidy-lessons`)

**The Problem**: Lesson stores accumulated garbage entries like "No verification result returned, treating as failed" that polluted fix prompts.

**Solution**: 
1. **Prevention**: Stopped generating non-actionable lessons at source
2. **Normalization filters**: `lessons-normalize.ts` rejects known garbage patterns
3. **CLI cleanup**: `--tidy-lessons` scans all JSON files in `~/.prr/lessons/` and `.prr/lessons.md`, re-normalizes, deduplicates, and prunes

### Review comments (durable inline)

**The Problem**: PR review tools (including prr) can leave inline comments like `// REVIEW: line 248 uses || but should use ?? (b340047)`. Those references go stale as the code changes and look like tool cruft in the long term.

**Policy**: We still leave a short comment so there can be dialog (with bots or humans), but **how we leave it** matters. All `// Review:` (or equivalent) text must be **long-term documentation**:

- **No** line numbers, commit hashes, or references to prr/review tools.
- **Yes** short, intent-based explanation that stays valid as the code evolves (e.g. "Backoff enforced in acquire(); explicit sleep here is redundant" or "handled in getConfig()").

**Where it’s enforced**: Fixer prompts (`prompt-builder.ts`, `workflow/utils.ts`) and the dismissal-comment LLM prompt (`llm/client.ts` → `generateDismissalComment`) instruct the model to produce durable explanations only. The prefix remains `Review:` for consistency; the content is constrained to be documentation-style.

### Empty or placeholder test files not committed

**The Problem**: Empty or placeholder test files (e.g. `test_fail.ts` with a single blank line) get committed when a fixer or user adds them by mistake. Review bots then flag "empty test file accidentally committed".

**Solution**: Pre-commit checks in `git-commit-core.ts` (`runPreCommitChecks`):

- **Detection**: Staged files whose names look like tests (`*.test.ts`, `*.spec.ts`, `*_test.*`, `test_*.*`) are inspected. If the staged content is empty or "placeholder" (very short, no test keywords like `test(`, `it(`, `expect(`), the file is excluded.
- **Action**: The file is unstaged. If it was a **new** file, it is also removed from the working tree so the next run does not stage it again; the user sees a message like `Excluded empty test file (removed from commit and working tree): path/to/test_fail.ts`. If it was a **modified** file (e.g. someone emptied it), the file is reverted to HEAD.

Both commit paths use this: `squashCommit` (main fix loop) and `commitIteration` (iteration cleanup) call `runPreCommitChecks` after staging.

### Fixer/verifier alignment (verifier citation feedback)

**The Problem**: When the fixer claims ALREADY_FIXED but the verifier says the issue still exists, the next fix attempt often repeated the same claim because the fixer never saw **what the verifier cited** (e.g. "getHistoricalPrices method not found", "start() does not validate JUPITER_API_KEY"). This caused stalemates (e.g. Jupiter audit: many cycles with zero progress).

**Solution**:

1. **Verifier explanation on the issue:** When batch or sequential verify returns NO, we set `issue.verifierContradiction = explanation` (and optionally append the lesson). The same issue object is reused in the next iteration; `recheckSolvability` preserves fields when refreshing snippets (`{ ...issue, codeSnippet: newSnippet }`).
2. **Fix prompt injection:** Both `buildFixPrompt` (batch) and `buildSingleIssuePrompt` (single-issue) inject a **⚠ VERIFIER DISAGREES** block when `verifierContradiction` is set, telling the fixer to treat the verifier's explanation as the source of truth for what is still missing or wrong.
3. **Verifier prompt:** The batch verify prompt instructs the LLM that when answering NO, the explanation is used as the source of truth for the next fix; it must cite specific code, method names, or lines (e.g. "getHistoricalPrices method not found in Current Code") so the fixer can target the gap.

**Where:** `fix-verification.ts` (set `verifierContradiction` on failure in both batch and sequential paths), `prompt-builder.ts` (batch fix prompt), `workflow/utils.ts` (single-issue prompt), `llm/client.ts` (batch verify prompt). The no-changes path (`no-changes-verification.ts`) already set `verifierContradiction` when the ALREADY_FIXED re-check said still exists.

### 9. Commit Message Generation

**The Problem**: Early versions produced commit messages like:
```text
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
      "verifiedAtIteration": 5
    }
  ],
  "currentRunnerIndex": 0,     // Tool rotation position
  "modelIndices": {            // Per-tool model rotation position
    "cursor": 2,
    "llm-api": 0
  },
  "modelPerformance": {        // Track which models work well
    "cursor/claude-4-sonnet-thinking": {
      "fixes": 15,
      "failures": 3,
      "noChanges": 2,
      "errors": 0,
      "lastUsed": "2026-01-23T10:30:00Z"
    }
  },
  "noProgressCycles": 0,       // Cycles with zero verified fixes (for bail-out)
  "bailOutRecord": {           // Last bail-out event (if any)
    "timestamp": "2026-01-23T12:00:00Z",
    "reason": "no-progress-cycles",
    "cyclesCompleted": 1,
    "remainingIssues": [...],
    "partialProgress": { "issuesFixed": 3, "issuesRemaining": 2, "lessonsLearned": 7 },
    "toolsExhausted": ["cursor", "claude-code", "llm-api"]
  },
  "interrupted": false,
  "interruptPhase": null,
  "totalTimings": { "Fetch PR info": 500, ... },
  "totalTokenUsage": [{ "phase": "Analyze", "inputTokens": 1000, ... }]
}
```

**Why `verifiedComments` with timestamps?** Enables verification expiry. If a verification is N iterations old, re-check it.

**Why `currentRunnerIndex` and `modelIndices`?** Resume rotation from where we left off. Without this, every restart begins with the same tool/model.

**Why `modelPerformance`?** Track which models work well for this project. Shows success rate at end of run. Could be used to auto-prioritize models in the future.

**Why `noProgressCycles`?** Track how many complete tool/model cycles have run with zero progress. Triggers bail-out when threshold reached. Persists across restarts so interruption doesn't reset the counter.

**Why `bailOutRecord`?** Document exactly what happened when automation gave up:
- What tools/models were tried
- What issues remain (for human follow-up)
- How much progress was made before giving up
- Enables pattern analysis of what causes stalemates

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
- `--model` validated against `/^[A-Za-z0-9.-]+$/`
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
bun run typecheck

# Run locally
bun dist/tools/prr/index.js https://github.com/owner/repo/pull/123

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

# Install (Linux)
curl https://cursor.com/install -fsS | bash

# Install (Intel Mac)
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

### Push Timeout or Rejection
**Symptoms**: "Push timed out after 30 seconds" or "Push rejected: remote has newer commits"

**Causes**:
1. Token not in remote URL (git waiting for credentials)
2. Someone pushed while prr was working (CodeRabbit, human)
3. Network issues

**What prr does automatically**:
1. Injects token if missing: `git remote set-url origin https://TOKEN@github.com/...`
2. On rejection: fetches, rebases local commits on remote, retries push
3. Times out after 30s instead of hanging forever

**If it still fails**:
```bash
# Check remote URL has token
cd ~/.prr/work/<hash>
git remote get-url origin
# Should show https://ghp_xxx@github.com/...

# Manual push
git push origin <branch>

# If rejected, rebase manually
git fetch origin <branch>
git rebase origin/<branch>
git push
```

### "Need to specify how to reconcile divergent branches"
**Cause**: Local branch has commits remote doesn't have, AND remote has commits local doesn't have.

**What prr does**: Automatically rebases local commits on top of remote.

**If rebase has conflicts**:
```bash
cd ~/.prr/work/<hash>
git status  # See conflicted files
# Resolve conflicts manually
git add .
git rebase --continue
git push
```

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

### Bail-Out Triggered Too Early
**Symptoms**: prr bails out after 1 cycle, but you think more attempts might work.

**Causes**:
1. Default `--max-stale-cycles` is 1 (conservative)
2. Issue is hard but solvable with more attempts
3. Lessons not helping the fixer improve

**Fixes**:
```bash
# Allow more cycles before bailing
prr <url> --max-stale-cycles 2

# Or unlimited (not recommended for unattended runs)
prr <url> --max-stale-cycles 0

# Check what lessons were learned
cat ~/.prr/work/<hash>/.pr-resolver-state.json | jq '.lessonsLearned'

# Check bail-out record
cat ~/.prr/work/<hash>/.pr-resolver-state.json | jq '.bailOutRecord'
```

**What the bail-out record tells you**:
- `cyclesCompleted`: How many full cycles ran with zero progress
- `remainingIssues`: What's left for human follow-up
- `toolsExhausted`: Which tools/models were tried
- `partialProgress`: How much was actually fixed before giving up

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

## Direct LLM API Runner Design

The `LLMAPIRunner` (`runners/llm-api.ts`) is special - it calls LLM APIs directly instead of CLI tools.

**WHY a direct API runner?**
- Final fallback when all CLI tools fail
- No binary dependencies - just API keys
- Can use different models than CLI tools expose
- Useful for debugging (full control over prompt/response)

**Search/Replace Format** (not full file rewrites):

```xml
<change path="relative/path/to/file.ext">
<search>
exact lines to find (include context for uniqueness)
</search>
<replace>
the replacement lines
</replace>
</change>
```

**WHY search/replace instead of full file?**
- LLMs love to "improve" code beyond what's needed
- Full file output = risk of losing unrelated changes
- Search/replace = minimal, surgical edits
- Easier to verify what changed
- Legacy `<file>` format still supported but deprecated

**Path Security**:
```typescript
// WHY: Prevent directory traversal attacks
const { safe, fullPath } = this.isPathSafe(workdir, filePath);
if (!safe) {
  debug('Skipping file outside workdir', { filePath });
  continue;
}
```

**WHY check paths?** A malicious review comment could trick the LLM into writing to `../../../etc/passwd`.

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

**Security Checklist for New Runners**:
- [ ] Use `spawn(binary, args)` NOT `spawn('sh', ['-c', cmd])`
- [ ] Validate model names with `isValidModel()` before passing to CLI
- [ ] Pass prompts via temp file or stdin, NOT shell interpolation
- [ ] Check file paths stay within workdir

## Token/Cost Tracking

Tokens are tracked per phase:
- `Analyze issues` - checking if issues still exist
- `Verify fixes` - checking if diffs address issues  
- `Resolve conflicts` - direct LLM conflict resolution
- `Direct LLM fix` - fallback fixer

**Session vs Overall Stats** (`logger.ts`):

```typescript
// WHY: Distinguish "what happened this run" from "cumulative history"
// Users often resume runs - they need to see both perspectives

sessionTimings: Record<string, number>    // This run only
overallTimings: Record<string, number>    // Loaded from state + this run

sessionTokenUsage: TokenUsageRecord[]     // This run only  
overallTokenUsage: TokenUsageRecord[]     // Cumulative across runs
```

**WHY track separately?**
- "5 minutes" could mean: this run took 5 min, OR total across 3 runs is 5 min
- Users want to know: "How long was THIS run?" vs "How much have I spent total?"
- Session stats reset on each run; overall persists in state file
- At end of run, both are printed so user knows the full picture

**Output format**:
```text
⏱ Timing Summary (this session):
  Fetch PR info: 1.2s
  Analyze issues: 15.3s
  ...

📊 Overall (across all sessions):
  Fetch PR info: 4.5s (3 runs)
  Analyze issues: 45.2s (3 runs)
  ...
```

Cost estimate uses rough rates:
- Input: ~$3/M tokens
- Output: ~$15/M tokens

## Output Log Tee

**The Problem**: Debugging prr requires reading its console output, but terminal scrollback is finite, hard to search, and loses formatting on copy-paste. When feeding output to another LLM for analysis, you need a clean text file.

**Solution**: Monkey-patch `process.stdout.write` and `process.stderr.write` at startup to mirror all output to `~/.prr/output.log`:

```typescript
// src/logger.ts
export function initOutputLog(): void {
  const logPath = path.join(os.homedir(), '.prr', 'output.log');
  // Truncate on each run start — always latest session only
  outputLogStream = fs.createWriteStream(logPath, { flags: 'w' });
  
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk: any, ...args: any[]): boolean {
    // Strip ANSI escape codes for clean text
    outputLogStream.write(stripAnsi(String(chunk)));
    return origStdoutWrite(chunk, ...args);
  };
  // Same for stderr
}
```

**Why monkey-patch stdout/stderr?** All output paths (console.log, spinner libraries, debug logging, child process output) go through these. Wrapping at this level captures everything without modifying every log call site.

**Why strip ANSI?** Terminal escape codes (`\x1b[32m` etc.) make the file unreadable in plain text editors and confuse LLMs. Stripping produces clean text that works everywhere.

**Why truncate on start, not append?** Appending would require the user to figure out where the latest run begins. Truncation means the file always contains exactly one session — the most recent one. If you need historical output, use `--verbose` with dedicated debug log files.

**Lifecycle**:
1. `initOutputLog()` called at the top of `src/index.ts` (before any output)
2. `closeOutputLog()` called in success path, error handler, and signal handlers
3. Path printed at end: `Full output log: ~/.prr/output.log`

## Graceful Shutdown

On Ctrl+C (SIGINT):
1. `resolver.gracefulShutdown()` called
2. State saved with `interrupted: true`, `interruptPhase: "fixing"`
3. Timing/token summaries printed
4. Exit with signal-specific code

**Signal-Specific Exit Codes** (`index.ts`):

```typescript
// WHY: Unix convention - 128 + signal number
// WHY: Scripts can detect HOW the process ended
const signalCodes: Record<string, number> = {
  'SIGINT': 130,   // 128 + 2 (Ctrl+C)
  'SIGTERM': 143,  // 128 + 15 (kill command)
  'SIGHUP': 129,   // 128 + 1 (terminal closed)
  'SIGQUIT': 131,  // 128 + 3 (Ctrl+\)
};
```

**WHY signal-specific codes?**
- `exit 130` tells calling scripts "user interrupted, not an error"
- `exit 143` tells calling scripts "process was terminated externally"
- Allows CI/automation to distinguish user intent vs failures
- Standard Unix practice - `exit 1` is ambiguous

**Force Exit on Double Signal**:
```typescript
if (isShuttingDown) {
  // Second Ctrl+C = user really wants out NOW
  console.log('Force exit.');
  process.exit(1);
}
```

**WHY?** Sometimes shutdown hangs (network, file locks). Double Ctrl+C lets user force quit.

**On resume**:
1. `wasInterrupted()` returns true
2. Can skip re-analysis of already-verified fixes
3. Caller must call `clearInterrupted()` after handling

**WHY explicit `clearInterrupted()`?**
- Early versions auto-cleared on load - lost information
- Caller needs to KNOW it was interrupted before clearing
- Pattern: load → check `wasInterrupted()` → handle → `clearInterrupted()`
