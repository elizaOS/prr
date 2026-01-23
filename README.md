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

- Fetches GitHub Copilot review comments from PRs
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
PRR_LLM_MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-xxxx

# Or use OpenAI
# PRR_LLM_PROVIDER=openai
# PRR_LLM_MODEL=gpt-4o
# OPENAI_API_KEY=sk-xxxx

# Default fixer tool
PRR_TOOL=cursor

```

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

# All options
prr https://github.com/owner/repo/pull/123 \
  --tool cursor \
  --auto-push \
  --max-fix-iterations 10 \
  --max-push-iterations 3 \
  --poll-interval 120 \
  --keep-workdir \
  --verbose
```

## How It Works

1. **Fetch Comments**: Gets all review comments from the PR via GitHub GraphQL API (from humans, bots, any reviewer)

2. **Detect Unresolved**: For each comment, asks the verification LLM: "Is this issue still present in the code?" Skips issues already marked as fixed in state.

3. **Generate Prompt**: Builds a fix prompt including:
   - All unresolved issues with code context
   - "Lessons learned" from previous attempts to prevent flip-flopping

4. **Run Fixer**: Executes Cursor CLI or opencode with the prompt in the cloned repo

5. **Verify Fixes**: For each changed file, asks the verification LLM: "Does this diff address the concern?" Updates state accordingly.

6. **Commit**: Squashes all changes into a single commit with descriptive message

7. **Push (optional)**: In `--auto-push` mode, pushes and waits for reviewers, then loops

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
# Install cursor-agent
curl https://cursor.com/install -fsS | bash

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
| `claude-4-opus-thinking` | Claude 4 Opus with extended thinking | Complex fixes, best quality |
| `claude-4-sonnet-thinking` | Claude 4 Sonnet with extended thinking | Good balance with reasoning |
| `claude-4-sonnet` | Claude 4 Sonnet | Quick fixes |
| `o3` | OpenAI o3 reasoning model | Complex multi-step reasoning |
| `gpt-5.2` | GPT-5.2 | Fast, capable |
| `grok` | Grok | Alternative perspective |
| `auto` | Auto-select | Let Cursor decide |

```bash
# Example: use a faster model for simple fixes
prr https://github.com/owner/repo/pull/123 --model claude-4-sonnet

# Example: max power for complex issues
prr https://github.com/owner/repo/pull/123 --model claude-4-opus-thinking
```

## License

MIT with one condition:

**Hours Saved Clause**: By using this tool, you agree to track the hours saved from not manually addressing PR review comments. Post your hours saved (with optional war stories) in a GitHub issue:

→ [Report Hours Saved](https://github.com/elizaOS/prr/issues/new?title=Hours+Saved&labels=hours-saved&body=Hours+saved:+%0A%0AStory+(optional):+)

We're building the case that cats sitting on PRs is a valid engineering strategy. 🐱
