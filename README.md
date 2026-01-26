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
- Generates fix prompts and runs Cursor CLI, Claude Code, or opencode to fix issues
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

# Default fixer tool (cursor, claude-code, or opencode)
# If not set, prr will auto-detect which tool is installed
PRR_TOOL=cursor

# Bot usernames to look for (comma-separated, matched as substrings)
# Defaults to: copilot, coderabbitai, greptile, codex-connector, sourcery, codiumai
# PRR_BOT_USERS=copilot,coderabbitai,greptile
```

## Supported Bots

Out of the box, prr detects comments from:

- **GitHub Copilot** (`Copilot`, `copilot-pull-request-reviewer[bot]`)
- **CodeRabbit** (`coderabbitai[bot]`)
- **Greptile** (`greptile-apps[bot]`)
- **ChatGPT Codex** (`chatgpt-codex-connector[bot]`)
- **Sourcery** (`sourcery-ai[bot]`)
- **CodiumAI/Qodo** (`codiumai[bot]`)

Add custom bots via `PRR_BOT_USERS` env var (comma-separated, matched as substrings).

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

## CLI Tool Detection

**WHY auto-detection?** Most developers have only one LLM CLI tool installed. Auto-detection means you can just run `prr` without needing to configure which tool you have - it figures it out automatically and works out of the box.

prr automatically detects which CLI tool you have installed:

### Auto-detection (default)

If you don't specify `--tool` or `PRR_TOOL`, prr checks in this order:
1. `cursor` (Cursor CLI)
2. `claude` or `cc` (Claude Code CLI)
3. `opencode` (OpenCode CLI)

It uses the first one it finds and tells you:
```
Auto-detected CLI tool: claude-code
```

**WHY this order?**
- **cursor** first: Most widely adopted, battle-tested
- **claude-code** second: Anthropic's native tool, often better Claude integration
- **opencode** third: Newer/less common, but fully supported

### Explicit selection

Use `--tool <name>` or `PRR_TOOL=<name>` to force a specific tool:

```bash
prr pr-url --tool claude-code
# or
PRR_TOOL=claude-code prr pr-url
```

**WHY specify explicitly?**
- You have multiple tools installed and want to control which one is used
- You want consistent behavior across different environments
- You want clearer error messages if the expected tool is missing
- You're comparing behavior across different tools

**Note:** Explicit mode will error if the tool isn't available (no fallback). This is intentional - it respects your explicit choice rather than silently using something else.

## How It Works

1. **Fetch Comments**: Gets all LLM review bot comments from the PR via GitHub GraphQL API (supports Copilot, CodeRabbit, Sourcery, etc.)

2. **Detect Unresolved**: For each comment, asks the verification LLM: "Is this issue still present in the code?" Skips issues already marked as fixed in state.

3. **Generate Prompt**: Builds a fix prompt including:
   - All unresolved issues with code context
   - "Lessons learned" from previous attempts to prevent flip-flopping

4. **Run Fixer**: Executes Cursor CLI, Claude Code, or opencode with the prompt in the cloned repo

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

## Choosing a CLI Tool

You need at least one of these installed:

| Tool | Command | Best For |
|------|---------|----------|
| **Cursor CLI** | `cursor` | Users already using Cursor IDE, most battle-tested |
| **Claude Code** | `claude` or `cc` | Native Anthropic experience, often better Claude model integration |
| **OpenCode** | `opencode` | Alternative open-source option |

**WHY the difference?** Each tool uses Claude (or other LLMs) differently:
- **Cursor**: Part of the Cursor IDE ecosystem, well-integrated if you're already using it
- **Claude Code**: Official Anthropic CLI, direct access to latest Claude features
- **OpenCode**: Community-driven alternative with different UX/features

**Don't know which to choose?** Install Claude Code (`claude`) if you're new - it's Anthropic's official tool and works well out of the box.

## Requirements

- Node.js >= 18
- At least one CLI tool (see table above)
- GitHub personal access token with `repo` scope
- Anthropic or OpenAI API key for verification

## License

MIT
