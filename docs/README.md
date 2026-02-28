# PRR Documentation Index

Welcome to the PRR documentation! This directory contains comprehensive guides and flowcharts explaining how the PR Resolver system works. We document **why** design choices were made (not just what) so you can revisit decisions and avoid regressions — see also the main [README](../README.md) philosophy.

---

## 📚 Documentation Structure

### 🎯 [Quick Reference Guide](QUICK_REFERENCE.md)
**Best for**: Getting started quickly or looking up common patterns

**Contains**:
- One-page workflow overview
- Visual system diagram
- Common use cases
- Configuration tips
- Troubleshooting guide
- Success metrics explained

**Read this if**: You want to understand PRR at a glance or need quick answers.

---

### 🔄 [Flowchart Documentation](flowchart.md)
**Best for**: Understanding the detailed workflow and control flow

**Contains**:
- Main system flow (entry to exit)
- Orchestrator outer loop (push iterations)
- Push iteration inner loop (fix cycles)
- Fix iteration details (single attempt)
- Escalation strategy (when fixes fail)
- State management visualization
- LLM usage points
- Error recovery flows
- Tool integration architecture
- Performance optimizations explained

**Read this if**: You want to understand the step-by-step execution flow and decision points.

---

### 📉 Audit Improvements
Token-saving, exit-logic, and fix-loop improvements are documented in the [CHANGELOG](../CHANGELOG.md) under "Audit improvements" and "Output.log audit" headings.

**Output.log audit follow-up (2026-02)** — rebase detection, push retry, non-interactive rebase:
- **Rebase detection**: `completeMerge` and the pull conflict loop use `--show-toplevel` to get the repo root so `.git/rebase-merge` is checked with an absolute path. **WHY**: Relative `.git` was resolved against process cwd, not the PRR workdir, so we often ran `commit` during a rebase and left `.git/rebase-merge` behind.
- **Push retry cleanup**: On failed fetch+rebase after push rejection, we try `rebase --abort` first, then `cleanupGitState` only if abort fails. **WHY**: Abort keeps commits; full cleanup is for stale state so the next run doesn’t hit "rebase-merge directory already exists".
- **Non-interactive rebase continue**: All `rebase --continue` calls go through `continueRebase(git)` in `git-merge.ts`, which sets `GIT_EDITOR=true` before running rebase. **WHY**: In headless/workdir there’s no TTY; the configured editor fails ("Standard input is not a terminal" / "problem with the editor 'editor'"). One helper keeps behavior consistent.
- **Dead code**: Removed unused `src/git/clone.ts`; clone/merge logic lives in `git-clone-core`, `git-merge`, and `git-lock-files` (see CHANGELOG "Fixed — Rebase detection, push retry cleanup").

**Output.log audit (2026-02)** — model and prompt behavior:
- **Model rotation & skip list**: Default llm-api/elizacloud lists ordered by fix success; models that 500/timeout or have 0% fix rate are in `ELIZACLOUD_SKIP_MODELS` and never selected. **WHY**: Reduces wasted rotation slots and improves throughput.
- **File injection**: Inject files by issue count (most first) and tie injection budget to model context cap. **WHY**: Better S/R success when cap is tight; avoids overshooting small-context or underusing large-context models.
- **Rewrite escalation**: Escalate to full-file rewrite for files not injected (LLM never saw content) or with repeated S/R failures. **WHY**: Avoids S/R matching failures when the model has no file content to copy from.
- **Duplicate prompt hash**: Use issue IDs + lesson count instead of full prompt so same-issues-same-context skips to rotation. **WHY**: Full-prompt hash rarely matched; avoids redundant LLM calls.
- **Proportional batch reduce**: Reduce batch by `cap/promptLength` instead of halving. **WHY**: Converges in 1–2 iterations instead of many.
- **504 retries**: Two retries with 10s/20s backoff. **WHY**: Transient gateways get a chance to recover.
- **AAR exhausted list**: List `path:line` for all exhausted issues in the After-Action Report. **WHY**: Makes human follow-up actionable.

