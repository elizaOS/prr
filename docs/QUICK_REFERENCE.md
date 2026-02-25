# PRR Quick Reference Guide

## 🎯 What is PRR?

**PRR (PR Resolver)** sits on your PR and won't get up until it's ready. It automatically resolves PR review comments using AI-powered fixing and verification.

---

## 🚀 Quick Start

```bash
# Install
bun install && bun run build

# Run on a PR
prr https://github.com/owner/repo/pull/123

# Or use shorthand
prr owner/repo#123

# Full automation mode (loops until done)
prr owner/repo#123 --auto-push
```

---

## 📊 System Overview (One Page)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PRR WORKFLOW                                 │
└─────────────────────────────────────────────────────────────────────┘

1. SETUP
   ┌──────────────────────────────────────────────────────┐
   │ • Parse CLI arguments                                │
   │ • Load configuration (.env)                          │
   │ • Clone/update repository                            │
   │ • Load state (.pr-resolver-state.json)               │
   │ • Setup AI tools (detect available runners)          │
   └──────────────────────────────────────────────────────┘
                           ↓
2. FETCH COMMENTS
   ┌──────────────────────────────────────────────────────┐
   │ • Fetch from GitHub (GraphQL API)                    │
   │ • Inline review threads (CodeRabbit, Copilot, etc)   │
   │ • Issue comments (Claude, Greptile, etc)             │
   └──────────────────────────────────────────────────────┘
                           ↓
3. ANALYZE ISSUES
   ┌──────────────────────────────────────────────────────┐
   │ • LLM: "Is this issue still present?"                │
   │ • Cache status (skip if file unchanged)              │
   │ • Deduplicate (heuristic + LLM semantic)             │
   │ • Filter unsolvable (deleted files, stale refs)      │
   │ • Assess priority (importance + difficulty)          │
   │ • Sort by priority order                             │
   └──────────────────────────────────────────────────────┘
                           ↓
4. FIX LOOP ♻️
   ┌──────────────────────────────────────────────────────┐
   │ BATCH MODE (default)                                 │
   │ • Select top N issues (50 → 25 → 12 → 6 → 5)        │
   │ • Build prompt (PR context + lessons learned)        │
   │ • Run fixer tool (Cursor/Claude/Aider/etc)           │
   │ • Check for changes (git diff)                       │
   │ • Verify fixes with LLM                              │
   │                                                      │
   │ ↓ If batch fails ↓                                   │
   │                                                      │
   │ SINGLE-ISSUE MODE                                    │
   │ • Pick 1-3 random issues                             │
   │ • Same process (focused context)                     │
   │                                                      │
   │ ↓ If single-issue fails ↓                            │
   │                                                      │
   │ ESCALATION                                           │
   │ • Rotate model (Claude → GPT → Gemini)               │
   │ • Switch tool (cursor → claude-code → aider → ...)   │
   │ • Try direct LLM API (last resort)                   │
   │ • Bail out if all exhausted                          │
   └──────────────────────────────────────────────────────┘
                           ↓
5. VERIFY & COMMIT
   ┌──────────────────────────────────────────────────────┐
   │ • Final audit (adversarial LLM check)                │
   │ • Update comment status cache                        │
   │ • Generate commit message (LLM)                      │
   │ • Commit changes (squash or incremental)             │
   └──────────────────────────────────────────────────────┘
                           ↓
6. PUSH & WAIT
   ┌──────────────────────────────────────────────────────┐
   │ • Push to remote (with auto-rebase)                  │
   │ • Wait for bot reviews (smart wait time)             │
   │ • Check for new comments                             │
   │ • Repeat from step 2 if new issues                   │
   └──────────────────────────────────────────────────────┘
                           ↓
7. FINISH
   ┌──────────────────────────────────────────────────────┐
   │ • Print summary & statistics                         │
   │ • Export lessons (.prr/lessons.md, CLAUDE.md)        │
   │ • Cleanup workdir (unless --keep-workdir)            │
   │ • Ring bell 🔔                                        │
   └──────────────────────────────────────────────────────┘
