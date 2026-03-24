# PRR (PR Resolver) - System Flowchart

## Overview
PRR automatically resolves PR review comments using LLM-powered fixing and verification through multiple escalation strategies.

---

## Main System Flow

```mermaid
flowchart TD
    Start([User runs: prr PR_URL]) --> ParseCLI[Parse CLI Arguments<br/>cli.ts]
    ParseCLI --> CheckMode{Special<br/>Mode?}
    
    CheckMode -->|--check-tools| CheckTools[Show Tool Status<br/>& Exit]
    CheckMode -->|--update-tools| UpdateTools[Update All Tools<br/>& Exit]
    CheckMode -->|--tidy-lessons| TidyLessons[Clean Lessons<br/>& Exit]
    CheckMode -->|Normal Run| LoadConfig[Load Config<br/>config.ts]
    
    LoadConfig --> CreateResolver[Create PRResolver<br/>resolver.ts]
    CreateResolver --> InitLog[Start Output Log<br/>~/.prr/output.log]
    InitLog --> SetupSignals[Setup Signal Handlers<br/>SIGINT/SIGTERM]
    SetupSignals --> RunResolver[resolver.run(prUrl)]
    
    RunResolver --> Orchestrator[Run Orchestrator<br/>run-orchestrator.ts]
    
    CheckTools --> End([Exit])
    UpdateTools --> End
    TidyLessons --> End
```

---

## Orchestrator: Outer Loop

```mermaid
flowchart TD
    Start([executeRun]) --> Initialize[Initialize Run<br/>Parse PR URL<br/>Fetch PR Info]
    Initialize --> SetupPhase[Setup Phase<br/>Clone/Update Repo<br/>Load State & Lessons<br/>Setup Runners]
    
    SetupPhase --> CheckConflicts{Conflicts<br/>Detected?}
    CheckConflicts -->|Yes| ResolveConflicts[Resolve with LLM<br/>Lock files → regenerate<br/>Code files → LLM fix]
    CheckConflicts -->|No| PushLoop
    ResolveConflicts --> PushLoop
    
    PushLoop[Push Iteration Loop<br/>iteration = 1] --> PushIter[Execute Push Iteration<br/>push-iteration-loop.ts]
    
    PushIter --> PushResult{Result?}
    
    PushResult -->|Success| CheckAutoPush{Auto-push<br/>enabled?}
    PushResult -->|Bail-out| TrackBailout[Track Consecutive<br/>Bail-outs]
    PushResult -->|Error| ErrorCleanup
    
    TrackBailout --> CheckBailoutCount{Consecutive<br/>Bail-outs ≥ 2?}
    CheckBailoutCount -->|Yes| HardExit[Hard Exit<br/>Too many stalemates]
    CheckBailoutCount -->|No| WaitForBot
    
    CheckAutoPush -->|No| Finalize
    CheckAutoPush -->|Yes| WaitForBot[Wait for Bot Reviews<br/>Smart wait time calculation]
    
    WaitForBot --> CheckNewComments{New<br/>Comments?}
    CheckNewComments -->|Yes| IncrementPush[iteration++]
    CheckNewComments -->|No| Finalize
    
    IncrementPush --> CheckMaxPush{iteration <<br/>max?}
    CheckMaxPush -->|Yes| PushIter
    CheckMaxPush -->|No| Finalize
    
    Finalize[Final Cleanup<br/>Add dismissal comments<br/>Print summary<br/>Ring bell]
    Finalize --> Cleanup[Cleanup Workdir<br/>if not --keep-workdir]
    
    ErrorCleanup[Error Cleanup<br/>Save state<br/>Show error]
    ErrorCleanup --> End
    
    HardExit --> Finalize
    Cleanup --> End([Return to main])
```

---

## Push Iteration: Single Push Cycle