**Prompts.log audit (2026-02)** — conflict prompt size and large-file embedding:
- **Skip file injection for conflict prompts**: In `injectFileContents` (llm-api), prompts starting with `MERGE CONFLICT RESOLUTION` are returned unchanged (no file injection). **WHY**: The conflict prompt builder already embeds each file; re-injecting would duplicate content (e.g. CHANGELOG twice), causing 140k+ char prompts and 504s.
- **Chunked embed for large conflicted files**: For files over 30k chars with conflict markers, only conflict sections (with 7 lines context) are embedded; section headers show the actual line range; instructions tell the LLM to use the plain file path in `<change path="...">`. **WHY**: Full-file embed doubled prompt size and caused 504s; sections are enough for correct search/replace blocks.
- **Conflict model fallback and context cap**: When `getCurrentModel()` is undefined (e.g. setup phase), Attempt 2 falls back to `DEFAULT_ELIZACLOUD_MODEL` for ElizaCloud; "file too large" uses the effective model’s context limit. **WHY**: Avoids weak default (qwen-3-14b) that may 504; correct limit prevents wrongly skipping files that fit the actual model’s window.

**Prompts.log audit follow-up (2026-02)** — relax file constraint, dismissal skip, judge rule, model recommendation:
- **Relax file constraint**: When the fixer returns CANNOT_FIX/WRONG_LOCATION and mentions another file, we persist that path in `wrongFileAllowedPathsByCommentId` and merge it into `allowedPaths` on the next attempt so the fixer can edit the correct file. **WHY**: Audit showed 7 identical 33k-char prompts for one cross-file issue; persisting the other file avoids burning all models and can resolve the issue on retry.
- **Skip dismissal LLM for already-fixed**: We no longer call the LLM to generate a Note for `already-fixed` issues; code/diff is self-documenting. **WHY**: 62% of dismissal LLM responses were EXISTING; skipping saves tokens.
- **Judge rule**: Verification prompt now says "If the Current Code already implements what the review asks for, respond NO and cite the specific code." **WHY**: Reduces unnecessary ALREADY_FIXED fix attempts when the judge would otherwise say YES.
- **Model recommendation wording**: Prompt asks "explain why these models in this order" instead of "brief reasoning". **WHY**: Models echoed "brief reasoning" literally; the new wording yields actionable explanation.

**Security & cleanup (2026-02)** — credential redaction, worktree, conflict-resolve, commit:
- **Credential redaction**: All push and rebase error/debug logs in `git-push.ts` use `redactUrlCredentials()` so `https://token@...` is never logged. **WHY**: Git stderr and error messages can contain remote URLs with tokens; redacting prevents credential leakage.
- **Worktree rebase detection**: `getResolvedGitDir(git)` in git-merge.ts resolves the real git dir when `.git` is a file (worktree); used by `completeMerge` and the pull conflict loop in repository.ts. **WHY**: In worktrees the rebase-merge check would otherwise fail; one shared helper keeps behavior correct and consistent.
- **Sync target log**: "Removed sync target created by prr" is logged only when `git.rm` or fallback `git.add` succeeds. **WHY**: Avoids reporting success when both failed.
- **commit.ts**: Duplicate broken push/pushWithRetry code removed; file re-exports from git-push.ts. **WHY**: Single source of truth; fixes parse errors from mangled duplicate.

**Earlier audit items**: Dismissal-comment pre-check radius, no-op search/replace skip, lesson caps, dedup threshold, commit wording, think-tag stripping, verifier rejection cap, no-verified-progress exit — see CHANGELOG for full list and WHYs.

**Read this if**: You want to know why we reorder models, skip certain models, inject files by issue count, escalate to full-file rewrite, skip injection for conflict prompts, or embed only conflict sections for large files.

---

### 🤖 [Models Reference](MODELS.md)
**Best for**: Choosing or configuring LLM models, updating context limits

**Contains**:
- Claude (Anthropic) current and legacy models, API IDs, context windows, pricing
- OpenAI frontier and specialized models, Codex-optimized IDs
- How PRR uses this (e.g. `model-context-limits.ts`)

**Read this if**: You're adding a new model, tuning context limits, or checking provider IDs. Sourced from [Claude](https://platform.claude.com/docs/en/about-claude/models/overview) and [OpenAI](https://developers.openai.com/api/docs/models) docs.

---

### 🏗️ [Architecture Guide](ARCHITECTURE.md)
**Best for**: Contributors, maintainers, or deep technical understanding

**Contains**:
- High-level system architecture
- Directory structure and file purposes
- Key design patterns
- Data flow diagrams
- Critical performance optimizations
- Error handling & resilience strategies
- Extension points (how to add new tools/LLMs)
- Testing strategy
- Configuration reference
- Monitoring & observability
- Security considerations
- Future enhancements

**Read this if**: You're contributing code, extending functionality, or need to understand the design rationale.

---

## 🗺️ Documentation Map

