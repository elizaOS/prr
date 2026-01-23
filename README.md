# prr (PR Resolver)

```
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

- Fetches review comments from PRs (humans, bots, or any reviewer)
- Uses LLM to detect which issues still exist in the code
- Generates fix prompts and runs Cursor CLI or opencode to fix issues
- Verifies fixes with LLM to prevent false positives
- **Final audit**: Adversarial re-verification of ALL issues before declaring done
- Tracks "lessons learned" to prevent flip-flopping between solutions
- **LLM-powered failure analysis**: Learns from rejected fixes to avoid repeating mistakes
- **Smart model rotation**: Interleaves model families (Claude → GPT → Gemini) for better coverage
- **Dynamic model discovery**: Auto-detects available models for each fixer tool
- **Auto-stashing**: Handles interrupted runs gracefully by stashing/restoring local changes
- Batched commits with LLM-generated messages (not "fix review comments")
- Hash-based work directories for efficient re-runs
- **State persistence**: Resumes from where it left off, including tool/model rotation position

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
PRR_LLM_MODEL=claude-sonnet-4.5
ANTHROPIC_API_KEY=sk-ant-xxxx

# Or use OpenAI
# PRR_LLM_PROVIDER=openai
# PRR_LLM_MODEL=gpt-5.2
# OPENAI_API_KEY=sk-xxxx

# Default fixer tool (rotates automatically when stuck)
PRR_TOOL=cursor
```

### Why These Defaults?

- **Claude Sonnet 4.5** for verification: Best balance of accuracy and speed. Opus is overkill for yes/no verification. Haiku misses edge cases.
- **Cursor** as default fixer: Most capable agentic coding tool. Falls back to others automatically.

## Usage

```bash
# Basic usage - fix locally, don't push
prr https://github.com/owner/repo/pull/123

# Shorthand syntax
prr owner/repo#123

# Auto-push mode - full automation loop
prr https://github.com/owner/repo/pull/123 --auto-push

# Use specific fixer tool
prr https://github.com/owner/repo/pull/123 --tool opencode

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
      "verifiedAtIteration": 5,
      "passed": true,
      "reason": "The null check was added at line 45"
    }
  ],
  "currentRunnerIndex": 0,
  "modelIndices": { "cursor": 2, "llm-api": 0 }
}
```

**Why these fields:**
- `verifiedComments`: Tracks WHEN each verification happened (not just what). Enables verification expiry.
- `currentRunnerIndex`: Resume from the same tool after interruption. Prevents restarting rotation from scratch.
- `modelIndices`: Per-tool model position. If Cursor was on model #2, resume there.

**Why not just store tool/model names?** Indices are resilient to model list changes. If we add new models, existing indices still work.

## Requirements

**Runtime:**
- Node.js >= 18 (or Bun)

**GitHub Access:**
- GitHub personal access token with `repo` scope (`GITHUB_TOKEN`)

**LLM API Keys** (for verification and some runners):
- `ANTHROPIC_API_KEY` - Required for verification (if using Anthropic), and for `claude-code`, `aider`, `llm-api` runners
- `OPENAI_API_KEY` - Required for verification (if using OpenAI), and for `codex`, `aider`, `llm-api` runners

**Fixer CLI Tools** (depending on `--tool` option; at least one required):
- `--tool cursor`: `cursor-agent`
- `--tool opencode`: `opencode`
- `--tool aider`: `aider`
- `--tool claude-code`: `claude` or `claude-code`
- `--tool codex`: `codex` or `openai-codex` (OpenAI Codex access)
- `--tool llm-api`: no CLI (direct API)

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
# Install cursor-agent (official installer - works on all platforms)
curl https://cursor.com/install -fsS | bash

# Login (required before first use!)
cursor-agent login

# Verify installation and list available models
cursor-agent models
```

This opens a browser window to authenticate with your Cursor account. You only need to do this once - your credentials are saved locally.

Without logging in first, you'll see authentication errors when prr tries to run the fixer.

**Dynamic Model Discovery**: prr automatically discovers available models by running `cursor-agent models` on startup. No hardcoded model lists to maintain.

**Model rotation strategy**: prr interleaves model families for better coverage:

```text
Round 1: sonnet-4.5 (Claude) → gpt-5.2 (GPT) → gemini-3-pro (Gemini)
Round 2: opus-4.5-thinking (Claude) → gpt-5.2-high (GPT) → gemini-3-flash (Gemini)
... then next tool ...
```

*Why interleave families?* Same-family models often fail the same way. If Claude Sonnet can't fix something, Claude Opus probably can't either. But GPT might succeed.

```bash
# Example: override model (bypasses rotation)
prr https://github.com/owner/repo/pull/123 --model opus-4.5-thinking

# Let prr rotate through models automatically (recommended)
prr https://github.com/owner/repo/pull/123
```

## License

MIT with one condition:

**Hours Saved Clause**: By using this tool, you agree to track the hours saved from not manually addressing PR review comments. Post your hours saved (with optional war stories) in a GitHub issue:

→ [Report Hours Saved](https://github.com/elizaOS/prr/issues/new?title=Hours+Saved&labels=hours-saved&body=Hours+saved:%0A%0AStory+(optional):)

We're building the case that cats sitting on PRs is a valid engineering strategy. 🐱