```mermaid
flowchart TD
    Start([executePushIteration]) --> FetchComments[Fetch Review Comments<br/>GraphQL API<br/>Inline threads + Issue comments]
    
    FetchComments --> CheckCache{Comment<br/>status<br/>cached?}
    CheckCache -->|Yes, file unchanged| SkipAnalysis[Skip LLM analysis<br/>Use cached status]
    CheckCache -->|No or file changed| AnalyzeComments[Analyze Comments<br/>LLM: 'Is issue still present?'<br/>Classify: exists/fixed/unclear]
    
    SkipAnalysis --> Dedup
    AnalyzeComments --> Dedup[Deduplicate Issues<br/>Heuristic + LLM semantic]
    
    Dedup --> FilterSolvable[Filter Solvable Issues<br/>Skip deleted files, stale refs]
    FilterSolvable --> PrioritySort[Sort by Priority<br/>importance/ease/newest/oldest]
    
    PrioritySort --> CheckIssues{Any<br/>unresolved<br/>issues?}
    
    CheckIssues -->|No| CheckChanges{Changes<br/>exist?}
    CheckIssues -->|Yes| FixLoop[Fix Loop<br/>iteration = 1]
    
    FixLoop --> PreChecks[Pre-Iteration Checks<br/>Pull remote if ahead<br/>Check for new comments]
    PreChecks --> ExecuteFix[Execute Fix Iteration<br/>execute-fix-iteration.ts]
    
    ExecuteFix --> FixResult{Result?}
    
    FixResult -->|Changes made| VerifyFixes[Verify Fixes<br/>LLM: 'Does diff fix issue?']
    FixResult -->|No changes| HandleNoChanges[Parse no-changes explanation<br/>Dismiss if valid reason]
    FixResult -->|Error| HandleError[Handle Fixer Error<br/>Record lesson learned]
    
    VerifyFixes --> UpdateCache[Update Comment Status<br/>Mark verified/unresolved<br/>Track file hashes]
    UpdateCache --> CheckCommit{Incremental<br/>commit?}
    
    HandleNoChanges --> CheckAllFixed
    HandleError --> CheckRotation
    
    CheckCommit -->|Yes| CommitIter[Commit Iteration<br/>LLM-generated message]
    CheckCommit -->|No| CheckAllFixed
    
    CommitIter --> CheckAllFixed{All<br/>fixed?}
    
    CheckAllFixed -->|Yes| FinalAudit
    CheckAllFixed -->|No| CheckMaxIter{iteration <<br/>max?}
    
    CheckMaxIter -->|Yes| IncrementFix[iteration++]
    CheckMaxIter -->|No| CheckRotation{Try<br/>rotation?}
    
    IncrementFix --> FixLoop
    
    CheckRotation -->|Yes| RotateStrategy[Rotation Strategy<br/>fix-loop-rotation.ts]
    CheckRotation -->|No| BailOut[Execute Bail-out<br/>Commit partial progress]
    
    RotateStrategy --> RotResult{Success?}
    RotResult -->|Yes| FixLoop
    RotResult -->|No| BailOut
    
    FinalAudit[Final Audit<br/>Adversarial re-verification<br/>Clear cache first]
    FinalAudit --> AuditResult{All<br/>verified?}
    
    AuditResult -->|Yes| CheckChanges
    AuditResult -->|No| MoreIssues[More iterations needed]
    MoreIssues --> CheckMaxIter
    
    CheckChanges -->|Yes| CommitPush[Commit & Push<br/>Squash commit<br/>Auto-rebase on rejection]
    CheckChanges -->|No| ReturnSuccess
    
    CommitPush --> ReturnSuccess[Return: shouldBreak=false<br/>Continue to next push iteration]
    BailOut --> ReturnBailout[Return: shouldBreak=false<br/>bailOut=true]
    
    ReturnSuccess --> End([Return to orchestrator])
    ReturnBailout --> End
```

---

## Fix Iteration: Single Fix Attempt