```text
docs/
├── README.md (this file)           ← Start here
│
├── QUICK_REFERENCE.md              ← Quick start & common patterns
│   ├─ One-page workflow
│   ├─ Visual architecture
│   ├─ The fix loop (detailed)
│   ├─ Smart features
│   ├─ Common use cases
│   └─ Troubleshooting
│
├── flowchart.md                    ← Detailed flowcharts
│   ├─ Main system flow
│   ├─ Orchestrator loop
│   ├─ Push iteration loop
│   ├─ Fix iteration details
│   ├─ Escalation strategy
│   ├─ State management
│   ├─ LLM usage points
│   └─ Error recovery
│
├── MODELS.md                       ← Claude & OpenAI models reference
│   ├─ Latest & legacy Claude
│   ├─ OpenAI frontier & specialized
│   └─ PRR context limits usage
│
└── ARCHITECTURE.md                 ← Technical deep-dive
    ├─ System architecture
    ├─ Directory structure
    ├─ Design patterns
    ├─ Data flows
    ├─ Performance optimizations
    ├─ Extension points
    └─ Testing & security
```

---

## 🎓 Learning Path

### For End Users

1. **Start**: Read the [main README](../README.md) for what PRR does
2. **Quick Start**: Use [Quick Reference](QUICK_REFERENCE.md) for common patterns
3. **Deep Dive**: Check [Flowcharts](flowchart.md) to understand the workflow
4. **Troubleshoot**: Refer back to Quick Reference troubleshooting section

### For Contributors

1. **Start**: Read the [main README](../README.md)
2. **Workflow**: Study [Flowcharts](flowchart.md) to understand execution flow
3. **Architecture**: Read [Architecture Guide](ARCHITECTURE.md) for design patterns
4. **Code**: Explore the codebase with architectural context
5. **Extend**: Use extension points in Architecture Guide
6. **Test**: Follow testing strategy in Architecture Guide

### For Maintainers

1. **All above** + 
2. **Development Guide**: Read [DEVELOPMENT.md](../DEVELOPMENT.md) for conventions
3. **Changelog**: Review [CHANGELOG.md](../CHANGELOG.md) for evolution history
4. **Performance**: Study optimizations in Architecture Guide
5. **Monitoring**: Set up observability per Architecture Guide

---

## 📖 Key Concepts Explained

### Recent improvements (rotation, batch reduce, injection, no-changes)

- **Rotation reset**: At the start of each push iteration (after the first), the model index resets to the first in rotation. *Why*: The previous cycle often ended on a model that had just 500'd or timed out; retrying it first wastes time.
- **Large-prompt batch reduce**: When a fix prompt exceeds ~200k chars and fails (error or no-changes), the next fix iteration uses a smaller batch immediately. *Why*: Oversized prompts cause gateway 500s/timeouts; reducing batch size keeps prompts within limits.
- **Injection cap with floor**: Base + injected file content is capped (e.g. 200k total) with a minimum injection allowance so key files are still injected when the base is large. *Why*: Prevents 500s from oversized requests and avoids zero injection when base is already big.
- **No-changes parsing**: The NO_CHANGES explanation is parsed from prose only; content inside `<change>`, `<newfile>`, and `<file>` blocks is stripped first. *Why*: Code or fixtures inside those blocks can contain phrases like "already fixed", causing false positives.
- **Line-number stripping**: When matching search/replace from LLM output, only the injected line format `N | ` is stripped from each line, not arbitrary leading digits. *Why*: Injected file content is numbered; some LLMs echo that in `<search>`/`<replace>`. Stripping only `N | ` allows matches without corrupting real code.

See [CHANGELOG](../CHANGELOG.md) (Unreleased → Added 2026-02) for full WHYs and file references.

### The Three Loops

```text
┌─────────────────────────────────────────────────────────┐
│ OUTER LOOP (Run Orchestrator)                          │
│  • Purpose: Handle multiple push iterations            │
│  • Scope: Entire PR resolution workflow                │
│  • Exits: When all fixed or max push iterations        │
│  │                                                      │
│  │  ┌───────────────────────────────────────────────┐  │
│  │  │ PUSH ITERATION LOOP                           │  │
│  │  │  • Purpose: Single push cycle                 │  │
│  │  │  • Scope: Fetch → Fix → Verify → Push         │  │
│  │  │  • Exits: After push or bail-out              │  │
│  │  │  │                                            │  │
│  │  │  │  ┌─────────────────────────────────────┐  │  │
│  │  │  │  │ FIX ITERATION LOOP                  │  │  │
│  │  │  │  │  • Purpose: Single fix attempt      │  │  │
│  │  │  │  │  • Scope: Build → Run → Verify      │  │  │
│  │  │  │  │  • Exits: When fixed or max iters   │  │  │
│  │  │  │  └─────────────────────────────────────┘  │  │
│  │  │  │                                            │  │
│  │  └──┴────────────────────────────────────────────┘  │
│  │                                                      │
└──┴──────────────────────────────────────────────────────┘
```

