# prr (PR Resolver)

```
    /\_____/\
   /  o   o  \
  ( ==  ^  == )
   )         (
  (           )
 ( (  )   (  ) )
(__(__)___(__)__)
```

CLI tool to automatically resolve LLM review bot comments on PRs using LLM-powered fixing and verification.

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

# Bot usernames to look for (comma-separated)
# Defaults to: copilot, coderabbitai, sourcery-ai, codiumai
PRR_BOT_USERS=copilot,coderabbitai
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

1. **Fetch Comments**: Gets all LLM review bot comments from the PR via GitHub GraphQL API (supports Copilot, CodeRabbit, Sourcery, etc.)

2. **Detect Unresolved**: For each comment, asks the verification LLM: "Is this issue still present in the code?" Skips issues already marked as fixed in state.

3. **Generate Prompt**: Builds a fix prompt including:
   - All unresolved issues with code context
   - "Lessons learned" from previous attempts to prevent flip-flopping

4. **Run Fixer**: Executes Cursor CLI or opencode with the prompt in the cloned repo

5. **Verify Fixes**: For each changed file, asks the verification LLM: "Does this diff address the concern?" Updates state accordingly.

6. **Commit**: Squashes all changes into a single commit with descriptive message

7. **Push (optional)**: In `--auto-push` mode, pushes and waits for bots to re-review, then loops

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

- Node.js >= 18
- `cursor` CLI (if using Cursor) or `opencode` CLI (if using opencode)
- GitHub personal access token with `repo` scope
- Anthropic or OpenAI API key for verification

## License

MIT
