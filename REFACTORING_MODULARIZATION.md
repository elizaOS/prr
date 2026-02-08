# Resolver-Proc Modularization Plan

## Problem
`resolver-proc.ts` has grown to 2,823 lines, becoming another god object. We need to split it into focused modules.

## Proposed Module Structure

### 1. `workflow/utils.ts` (✅ Created - ~320 lines)
**Pure utility functions with no external dependencies**
- `createResolverContext` - Initialize context
- `ringBell` - Terminal notification
- `parseNoChangesExplanation` - Parse fixer output
- `sanitizeOutputForLog` - Clean debug output
- `validateDismissalExplanation` - Validation logic
- `sleep` - Async delay
- `buildSingleIssuePrompt` - Prompt generation
- `calculateExpectedBotResponseTime` - Timing calculation
- `shouldCheckForNewComments` - Timing check

### 2. `workflow/initialization.ts` (~160 lines)
**Setup and state initialization**
- `ensureStateFileIgnored` - Git ignore setup
- `initializeManagers` - State/lessons/lock setup
- `restoreRunnerState` - Restore saved state

### 3. `workflow/issue-analysis.ts` (~350 lines)
**Finding and analyzing issues**
- `findUnresolvedIssues` - Main issue analysis (201 lines)
- `getCodeSnippet` - Extract code context (56 lines)

### 4. `workflow/status.ts` (~180 lines)
**PR status checks and bot monitoring**
- `checkAndDisplayPRStatus` - PR status display (58 lines)
- `analyzeBotTiming` - Bot timing analysis (72 lines)
- `checkCodeRabbitStatus` - CodeRabbit status (44 lines)
- `checkForNewBotReviews` - Check for new reviews (72 lines)

### 5. `workflow/conflicts.ts` (~360 lines)
**Conflict resolution**
- `handleConflictsAndSync` - Main conflict handler (271 lines)
- `checkAndPullRemoteCommits` - Remote sync (76 lines)

### 6. `workflow/fixing.ts` (~200 lines)
**Fix execution strategies**
- `tryDirectLLMFix` - Direct LLM API fix (105 lines)
- `trySingleIssueFix` - Single issue focus (169 lines)

### 7. `workflow/verification.ts` (~360 lines)
**Verification and audit**
- `verifyFixesAfterRun` - Main verification (222 lines)
- `runFinalAudit` - Final audit pass (134 lines)

### 8. `workflow/error-handling.ts` (~390 lines)
**Error and edge case handling**
- `handleFixerError` - Tool error handling (87 lines)
- `handleNoChanges` - No changes case (132 lines)
- `handleNoComments` - No comments case (107 lines)
- `checkForNewComments` - New comments check (68 lines)

### 9. `workflow/orchestration.ts` (~400 lines)
**High-level orchestration**
- `runCleanupMode` - Cleanup operations (183 lines)
- `waitForBotReviews` - Smart waiting (56 lines)
- `executeBailOut` - Bail-out logic (105 lines)

## Benefits

1. **Improved Maintainability**: Each module has a clear, single responsibility
2. **Better Testability**: Smaller modules are easier to test in isolation
3. **Easier Navigation**: Find functions by logical category
4. **Reduced Cognitive Load**: ~300 lines per file vs 2,800
5. **Clear Dependencies**: Module imports show relationships
6. **Parallel Development**: Multiple devs can work on different modules

## Migration Strategy

1. ✅ Create `workflow/utils.ts` (completed)
2. Create remaining 8 workflow modules
3. Update `resolver-proc.ts` to re-export from modules for backward compatibility
4. Update imports in `resolver.ts`
5. Verify compilation
6. Remove old code from `resolver-proc.ts` (keep as thin re-export layer)

## Backward Compatibility

Keep `resolver-proc.ts` as a facade that re-exports all functions:

```typescript
// resolver-proc.ts becomes:
export * from './workflow/utils.js';
export * from './workflow/initialization.js';
export * from './workflow/issue-analysis.js';
// ... etc
```

This ensures existing imports in `resolver.ts` continue to work.

## Status

- ✅ Phase 1: Plan created
- ✅ Phase 2: `workflow/utils.ts` created and tested
- ⏳ Phase 3: Create remaining 8 modules
- ⏳ Phase 4: Update re-exports
- ⏳ Phase 5: Verify compilation

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Largest file | 2,823 lines | ~400 lines |
| Average file size | 2,823 lines | ~300 lines |
| Number of modules | 1 | 10 |
| Lines per module | 2,823 | 280-400 |

This reduces the maximum file size by **85%** while maintaining all functionality.
