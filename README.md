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

**Philosophy in practice**:
- Run prr on a specific PR (you choose)
- Watch it work, interrupt with Ctrl+C anytime
- Inspect the workdir, modify files, continue
- Push when *you* decide it's ready

## Features

### Core Loop
- Fetches review comments from PRs (humans, bots, or any reviewer)
- Uses LLM to detect which issues still exist in the code
- Generates fix prompts and runs Cursor CLI, Claude Code, or opencode to fix issues
- Verifies fixes with LLM to prevent false positives
- **Final audit**: Adversarial re-verification of ALL issues before declaring done

### Smart Retry Strategies
- **Lessons learned**: Tracks what didn't work to prevent flip-flopping between solutions
- **LLM-powered failure analysis**: Learns from rejected fixes to generate actionable guidance
- **Smart model rotation**: Interleaves model families (Claude → GPT → Gemini) for better coverage
- **Rotation order & skip list (llm-api/elizacloud)**: Default lists ordered by observed fix success (Claude first); models that 500/timeout or have 0% fix rate are in a skip list and never selected. *Why*: Audit showed 0%-success and error-prone models wasting rotation slots; leading with best performers improves throughput.
- **Duplicate prompt skip**: When the same set of issue IDs and lesson count is sent to the same model again, we skip the fixer and rotate to the next model. *Why*: Full-prompt hashes rarely matched; hashing issue IDs + lesson count detects same-issues-same-context and avoids redundant LLM calls.
- **Proportional batch reduce**: When the fix prompt exceeds the context cap, batch size is reduced proportionally (cap/promptLength) instead of halving. *Why*: Halving wasted iterations when only slightly over cap; proportional reduction converges in 1–2 steps.
- **Rotation reset per push iteration**: At the start of each push cycle (after the first), the model index resets to the first model so each cycle gets a "best model first" attempt instead of continuing from where the previous cycle left off. *Why*: Later push iterations were reusing the last model from the previous cycle (often one that had just 500'd or timed out), wasting time.
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
- **Auto-conflict resolution**: Uses LLM tools to resolve merge conflicts automatically
- **Conflict prompt injection skip**: File-content injection is skipped for conflict-resolution prompts. *Why*: The conflict prompt already embeds each file; re-injecting would duplicate content (e.g. CHANGELOG twice), blow prompt size, and cause 504s.
- **Large conflicted files (chunked embed)**: For files over ~30k chars with conflicts, only the conflict sections (with context) are embedded in the prompt, not the full file. *Why*: Full-file embed doubles prompt size and causes 504s; sections are enough for correct `<search>`/`<replace>` output.
- **Token auto-injection**: Ensures GitHub token is in remote URL for push authentication
- **CodeRabbit auto-trigger**: Detects manual mode and triggers review on startup if needed
- Batched commits with LLM-generated messages (not "fix review comments")

### Token & cost optimizations
- **Fix iterations default**: `--max-fix-iterations` defaults to `0` meaning *unlimited* — the fix loop runs until all issues are resolved or another exit (e.g. stalemate). *Why*: Previously 0 was used literally so the loop ran zero times; we now map 0 to "no cap" so the default behaves as documented.
- **Think-tag stripping**: Models like Qwen emit `<think>` reasoning blocks; we strip them from responses and ask Qwen not to emit them. *Why*: Saves ~30% output tokens and avoids breaking parsers that expect responses to start with "YES"/"NO".
- **Verifier rejection cap**: After the verifier rejects an issue twice (fix or ALREADY_FIXED claim), we dismiss it as "exhausted" and stop retrying. *Why*: Fixer/verifier stalemates otherwise loop indefinitely.
- **No-verified-progress exit**: After two consecutive push iterations with zero new verified fixes, we exit cleanly. *Why*: Same issues keep failing; re-run after manual edits or new bot comments.
- **Dismissal-comment pre-check**: Before calling the LLM to generate a "Note:" comment, we check a ±7 line window for an existing Note:/Review: comment, and also skip when the reason already describes a code change (already-fixed). *Why*: Avoids redundant LLM calls when a comment was already added or the fix is self-documenting.
- **Skip dismissal LLM for already-fixed**: We no longer call the LLM to generate a Note for issues dismissed as already-fixed; code/diff is self-documenting. *Why*: Audit showed 62% of dismissal LLM responses were EXISTING; skipping saves tokens.
- **Relax file constraint on retry**: When the fixer returns CANNOT_FIX/WRONG_LOCATION and mentions another file, we persist that path and allow it on the next attempt so the fixer can edit the correct file. *Why*: Prompts.log audit showed 7 identical 33k-char prompts for one cross-file issue; persisting the other file avoids burning all models and can resolve on retry.
- **Persisted dedup cache**: LLM dedup results are stored in state keyed by comment ID set; repeat runs with the same comments skip the dedup LLM step. *Why*: In-memory cache reset each run; persisting saves tokens and latency.
- **Wider batch snippets**: When context headroom ≥100k chars, batch verification uses 2500/3000 char limits per comment/code snippet (vs 2000/2000). *Why*: Reduces false positives from truncation.
- **Rotation by success rate**: Legacy model rotation orders models by persisted success rate (best first). *Why*: Low-success models no longer get tried before proven performers.
- **CodeRabbit analysis chain stripping**: Comment bodies are sanitized to remove CodeRabbit "Analysis chain" and "Script executed" blocks before analysis/fix prompts. *Why*: CodeRabbit embeds 5–15 shell runs per comment (~200–1500 chars each); the analyzer only needs the actual finding, not script output—saves ~30% on affected prompts.
- **No-op change skip**: Identical search/replace blocks from the fixer are skipped. *Why*: Prevents wasted verification and keeps file-change counts accurate.
- **Lesson caps for large batches**: When fixing 10+ issues at once, we cap global and per-file lessons so the prompt stays under ~100k chars. *Why*: Prevents gateway timeouts and prompt poisoning from oversized prompts.
- **LLM dedup only for 3+ issues**: The LLM dedup step runs only for files with at least 3 remaining issues after heuristic dedup. *Why*: For 2-comment files, heuristic grouping is enough; skipping the LLM saves tokens with no meaningful loss.
- **maxFixIterations 0 = unlimited**: `--max-fix-iterations 0` is treated as unlimited (not zero). *Why*: Without this, 0 meant zero iterations and the run did analysis-only with no fix attempts.
- **File injection by issue count & dynamic budget**: Injected file contents are chosen by how many issues reference each file (most first); total injection budget is tied to the model’s context cap. *Why*: Puts the injection cap toward files most likely to need search/replace; avoids overshooting small-context or underusing large-context models.
- **Rewrite escalation for non-injected files**: Files mentioned in the prompt but not injected (or with repeated S/R failures) are escalated to full-file rewrite. *Why*: When the model never saw file content, search/replace usually fails; asking for the full file avoids matching failures.

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
- **504/gateway timeout: two retries with backoff**: On 504 or request timeout, we retry up to twice with 10s then 20s delay. *Why*: Single retry was often insufficient for transient gateways; two retries give the gateway time to recover.
- **AAR exhausted list**: The After-Action Report lists every exhausted issue (path:line) so operators know which need human follow-up. *Why*: Exhausted issues were only summarized by count; listing them makes follow-up actionable.
- **Judge rule (NO when code already implements)**: Batch verification prompt instructs the judge to respond NO and cite code when the current code already addresses the review. *Why*: Reduces unnecessary ALREADY_FIXED fix attempts when the judge would otherwise say YES.
- **Model recommendation wording**: We ask "explain why these models in this order" instead of "brief reasoning". *Why*: Models echoed "brief reasoning" literally; the new wording yields actionable explanation.
- **Credential redaction in push logs**: All push and rebase error/debug output is sanitized so `https://token@host` is never logged. *Why*: Git errors can contain remote URLs with tokens; redacting prevents credential leakage.
- **Worktree-safe rebase detection**: Rebase-vs-merge and "rebase still in progress?" use a shared helper that resolves the real git dir when `.git` is a file (worktrees). *Why*: In worktrees the check would otherwise fail; one implementation keeps completeMerge and pull conflict loop correct.

## Installation

```bash
bun install
bun run build

# Run directly
bun dist/index.js <pr-url>

# Or link globally
bun link
prr --version  # See the cat!
```

## Configuration

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
# PRR_LLM_MODEL=gpt-5.2
# OPENAI_API_KEY=sk-xxxx

# Default fixer tool (rotates automatically when stuck)
# If not set, prr will auto-detect which tool is installed
# PRR_TOOL=cursor
```

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

# Keep work directory for inspection
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
| `--verbose` | on | Debug output |


**Note on `--no-*` options**: Commander.js handles these specially. `--no-commit` sets an internal flag to `false`, not a separate `noCommit` option. This is why you use `--no-commit` to disable committing (the default is to commit).

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

1. **Fetch Comments**: Gets all review comments via GitHub GraphQL API. Works with humans, bots (CodeRabbit, Copilot), or any reviewer.

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
- **Base branch merge**: PR conflicts with target branch (main/master)

**Why two attempts for code files?**
- Fixer tools are good at agentic changes but sometimes miss conflict markers
- Direct LLM API gives precise control for targeted resolution
- Second attempt catches what first attempt missed

**Why check both git status AND file contents?**
- Git might mark a file as resolved (not in `status.conflicted`)
- But file might still contain `<<<<<<<` markers if tool staged prematurely
- Double-check catches false positives

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

- Location: `~/.prr/work/<hash>`
- Hash is based on `owner/repo#number` - same PR reuses same directory
- Cleaned up by default on success
- Use `--keep-workdir` to preserve for debugging

## State File

State is persisted in `<workdir>/.pr-resolver-state.json`:

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
2. **User content safe**: CLAUDE.md's existing content isn't touched
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

Model names change over time — use `agent models`, `cursor-agent --list-models`, or `curl https://api.cursor.com/v0/models` for the canonical list. The table below shows **example** models; actual availability depends on your Cursor account/plan:

| Model | Notes |
|-------|-------|
| `auto` | Let Cursor pick |
| `claude-4-opus-thinking` | Claude Opus (thinking) |
| `claude-4-sonnet-thinking` | Claude Sonnet (thinking) |
| `o3` | OpenAI reasoning |
| `gpt-5` | GPT-5 |

**Model rotation strategy**: prr interleaves model families for better coverage:


```text
Round 1: claude-4-opus-thinking (Claude) → gpt-5 (GPT) → o3 (OpenAI)
Round 2: claude-4-sonnet-thinking (Claude) → gpt-4.1 (GPT) → grok-2 (Other)
... then next tool ...
// Review: interleaving models enhances diversity in responses, reducing similar failure patterns.
```


*Why interleave families?* Same-family models often fail the same way. If Claude Sonnet can't fix something, Claude Opus probably can't either. But GPT might succeed.

```bash
# Example: override model (bypasses rotation)
prr https://github.com/owner/repo/pull/123 --model claude-4-opus-thinking

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

## License

MIT with one condition:

**Hours Saved Clause**: By using this tool, you agree to track the hours saved from not manually addressing PR review comments. Post your hours saved (with optional war stories) in a GitHub issue:

→ [Report Hours Saved](https://github.com/elizaOS/prr/issues/new?title=Hours+Saved&labels=hours-saved&body=Hours+saved:%0A%0AStory+(optional):)

We're building the case that cats sitting on PRs is a valid engineering strategy. 🐱