```mermaid
flowchart TD
    Start([executeFixIteration]) --> CheckBatch{Batch<br/>mode?}
    
    CheckBatch -->|Yes| CalcBatch[Calculate Batch Size<br/>Adaptive: 50→25→12→6→5<br/>Based on consecutive failures]
    CheckBatch -->|No| SingleIssue
    
    CalcBatch --> SelectIssues[Select Top N Issues<br/>By priority order]
    SelectIssues --> BuildPrompt[Build Fix Prompt<br/>PR context + diff-first<br/>Issues + lessons learned]
    
    BuildPrompt --> RunFixer[Run Fixer Tool<br/>cursor/claude-code/aider/etc]
    RunFixer --> CheckOutput{Tool<br/>output?}
    
    CheckOutput -->|Success| CheckDiff{Git diff<br/>exists?}
    CheckOutput -->|No changes| NoChanges[Extract explanation<br/>from tool output]
    CheckOutput -->|Error| FixerError[Parse error<br/>Record failure]
    
    CheckDiff -->|Yes| VerifyDiff[Verify Changes<br/>LLM reviews diff<br/>per file/issue]
    CheckDiff -->|No| NoChanges
    
    VerifyDiff --> VerifyResult{Verified?}
    VerifyResult -->|Yes| RecordSuccess[Mark issues verified<br/>Record model performance<br/>Reset failure counters]
    VerifyResult -->|No| RecordFailure[Record failure<br/>Increment counters<br/>Add lesson learned]
    
    NoChanges --> ValidReason{Valid<br/>reason?}
    ValidReason -->|Yes| DismissIssue[Dismiss Issue<br/>Add to state]
    ValidReason -->|No| RecordFailure
    
    RecordSuccess --> ReturnSuccess[Return: progress made]
    RecordFailure --> CheckRapidFail{Rapid<br/>failures?}
    DismissIssue --> ReturnSuccess
    FixerError --> RecordFailure
    
    CheckRapidFail -->|Yes| BackoffDelay[Exponential Backoff<br/>Wait before retry]
    CheckRapidFail -->|No| ReturnFailure[Return: no progress]
    
    BackoffDelay --> ReturnFailure
    
    SingleIssue[Single-Issue Mode<br/>Select 1-3 random issues] --> BuildPrompt
    
    ReturnSuccess --> End([Return to push iteration])
    ReturnFailure --> End
```

---

## Escalation Strategy: When Fixes Fail

```mermaid
flowchart TD
    Start([Fix Failed]) --> Batch1[Try: Batch Mode<br/>Top 50 issues by priority]
    
    Batch1 --> Result1{Fixed?}
    Result1 -->|Yes| Success[Return to fix loop]
    Result1 -->|No| Halve1[Adaptive Batch<br/>Reduce to 25 issues]
    
    Halve1 --> Result2{Fixed?}
    Result2 -->|Yes| Success
    Result2 -->|No| Halve2[Adaptive Batch<br/>Reduce to 12 issues]
    
    Halve2 --> Result3{Fixed?}
    Result3 -->|Yes| Success
    Result3 -->|No| Halve3[Adaptive Batch<br/>Reduce to 6 issues]
    
    Halve3 --> Result4{Fixed?}
    Result4 -->|Yes| Success
    Result4 -->|No| Halve4[Adaptive Batch<br/>Reduce to 5 issues]
    
    Halve4 --> Result5{Fixed?}
    Result5 -->|Yes| Success
    Result5 -->|No| SingleIssue[Single-Issue Mode<br/>1-3 random issues]
    
    SingleIssue --> Result6{Fixed?}
    Result6 -->|Yes| Success
    Result6 -->|No| CheckSmart{Use smart<br/>model<br/>selection?}
    
    CheckSmart -->|Yes| RecommendModel[LLM Recommends Models<br/>Based on issue analysis]
    CheckSmart -->|No| RotateModel
    
    RecommendModel --> TryRecommended[Try Recommended Model]
    TryRecommended --> Result7{Fixed?}
    Result7 -->|Yes| Success
    Result7 -->|No| RotateModel
    
    RotateModel[Rotate Model<br/>Interleave families<br/>Claude→GPT→Gemini] --> Result8{Fixed?}
    Result8 -->|Yes| Success
    Result8 -->|No| CheckModels{All models<br/>exhausted?}
    
    CheckModels -->|No| RotateModel
    CheckModels -->|Yes| SwitchTool[Switch Tool<br/>cursor→claude-code→aider→...]
    
    SwitchTool --> Result9{Fixed?}
    Result9 -->|Yes| Success
    Result9 -->|No| CheckTools{All tools<br/>tried?}
    
    CheckTools -->|No| SwitchTool
    CheckTools -->|Yes| DirectAPI[Try Direct LLM API<br/>Last resort]
    
    DirectAPI --> Result10{Fixed?}
    Result10 -->|Yes| Success
    Result10 -->|No| CheckCycles{Complete<br/>cycle with<br/>zero<br/>progress?}
    
    CheckCycles -->|No| RecordProgress[Record progress<br/>Reset cycle counter]
    CheckCycles -->|Yes| IncrementCycle[Increment<br/>noProgressCycles]
    
    RecordProgress --> Batch1
    IncrementCycle --> CheckMaxCycles{cycles ≥<br/>maxStaleCycles?}
    
    CheckMaxCycles -->|No| Batch1
    CheckMaxCycles -->|Yes| BailOut[Bail Out<br/>Commit partial progress<br/>Save state<br/>Exit with report]
    
    BailOut --> End([Human intervention needed])
    Success --> End
```