```

**Why it works this way**
- **Analysis cache**: We remember which comments still need fixing per file hash. When the file hasn’t changed, we skip the LLM call — saves time and tokens.
- **Priority order**: Issues are sorted by importance/difficulty so the fixer tackles critical or easy wins first instead of arbitrary order.
- **Adaptive batch size**: If a big batch fixes nothing, we halve the batch next time (50 → 25 → …) then fall back to single-issue mode so the model isn’t overwhelmed.
- **Dismissal comments**: When we dismiss an issue (already-fixed, stale, etc.), we can add an inline code comment so review bots see the reasoning and don’t re-flag the same thing.
- **Commit message scope**: The commit message lists only issues in files that were actually changed in that commit, not every verified issue on the PR — keeps git history accurate.

---

## 🎨 Visual Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                         USER INPUT                                │
│                    prr owner/repo#123                             │
└────────────────────────────┬──────────────────────────────────────┘
                             ↓
           ┌─────────────────────────────────────┐
           │      CLI Parser (cli.ts)            │
           │  • Parse arguments                  │
           │  • Validate options                 │
           └──────────────┬──────────────────────┘
                          ↓
           ┌─────────────────────────────────────┐
           │   PR Resolver (resolver.ts)         │
           │  • Main orchestrator                │
           │  • State management                 │
           └──────────────┬──────────────────────┘
                          ↓
           ┌─────────────────────────────────────┐
           │  Run Orchestrator (workflow/)       │
           │  • Outer loop: Push iterations      │
           │  • Inner loop: Fix iterations       │
           └──────────────┬──────────────────────┘
                          ↓
        ┌────────────────┴────────────────┐
        ↓                                  ↓
┌────────────────┐              ┌──────────────────┐
│ GitHub API     │              │  LLM Client      │
│ • Fetch PR     │              │  • Analyze       │
│ • Comments     │              │  • Verify        │
└────────┬───────┘              └────────┬─────────┘
         ↓                               ↓
┌────────────────────────────────────────────────────┐
│         AI CODING TOOLS (runners/)                 │
│  Cursor • Claude Code • Aider • Gemini • Codex     │
└────────────────────┬───────────────────────────────┘
                     ↓
         ┌───────────────────────┐
         │   Git Operations      │
         │  • Commit • Push      │
         │  • Conflict resolve   │
         └───────────────────────┘
```

---

## 🔄 The Fix Loop (Detailed)

```
START FIX ITERATION
        │
        ├──[1] Build prompt
        │      • PR title & description
        │      • Base branch context
        │      • Unresolved issues
        │      • Lessons learned
        │      • "Run: git diff base...HEAD --stat"
        │
        ├──[2] Execute fixer tool
        │      • cursor-agent / claude / aider / etc
        │      • Model selection (rotation or smart)
        │      • Timeout handling
        │
        ├──[3] Check git diff
        │      ├─[No changes] → Parse explanation
        │      │                ├─[Valid reason] → Dismiss issue
        │      │                └─[Invalid] → Record failure
        │      │
        │      └─[Has changes] → Continue
        │
        ├──[4] Verify fixes (LLM)
        │      • For each changed file:
        │      •   "Does this diff address the concern?"
        │      • Update comment status cache
        │      • Track file content hash
        │
        ├──[5] Result handling
        │      ├─[Verified] → Mark fixed
        │      │              Reset failure counters
        │      │              Record model performance
        │      │
        │      └─[Not verified] → Record failure
        │                         Increment counters
        │                         Add lesson learned
        │
        └──[6] Decide next action
               ├─[All fixed] → Exit loop (success)
               ├─[Failure] → Escalate
               │             ├─ Adaptive batch (halve size)
               │             ├─ Single-issue mode
               │             ├─ Model rotation
               │             ├─ Tool rotation
               │             └─ Bail out
               │
               └─[Max iterations] → Exit loop (partial)
```

---

## 🧠 Smart Features

### 1. Comment Status Caching
```
Comment on file.ts
├─ First analysis: LLM says "issue exists"
├─ Cache: status=open, hash=abc123
│
Fix iteration runs
├─ File unchanged (hash still abc123)
└─ Skip LLM analysis (use cache) ← Saves tokens!

Fix iteration runs again
├─ File modified (hash now def456)
└─ Re-run LLM analysis ← Might be fixed now
```

### 2. Adaptive Batch Sizing
```
Iteration 1: Try 50 issues → 0 fixed
Iteration 2: Try 25 issues → 0 fixed (halved)
Iteration 3: Try 12 issues → 0 fixed (halved)
Iteration 4: Try 6 issues  → 0 fixed (halved)
Iteration 5: Try 5 issues  → 0 fixed (halved)
Iteration 6: Try 1-3 random → Single-issue mode
```