### The Escalation Strategy

When fixes fail, PRR doesn't give up—it escalates:

```text
1. Batch Mode (optimistic)
   └─ Try fixing 50 issues at once

2. Adaptive Batching (progressive)
   └─ Halve batch size: 50 → 25 → 12 → 6 → 5

3. Single-Issue Mode (focused)
   └─ Pick 1-3 random issues for narrow context

4. Model Rotation (diversity)
   └─ Claude → GPT → Gemini (different families)

5. Tool Rotation (alternative)
   └─ cursor → claude-code → aider → gemini → ...

6. Direct LLM API (last resort)
   └─ Bypass tool wrappers, use API directly

7. Bail Out (graceful)
   └─ Commit partial progress, request human help
```

### State Management

PRR maintains state across interruptions:

```json
{
  "pr": "owner/repo#123",
  "iterations": [...],
  "commentStatuses": {
    "comment_123": {
      "status": "open",
      "classification": "exists",
      "fileContentHash": "abc123",
      "importance": 4,
      "ease": 3
    }
  },
  "verifiedFixed": ["comment_456"],
  "dismissedIssues": [
    {
      "commentId": "comment_789",
      "reason": "Already implemented via guard clause",
      "dismissedAt": "2026-02-25T00:00:00Z",
      "dismissedAtIteration": 3,
      "category": "already-fixed",
      "filePath": "src/example.ts",
      "line": 42,
      "commentBody": "Add null check"
    }
  ],
  "lessonsLearned": [...],
  "currentRunnerIndex": 2,
  "modelIndices": { "cursor": 3, "aider": 1 },
  "noProgressCycles": 0
}
```

**Why this matters**:
- Resume after Ctrl+C
- Skip redundant LLM analysis (caching)
- Track what was tried (lessons)
- Continue rotation from where it stopped

---

## 🎯 Common Questions

### Q: Which document should I read first?
**A**: Depends on your goal:
- **Just want to use PRR**: [Quick Reference](QUICK_REFERENCE.md)
- **Want to understand how it works**: [Flowcharts](flowchart.md)
- **Want to contribute or extend**: [Architecture](ARCHITECTURE.md)

### Q: How do I visualize the full workflow?
**A**: [Flowchart documentation](flowchart.md) has Mermaid diagrams showing:
- Main system flow
- Each loop in detail
- Decision points
- Error handling
- State changes

### Q: Where are the key files explained?
**A**: [Architecture Guide](ARCHITECTURE.md) has:
- Directory structure with file purposes
- Detailed description of each module
- Extension points for adding functionality

### Q: How do I troubleshoot issues?
**A**: [Quick Reference](QUICK_REFERENCE.md) has:
- Troubleshooting section
- Common problems & solutions
- How to read logs
- Exit reasons explained

### Q: What are the performance optimizations?
**A**: Both [Flowcharts](flowchart.md) and [Architecture](ARCHITECTURE.md) explain:
- Comment status caching
- Prefetched comments
- Two-phase deduplication
- Adaptive batch sizing
- Model family interleaving
- Spot-check verification

---

## 🔍 Finding Information

| I want to... | Document | Section |
|--------------|----------|---------|
| Understand the full workflow | [Flowcharts](flowchart.md) | All sections |
| See one-page overview | [Quick Reference](QUICK_REFERENCE.md) | System Overview |
| Learn common usage patterns | [Quick Reference](QUICK_REFERENCE.md) | Common Use Cases |
| Understand state management | [Flowcharts](flowchart.md) | State Management |
| Add a new AI tool | [Architecture](ARCHITECTURE.md) | Extension Points |
| Troubleshoot an issue | [Quick Reference](QUICK_REFERENCE.md) | Troubleshooting |
| Understand escalation | [Flowcharts](flowchart.md) | Escalation Strategy |
| See directory structure | [Architecture](ARCHITECTURE.md) | Directory Structure |
| Learn design patterns | [Architecture](ARCHITECTURE.md) | Key Design Patterns |
| Understand caching | [Architecture](ARCHITECTURE.md) | Performance Optimizations |
| Configure PRR | [Quick Reference](QUICK_REFERENCE.md) | Configuration Tips |
| Read success metrics | [Quick Reference](QUICK_REFERENCE.md) | Success Metrics |
| Choose or add LLM models / context limits | [Models Reference](MODELS.md) | Claude & OpenAI IDs, context, PRR usage |