---

## State Management

```mermaid
flowchart LR
    State[State File<br/>.pr-resolver-state.json]
    
    State --> PR[PR Info<br/>owner/repo/number<br/>branch/headSha]
    State --> Comments[Comment Statuses<br/>open/resolved<br/>classification<br/>file hash<br/>importance/ease]
    State --> Verified[Verified Comments<br/>commentId<br/>verifiedAt<br/>iteration]
    State --> Dismissed[Dismissed Issues<br/>commentId<br/>reason]
    State --> Lessons[Lessons Learned<br/>global<br/>file-specific]
    State --> Rotation[Rotation State<br/>currentRunnerIndex<br/>modelIndices<br/>noProgressCycles]
    State --> Performance[Model Performance<br/>fixes per model<br/>failures per model]
    
    Lessons --> PrrLessons[.prr/lessons.md<br/>Full history]
    Lessons --> ClaudeMd[CLAUDE.md<br/>Compacted sync]
    Lessons --> AgentsMd[AGENTS.md<br/>Compacted sync]
    Lessons --> CursorRules[.cursor/rules/<br/>prr-lessons.mdc]
```

---

## LLM Usage Points

```mermaid
flowchart TD
    Start([LLM API Calls]) --> Analysis[Comment Analysis<br/>'Is issue still present?'<br/>Classify + assess priority]
    
    Start --> Dedup[Semantic Deduplication<br/>Group related comments<br/>from different reviewers]
    
    Start --> Solvability[Solvability Detection<br/>Can this be automated?<br/>Skip deleted files, etc]
    
    Start --> ModelRec[Model Recommendation<br/>Which models best<br/>for these issues?]
    
    Start --> Fixer[Fixer Tool Execution<br/>Generate code fixes<br/>Via tool-specific APIs]
    
    Start --> Verification[Fix Verification<br/>'Does diff fix issue?'<br/>Per file/comment]
    
    Start --> FinalAudit[Final Audit<br/>Adversarial recheck<br/>Find what's NOT fixed]
    
    Start --> ConflictResolve[Conflict Resolution<br/>Merge conflict fixing<br/>Via LLM tools]
    
    Start --> CommitMsg[Commit Messages<br/>Generate from diff<br/>Describe changes]
    
    Start --> LessonAnalysis[Lesson Analysis<br/>Why did fix fail?<br/>Actionable guidance]
```

---

## Key Features Visualization