### 3. Model Family Interleaving
```
Same-family models fail similarly:
✗ Claude Sonnet fails
✗ Claude Opus also fails (same limitations)

Cross-family rotation works better:
Round 1: Claude Sonnet → GPT-4o → Gemini Pro
Round 2: Claude Opus → GPT-5 → o3-mini
...
```

### 4. Lessons Learned System
```
Fix attempt 1: Tries approach X → Rejected
  └─ Lesson: "Approach X doesn't work because Y"

Fix attempt 2: Prompt includes lesson
  └─ "Don't try X again, consider Z instead"

Fix attempt 3: Tries Z → Success!
```

---

## 📂 Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, signal handling |
| `src/cli.ts` | CLI argument parsing |
| `src/resolver.ts` | Main orchestrator class |
| `src/workflow/run-orchestrator.ts` | Outer loop (push iterations) |
| `src/workflow/push-iteration-loop.ts` | Inner loop (fix iterations) |
| `src/workflow/execute-fix-iteration.ts` | Single fix attempt |
| `src/state/manager.ts` | State persistence |
| `src/state/lessons-*.ts` | Lessons learned system |
| `src/runners/index.ts` | AI tool registry |
| `src/llm/client.ts` | LLM API client |
| `src/github/api.ts` | GitHub integration |

---

## 🎯 Common Use Cases

### Use Case 1: Fix Bot Review Comments
```bash
# CodeRabbit/Copilot left 50 comments
prr owner/repo#123 --auto-push

# PRR will:
# 1. Analyze all 50 comments
# 2. Fix in batches
# 3. Push and wait for re-review
# 4. Repeat until all resolved
```

### Use Case 2: One-Time Fix (No Loop)
```bash
# Just fix once, don't wait for re-review
prr owner/repo#123 --no-auto-push

# PRR will:
# 1. Analyze comments
# 2. Fix issues
# 3. Commit and push
# 4. Exit (you handle re-review)
```

### Use Case 3: Dry Run (Analysis Only)
```bash
# See what needs fixing without making changes
prr owner/repo#123 --dry-run

# PRR will:
# 1. Fetch comments
# 2. Analyze which are still present
# 3. Show unresolved issues
# 4. Exit (no fixes)
```

### Use Case 4: Resume After Interruption
```bash
# Press Ctrl+C during run (saves state)
^C
Gracefully shutting down...
State saved.

# Resume later (same command)
prr owner/repo#123

# PRR will:
# 1. Load saved state
# 2. Resume from where it left off
# 3. Continue fixing
```

---

## ⚙️ Configuration Tips

### Environment Setup
```bash
# .env file
GITHUB_TOKEN=ghp_xxx

# Option A: ElizaCloud (one key for all models)
ELIZACLOUD_API_KEY=xxx

# Option B: Direct providers
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
PRR_LLM_PROVIDER=anthropic
```

### Common CLI Patterns
```bash
# Conservative (bail out early)
prr PR_URL --max-stale-cycles 1

# Aggressive (try longer)
prr PR_URL --max-stale-cycles 3

# Custom model
prr PR_URL --tool cursor --model claude-4-opus-thinking

# Skip caching (fresh analysis)
prr PR_URL --reverify

# Priority: tackle easy issues first
prr PR_URL --priority-order easy

# Priority: important issues first (default)
prr PR_URL --priority-order important
```

---

## 🔍 Troubleshooting

### Problem: PRR keeps failing on same issue
**Solution**: Check lessons learned
```bash
cat ~/.prr/work/<hash>/.prr/lessons.md
```
If lesson isn't specific enough, add manual lesson to CLAUDE.md

---

### Problem: All models exhausted, nothing works
**Solution**: Check the issue
- Is it actually solvable by AI?
- Does it require human judgment?
- Is the requirement clear in the comment?

Use `--dry-run` to see exact issues

---

### Problem: PRR is slow
**Causes**:
1. **Too many issues**: Use adaptive batching (automatic)
2. **Comment status cache disabled**: Don't use `--reverify` unless needed
3. **Large context**: Reduce with `--max-context 200000`

**Check timing**:
```
Timing Summary at end shows:
  - Fetch comments: ~3s
  - Analyze issues: ~10s (depends on count)
  - Fix iteration: ~30-60s (depends on tool)
  - Verify fixes: ~5s
```