---

## 🖼️ Visual Guides

All documents include visual diagrams:

### Flowchart Document
- ✅ Mermaid flowcharts (10+ diagrams)
- ✅ ASCII art workflows
- ✅ State machine diagrams
- ✅ Data flow visualizations

### Quick Reference
- ✅ ASCII workflow diagram
- ✅ System architecture
- ✅ Fix loop details
- ✅ Feature visualizations

### Architecture Guide
- ✅ Component diagram
- ✅ Directory tree
- ✅ Data flow paths
- ✅ Integration points

---

## 🛠️ Using These Docs

### Reading in GitHub
All Mermaid diagrams render automatically in GitHub's markdown viewer. Just browse the files.

### Reading Locally
Use a markdown viewer that supports Mermaid:
- VS Code with Markdown Preview Mermaid Support extension
- Obsidian
- Typora
- Or any Mermaid-compatible viewer

### Generating PDFs
```bash
# Install markdown-pdf or pandoc
npm install -g markdown-pdf

# Convert to PDF
markdown-pdf docs/flowchart.md
markdown-pdf docs/ARCHITECTURE.md
markdown-pdf docs/QUICK_REFERENCE.md
```

### Viewing in Browser
```bash
# Serve locally with live reload
npx live-server docs/

# Or use Python
cd docs && python3 -m http.server
```

---

## 🤝 Contributing to Docs

If you find errors or want to improve documentation:

1. **For typos/clarifications**: Submit a PR directly
2. **For new sections**: Discuss in an issue first
3. **For diagrams**: Use Mermaid syntax (compatible everywhere)
4. **For examples**: Keep them real-world and practical

**Doc style guide**:
- Use clear headings with emoji for visual hierarchy
- Include code examples where helpful
- Add ASCII/Mermaid diagrams for complex flows
- Link between documents (cross-reference related sections)
- Keep Quick Reference concise, Architecture detailed

---

## 📦 What's Where

```text
📁 prr/
│
├── 📄 README.md                  ← Project overview, features, installation
├── 📄 CHANGELOG.md               ← Version history, feature additions
├── 📄 DEVELOPMENT.md             ← Development guide, conventions
│
├── 📁 docs/                      ← **You are here**
│   ├── 📄 README.md              ← This index file
│   ├── 📄 QUICK_REFERENCE.md     ← Quick start & patterns
│   ├── 📄 flowchart.md           ← Detailed flowcharts
│   ├── 📄 MODELS.md              ← Claude & OpenAI models reference
│   └── 📄 ARCHITECTURE.md        ← Technical deep-dive
│
├── 📁 src/                       ← Source code
│   ├── 📄 index.ts               ← Entry point
│   ├── 📄 resolver.ts            ← Main orchestrator
│   ├── 📁 workflow/              ← Workflow modules
│   ├── 📁 state/                 ← State management
│   ├── 📁 runners/               ← AI tool integrations
│   ├── 📁 llm/                   ← LLM client
│   ├── 📁 github/                ← GitHub API
│   ├── 📁 git/                   ← Git operations
│   └── ...
│
└── 📁 tests/                     ← Test files
```

---

## 🎓 Next Steps

1. **New to PRR?**
   - Read [main README](../README.md)
   - Try [Quick Reference](QUICK_REFERENCE.md)
   - Run: `prr --check-tools`

2. **Want to understand the flow?**
   - Study [Flowcharts](flowchart.md)
   - Trace through one full cycle
   - Run: `prr PR_URL --dry-run --verbose`

3. **Ready to contribute?**
   - Read [Architecture](ARCHITECTURE.md)
   - Review [DEVELOPMENT.md](../DEVELOPMENT.md)
   - Explore the codebase with context

4. **Found an issue?**
   - Check [Quick Reference troubleshooting](QUICK_REFERENCE.md#-troubleshooting)
   - Review logs: `~/.prr/output.log`
   - Open a GitHub issue with logs

---

## 💡 Tips

- **Mermaid not rendering?** View on GitHub or use a compatible viewer
- **Want to print?** Use markdown-pdf or similar tool
- **Need quick answers?** Use browser's find (Ctrl+F) on Quick Reference
- **Deep technical question?** Search Architecture Guide
- **Understanding a workflow?** Flowcharts have step-by-step diagrams

---

## 🐈 The PRR Philosophy

> PRR sits on your PR and won't get up until it's ready.

These docs explain **how** the cat works its magic. Happy reading! 📚

---

**Last Updated**: 2026-02-25