### Comment Status Caching
```
┌─────────────────────────────────────────────┐
│ Comment on file.ts (hash: abc123)          │
│ Status: OPEN (issue exists)                │
│ Classification: "exists"                   │
│ Last analyzed: iteration 5                 │
└─────────────────────────────────────────────┘
                    │
                    ▼
         File not modified? ──Yes──> Skip LLM analysis
                    │                (use cached status)
                    No
                    │
                    ▼
         File hash changed (abc123 → def456)
                    │
                    ▼
         Re-run LLM analysis
         (fix may have resolved issue)
```

### Adaptive Batch Sizing
```
Iteration 1: 50 issues → 0 fixed
Iteration 2: 25 issues → 0 fixed  (halved)
Iteration 3: 12 issues → 0 fixed  (halved)
Iteration 4: 6 issues  → 0 fixed  (halved)
Iteration 5: 5 issues  → 0 fixed  (halved)
Iteration 6: 1-3 random issues (single-issue mode)
```

### Model Family Interleaving
```
Round 1:
  ├─ Claude Sonnet (Claude family)
  ├─ GPT-4o (GPT family)
  └─ Gemini Pro (Gemini family)

Round 2:
  ├─ Claude Opus (Claude family)
  ├─ GPT-5 (GPT family)
  └─ o3-mini (OpenAI reasoning family)

...until all models exhausted → switch tool
```

---

## Error Recovery & Resilience

```mermaid
flowchart TD
    Start([Error Detected]) --> Type{Error<br/>Type?}
    
    Type -->|Merge Conflict| ConflictFlow[Conflict Resolution<br/>Lock files → regenerate<br/>Code files → LLM fix]
    Type -->|Remote Ahead| RebaseFlow[Pull & Rebase<br/>Auto-retry push]
    Type -->|Stash Conflict| StashFlow[Apply Stash<br/>Resolve conflicts<br/>Continue]
    Type -->|Fixer Timeout| TimeoutFlow[Kill process<br/>Record failure<br/>Try next model/tool]
    Type -->|API Rate Limit| RateLimitFlow[Exponential Backoff<br/>Wait and retry]
    Type -->|Auth Failure| AuthFlow[Check tokens<br/>Inject GitHub token<br/>to remote URL]
    Type -->|Graceful Shutdown| ShutdownFlow[Save state<br/>Commit progress<br/>Clean exit]
    
    ConflictFlow --> Recovered{Resolved?}
    RebaseFlow --> Recovered
    StashFlow --> Recovered
    TimeoutFlow --> Recovered
    RateLimitFlow --> Recovered
    AuthFlow --> Recovered
    
    Recovered -->|Yes| Continue[Continue execution]
    Recovered -->|No| Retry{Retry<br/>possible?}
    
    Retry -->|Yes| Continue
    Retry -->|No| BailOut[Bail out<br/>Save state<br/>Request human help]
    
    ShutdownFlow --> SaveState[Save State<br/>Print summary<br/>Exit cleanly]
    
    Continue --> End([Resume workflow])
    BailOut --> End
    SaveState --> End
```

---

## Tool Integration Architecture

```mermaid
flowchart TD
    Runner[Runner Interface<br/>runners/types.ts] --> Cursor[Cursor CLI<br/>cursor-agent]
    Runner --> ClaudeCode[Claude Code<br/>claude/claude-code]
    Runner --> Aider[Aider<br/>aider CLI]
    Runner --> Gemini[Gemini CLI<br/>gemini]
    Runner --> Codex[OpenAI Codex<br/>codex CLI]
    Runner --> Junie[Junie<br/>junie CLI]
    Runner --> Goose[Goose<br/>goose CLI]
    Runner --> OpenHands[OpenHands<br/>openhands CLI]
    Runner --> OpenCode[OpenCode<br/>opencode CLI]
    Runner --> LLMAPI[Direct LLM API<br/>Anthropic/OpenAI]
    
    Cursor --> Execute[Execute Prompt<br/>Parse Output<br/>Track Model]
    ClaudeCode --> Execute
    Aider --> Execute
    Gemini --> Execute
    Codex --> Execute
    Junie --> Execute
    Goose --> Execute
    OpenHands --> Execute
    OpenCode --> Execute
    LLMAPI --> Execute
```

