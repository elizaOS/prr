# PRR Documentation Index

Welcome to the PRR documentation! This directory contains comprehensive guides and flowcharts explaining how the PR Resolver system works.

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

```
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

### The Three Loops

```
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

```
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
  "dismissedIssues": ["comment_789"],
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

```
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

**Last Updated**: 2026-02-12
