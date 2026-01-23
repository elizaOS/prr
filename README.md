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

## Features

- Fetches review comments from PRs (humans, bots, or any reviewer)
- Uses LLM to detect which issues still exist in the code
- Generates fix prompts and runs Cursor CLI or opencode to fix issues
- Verifies fixes with LLM to prevent false positives
- Tracks "lessons learned" to prevent flip-flopping between solutions
- Batched commits to avoid flooding git history
- Hash-based work directories for efficient re-runs

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
| `--auto-push` | off | Push after fixes verified, wait for re-review, loop |
| `--max-fix-iterations <n>` | unlimited | Max fix attempts per push cycle |
| `--max-push-iterations <n>` | unlimited | Max push/re-review cycles |
| `--poll-interval <sec>` | 120 | Seconds to wait for re-review |
| `--max-context <chars>` | 400000 | Max chars per LLM batch (~100k tokens) |
| `--reverify` | off | Re-check all cached "fixed" issues |
| `--dry-run` | off | Show issues without fixing |
| `--no-commit` | on | Don't commit (for testing) |
| `--commit` | off | Actually commit (override --no-commit) |
| `--no-push` | on | Don't push (safer testing) |
| `--keep-workdir` | on | Keep work directory after completion |
| `--no-batch` | off | Disable batched LLM calls |
| `--verbose` | on | Debug output |

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
   - "Lessons learned" from previous failed attempts
   - *Why lessons*: Prevents flip-flopping. If attempt #1 tried X and it was rejected, attempt #2 knows not to try X again.

4. **Run Fixer**: Executes the AI coding tool in the cloned repo.
   - Rotates through models (claude-4-sonnet-thinking → gpt-5.2 → claude-4-opus-thinking) when stuck
   - Rotates through tools (Cursor → Claude Code → Aider) when models exhausted
   - *Why rotation*: Different models have different strengths. If one gets stuck, another might succeed.

5. **Verify Fixes**: For each changed file, asks the LLM: "Does this diff address the concern?"
   - *Why verify*: Fixer tools can make changes that don't actually fix the issue. Catches false positives early.

6. **Final Audit**: Before declaring "done", re-verifies ALL issues with a stricter adversarial prompt.
   - *Why*: Verification cache can have stale entries from previous runs. The audit clears the cache and re-checks everything.
   - *Why adversarial*: Regular verification is lenient. The audit assumes fixes might be incomplete and demands evidence.

7. **Commit**: Generates a clean commit message via LLM describing the actual changes (not "fix review comments").
   - *Why LLM-generated*: Commit messages are permanent history. They should describe WHAT changed, not the review process.

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
  "lessonsLearned": [
    "Attempted try/catch but issue requires early return",
    "The validateUser function must preserve backward compatibility"
  ],
  "verifiedFixed": ["comment_id_1", "comment_id_2"]
}
```

## Requirements

**Runtime:**
- Node.js >= 18 (or Bun)

**GitHub Access:**
- GitHub personal access token with `repo` scope (`GITHUB_TOKEN`)

**LLM API Keys** (for verification and some runners):
- `ANTHROPIC_API_KEY` - Required for verification (if using Anthropic), and for `claude-code`, `aider`, `llm-api` runners
- `OPENAI_API_KEY` - Required for verification (if using OpenAI), and for `codex`, `aider`, `llm-api` runners

**Fixer Tools** (at least one required, use `--tool <name>`):
- `--tool cursor`: `cursor-agent`
- `--tool opencode`: `opencode`
- `--tool aider`: `aider`
- `--tool claude-code`: `claude` or `claude-code`
- `--tool codex`: OpenAI Codex access
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
# Install cursor-agent (pick the right OS/arch)
uname -s
uname -m

# macOS ARM64
curl -fsSL https://www.cursor.com/download/stable/agent/darwin/arm64 -o cursor-agent
# macOS AMD64 (Intel)
curl -fsSL https://www.cursor.com/download/stable/agent/darwin/amd64 -o cursor-agent
# Linux AMD64
curl -fsSL https://www.cursor.com/download/stable/agent/linux/amd64 -o cursor-agent
# Linux ARM64
curl -fsSL https://www.cursor.com/download/stable/agent/linux/arm64 -o cursor-agent

chmod +x cursor-agent
sudo mv cursor-agent /usr/local/bin/

# For other platforms, visit: https://www.cursor.com/download

# Login (required before first use!)
cursor-agent login

# Verify installation and list available models
cursor-agent --list-models
```

This opens a browser window to authenticate with your Cursor account. You only need to do this once - your credentials are saved locally.

Without logging in first, you'll see authentication errors when prr tries to run the fixer.

**Available models** (use with `--model`, verify with `cursor-agent --list-models`):

| Model | Description | Best for |
|-------|-------------|----------|
| `claude-4-sonnet-thinking` | Claude 4 Sonnet (thinking) | Default, balanced |
| `claude-4-opus-thinking` | Claude 4 Opus (thinking) | Complex fixes, best quality |
| `o3` | OpenAI o3 | Fast reasoning |
| `gpt-5.2` | GPT-5.2 | Great for coding |
| `Grok` | Grok | xAI model |
| `auto` | Auto-select | Let Cursor decide |

**Model rotation**: When stuck, prr automatically rotates through models:

```text
claude-4-sonnet-thinking → gpt-5.2 → claude-4-opus-thinking → o3
```

```bash
# Example: use a faster model for simple fixes
prr https://github.com/owner/repo/pull/123 --model o3

# Example: max power for complex issues  
prr https://github.com/owner/repo/pull/123 --model claude-4-opus-thinking

# Let prr rotate through models automatically (recommended)
prr https://github.com/owner/repo/pull/123
```

## License

MIT with one condition:

**Hours Saved Clause**: By using this tool, you agree to track the hours saved from not manually addressing PR review comments. Post your hours saved (with optional war stories) in a GitHub issue:

→ [Report Hours Saved](https://github.com/elizaOS/prr/issues/new?title=Hours+Saved&labels=hours-saved&body=Hours+saved:+%0A%0AStory+(optional):+)

We're building the case that cats sitting on PRs is a valid engineering strategy. 🐱