---

## Data Flow Summary

```
User Input (PR URL)
    ↓
Parse & Validate
    ↓
Fetch PR Info (GitHub API)
    ↓
Clone/Update Repository
    ↓
Load State & Lessons
    ↓
Fetch Review Comments
    ↓
Analyze Comments (LLM)
    ↓
Filter & Prioritize Issues
    ↓
╔═══════════════════════════╗
║   FIX LOOP                ║
║   ├─ Build Prompt         ║
║   ├─ Run Fixer Tool       ║
║   ├─ Verify Fixes (LLM)   ║
║   ├─ Update State         ║
║   ├─ Commit (optional)    ║
║   └─ Rotate if needed     ║
╚═══════════════════════════╝
    ↓
Final Audit (LLM)
    ↓
Commit & Push Changes
    ↓
Wait for Bot Reviews
    ↓
Check New Comments
    ↓
Repeat or Exit
    ↓
Print Summary & Stats
```

---

## Performance Optimizations

### 1. Comment Status Caching
- **Problem**: Re-analyzing unchanged files wastes tokens
- **Solution**: Cache LLM analysis with file content hash
- **Result**: Skip redundant API calls on unmodified files

### 2. Prefetched Comments
- **Problem**: Fetching comments twice (setup + iteration)
- **Solution**: Pass prefetched data from setup to first iteration
- **Result**: Save ~3s and 3 API calls per run

### 3. Deduplication (Two-Phase)
- **Problem**: Multiple reviewers flag same issue
- **Solution**: Heuristic grouping (file+line) → LLM semantic analysis
- **Result**: Process only canonical issues, auto-verify duplicates

### 4. Batch Verification
- **Problem**: Verifying 50+ issues individually is slow
- **Solution**: Group by ~400K char context windows
- **Result**: Parallel verification with controlled token usage

### 5. Model Discovery Cache
- **Problem**: Querying available models on every run
- **Solution**: Cache model lists per tool
- **Result**: Faster startup, fewer API calls

### 6. Spot-Check Verification
- **Problem**: Expensive full batch verification on "already fixed" claims
- **Solution**: Sample 5 issues first, full verify only if passing
- **Result**: Reject false positives early, save tokens

---

## Exit Reasons

| Reason | Description | Next Action |
|--------|-------------|-------------|
| `all_fixed` | All issues resolved | Success! |
| `dry_run` | Dry-run mode completed | Review issues |
| `no_comments` | No review comments found | Nothing to do |
| `bail_out` | Stalemate after max cycles | Manual review needed |
| `outer_bailout` | Consecutive bailouts (outer loop) | Manual intervention |
| `max_iterations` | Hit max fix iterations | Increase limit or investigate |
| `user_interrupt` | Ctrl+C pressed | Resume or inspect |
| `error` | Unexpected error occurred | Check logs |
| `no_changes` | No changes after fixes | Already addressed? |
| `lock_failed` | Could not acquire lock | Another instance running |
| `cleanup_mode` | Cleanup completed | Clean state restored |

---

## Summary

**PRR** is a sophisticated autonomous PR resolution system that:

1. **Fetches** review comments from GitHub (inline threads + issue comments)
2. **Analyzes** which issues still exist using LLM with caching optimization
3. **Prioritizes** issues by importance/difficulty via LLM assessment
4. **Fixes** issues using multiple AI coding tools with model rotation
5. **Verifies** fixes with adversarial LLM prompts to catch false positives
6. **Escalates** through strategies: batch → adaptive → single-issue → model rotation → tool rotation → direct API
7. **Learns** from failures to avoid repeating mistakes (lessons shared via CLAUDE.md, AGENTS.md)
8. **Commits** with LLM-generated messages describing actual changes
9. **Pushes** with auto-rebase on remote conflicts
10. **Waits** for bot re-reviews and repeats until all resolved or max cycles

The system is resilient with state persistence, graceful shutdown, conflict auto-resolution, and comprehensive error recovery.