---

### Problem: PRR re-enters fix loop repeatedly after "final audit found N issue(s) not properly fixed"
**Cause**: Final audit re-opened some issues; without cache invalidation the next iteration skipped re-verifying them, so no files changed and the loop never made progress.
**Solution**: As of 2026-02-12, PRR unmarks those comments as verified before re-entering, so they are re-verified and re-fixed. If you're on an older version, upgrade.

---

### Problem: "No compatible recommended models for runner" with llm-api
**Cause**: The runner’s provider (openai/anthropic/elizacloud) is now taken from the runner at runtime, so LLM recommendations (e.g. gpt-5.2) are accepted when you're using OPENAI_API_KEY.
**Solution**: Upgrade to a version that uses `runner.provider` for llm-api; then recommendations are honored.

---

### Problem: State file conflicts in git
**Solution**: Should be auto-ignored
```bash
# Manually add to .gitignore
echo ".pr-resolver-state.json" >> .gitignore
git add .gitignore
git commit -m "Ignore PRR state file"
```

---

## 📈 Success Metrics

PRR tracks and reports:

```
═══════════════════════════════════════════
  FINAL SUMMARY
═══════════════════════════════════════════

📊 Session Statistics
  • Issues analyzed: 47
  • Issues fixed: 45
  • Issues dismissed: 2
  • Duplicates grouped: 8

⏱️ Timing
  • Total time: 8m 32s
  • Fetch comments: 3.2s
  • Analyze issues: 12.1s
  • Fix iterations: 6m 45s
  • Verify fixes: 31.2s

🤖 Model Performance
  claude-4-sonnet-thinking: 23 fixed, 3 failed
  gpt-4o: 15 fixed, 1 failed
  o3-mini: 7 fixed, 5 failed

💰 Token Usage
  Total: 2.3M tokens (~$5.75)
  Analysis: 450K
  Fixing: 1.5M
  Verification: 350K

📚 Lessons Learned: 7
  • 3 global lessons
  • 4 file-specific lessons
  • Exported to CLAUDE.md
```

---

## 🎓 Best Practices

### 1. Start Conservative
- Use `--max-stale-cycles 1` initially
- Increase to 2-3 once you trust the system
- Monitor lessons learned

### 2. Let Auto-Push Work
- `--auto-push` is the default for a reason
- It handles the full loop automatically
- You can interrupt anytime with Ctrl+C

### 3. Review After Bail-Out
- PRR commits partial progress
- Check what was fixed
- Manually address remaining issues
- Add lessons if needed

### 4. Use Priority Order
- `--priority-order important`: Security/bugs first
- `--priority-order easy`: Quick wins first
- `--priority-order newest`: Recent feedback first

### 5. Share Lessons With Team
- Lessons are committed to `CLAUDE.md`
- Team members get them via `git pull`
- Builds collective knowledge

---

## 🚨 Exit Reasons

| Reason | Meaning | Action |
|--------|---------|--------|
| ✅ `all_fixed` | Success! All issues resolved | Celebrate! |
| 🎯 `dry_run` | Analysis complete (dry-run mode) | Review list |
| 📭 `no_comments` | No review comments found | Nothing to do |
| ⚠️ `bail_out` | Stalemate after max cycles | Manual review |
| 🔁 `outer_bailout` | Multiple consecutive bailouts | Investigate |
| 🔢 `max_iterations` | Hit iteration limit | Increase limit |
| ⚡ `user_interrupt` | Ctrl+C pressed | Resume later |
| ❌ `error` | Unexpected error | Check logs |

---

## 📚 Further Reading

- **Full README**: `README.md`
- **Detailed Flowcharts**: `docs/flowchart.md`
- **Architecture Guide**: `docs/ARCHITECTURE.md`
- **Development Guide**: `DEVELOPMENT.md`
- **Changelog**: `CHANGELOG.md`

---

## 💡 Quick Tips

1. **First time setup**: Run `prr --check-tools` to see what's installed
2. **Update tools**: Run `prr --update-tools` to get latest versions
3. **Clean lessons**: Run `prr --tidy-lessons` to deduplicate and normalize
4. **Check output log**: `~/.prr/output.log` has everything
5. **Debug mode**: Use `--verbose` to see LLM prompts and responses

---

## 🐱 Remember

> PRR sits on your PR and won't get up until it's ready.

**The cat doesn't give up.** 🐈
