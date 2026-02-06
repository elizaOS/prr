# Refactoring Status: Procedural Conversion

## ✅ Completed Conversions (All Compiling)

### 1. **Runners** (6 files)
- `src/runners/aider.ts` - Factory function pattern
- `src/runners/codex.ts` - Factory function pattern
- `src/runners/opencode.ts` - Factory function pattern
- `src/runners/cursor.ts` - Factory function pattern
- `src/runners/claude-code.ts` - Factory function pattern
- `src/runners/llm-api.ts` - Factory function pattern
- **Status:** ✅ Complete, backward-compatible wrappers in place

### 2. **GitHubAPI** (`src/github/api.ts`)
- Converted to procedural functions (950 lines)
- Deprecated class wrapper for backward compatibility
- **Status:** ✅ Complete

### 3. **LLMClient** (`src/llm/client.ts`)
- Converted to procedural functions (1,195 lines)
- Deprecated class wrapper for backward compatibility
- **Status:** ✅ Complete

### 4. **StateManager** 
- `src/state/manager.ts` - Thin wrapper (247 lines)
- `src/state/manager-proc.ts` - Procedural logic (634 lines)
- **Status:** ✅ Complete

### 5. **LessonsManager** (`src/state/lessons.ts`)
- Converted to procedural functions (1,439 lines)
- Deprecated class wrapper for backward compatibility
- **Status:** ✅ Complete

### 6. **LockManager** (`src/state/lock.ts`)
- Converted to procedural functions (350 lines)
- Deprecated class wrapper for backward compatibility
- **Status:** ✅ Complete

---

## 📦 Created But Not Yet Integrated

### 1. **UI/Reporter Module** (`src/ui/reporter.ts` - 316 lines)
**Extracted methods:**
- `printModelPerformance(stateManager)`
- `printFinalSummary(stateManager, exitReason, exitDetails)`
- `getExitReasonDisplay(exitReason)`
- `printHandoffPrompt(unresolvedIssues, noHandoffPrompt)`
- `printAfterActionReport(unresolvedIssues, comments, noAfterAction, stateManager, lessonsManager)`
- `printUnresolvedIssues(issues)`

**Status:** ⏸️ File created, needs import and delegation in resolver.ts

### 2. **Model Rotation Module** (`src/models/rotation.ts` - 459 lines)
**Extracted methods:**
- `createRotationContext(runner, runners)`
- `getModelsForRunner(runner)`
- `getCurrentModel(ctx, options)`
- `isModelAvailableForRunner(ctx, model)`
- `advanceModel(ctx, stateManager, options)`
- `rotateModel(ctx, stateManager)`
- `switchToNextRunner(ctx, stateManager)`
- `allModelsExhausted(ctx)`
- `tryRotation(ctx, stateManager, options)`
- `setupRunner(options, config)`
- Helper functions: `setRecommendedModels`, `recordProgress`, etc.

**Status:** ⏸️ File created, needs import and delegation in resolver.ts

### 3. **Git Operations Module** (`src/git/operations.ts` - 504 lines)
**Extracted methods:**
- `buildConflictResolutionPrompt(conflictedFiles, baseBranch)`
- `handleLockFileConflicts(git, lockFiles, workdir, config)`
- `resolveConflictsWithLLM(git, conflictedFiles, mergingBranch, workdir, config, llm, runner, getCurrentModel)`
- `cleanupCreatedSyncTargets(git, workdir, lessonsManager)`

**Status:** ⏸️ File created, needs import and delegation in resolver.ts

### 4. **Resolver Procedural Module** (`src/resolver-proc.ts` - 247 lines)
**Extracted functions:**
- `createResolverContext(config, options, github, llm)` - Context factory
- `ringBell(times)` - Terminal notification
- `parseNoChangesExplanation(output)` - Parse tool output
- `sanitizeOutputForLog(output, maxLength)` - Clean logs
- `validateDismissalExplanation(explanation, commentPath, commentLine)` - Validation
- `sleep(ms)` - Utility

**Status:** 🔄 Partially started, needs ~60 more methods extracted

---

## 🚧 Remaining Work for PRResolver

### Current State
- **File:** `src/resolver.ts`
- **Size:** 4,503 lines
- **Methods:** ~60+ remaining to extract
- **Pattern:** Same as StateManager (thin wrapper class → procedural implementation)

### Methods Still in resolver.ts

**Sync Methods (23):**
- `ringBell()` - ✅ Extracted to resolver-proc.ts
- `printModelPerformance()` - ✅ Exists in ui/reporter.ts (not integrated)
- `printFinalSummary()` - ✅ Exists in ui/reporter.ts (not integrated)
- `getExitReasonDisplay()` - ✅ Exists in ui/reporter.ts (not integrated)
- `printHandoffPrompt()` - ✅ Exists in ui/reporter.ts (not integrated)
- `suggestResolutions()` - ⏸️ In ui/reporter.ts
- `getModelsForRunner()` - ✅ Exists in models/rotation.ts (not integrated)
- `getCurrentModel()` - ✅ Exists in models/rotation.ts (not integrated)
- `isModelAvailableForRunner()` - ✅ Exists in models/rotation.ts (not integrated)
- `advanceModel()` - ✅ Exists in models/rotation.ts (not integrated)
- `rotateModel()` - ✅ Exists in models/rotation.ts (not integrated)
- `switchToNextRunner()` - ✅ Exists in models/rotation.ts (not integrated)
- `allModelsExhausted()` - ✅ Exists in models/rotation.ts (not integrated)
- `tryRotation()` - ✅ Exists in models/rotation.ts (not integrated)
- `buildSingleIssuePrompt()` - ❌ Needs extraction
- `buildConflictResolutionPrompt()` - ✅ Exists in git/operations.ts (not integrated)
- `parseNoChangesExplanation()` - ✅ Extracted to resolver-proc.ts
- `sanitizeOutputForLog()` - ✅ Extracted to resolver-proc.ts
- `validateDismissalExplanation()` - ✅ Extracted to resolver-proc.ts
- `printUnresolvedIssues()` - ✅ Exists in ui/reporter.ts (not integrated)
- `calculateExpectedBotResponseTime()` - ❌ Needs extraction
- `shouldCheckForNewComments()` - ❌ Needs extraction
- `sleep()` - ✅ Extracted to resolver-proc.ts

**Async Methods (~40+):**
- `printAfterActionReport()` - ✅ Exists in ui/reporter.ts (not integrated)
- `executeBailOut()` - ❌ Needs extraction
- `trySingleIssueFix()` - ❌ Needs extraction
- `tryDirectLLMFix()` - ❌ Needs extraction
- `setupRunner()` - ✅ Exists in models/rotation.ts (not integrated)
- `resolveConflictsWithLLM()` - ✅ Exists in git/operations.ts (not integrated)
- `handleLockFileConflicts()` - ✅ Exists in git/operations.ts (not integrated)
- `findUnresolvedIssues()` - ❌ Needs extraction (~200 lines)
- `ensureStateFileIgnored()` - ❌ Needs extraction
- `cleanupCreatedSyncTargets()` - ✅ Exists in git/operations.ts (not integrated)
- `runCleanupMode()` - ❌ Needs extraction (~150 lines)
- `getCodeSnippet()` - ❌ Needs extraction
- `checkForNewBotReviews()` - ❌ Needs extraction
- `calculateSmartWaitTime()` - ❌ Needs extraction
- `waitForBotReviews()` - ❌ Needs extraction
- **Main `resolve()` method** - ❌ Large orchestration (~1000+ lines)

---

## 📋 Next Steps (Priority Order)

### Phase 1: Integration (Quick Win)
1. **Integrate ui/reporter.ts** into resolver.ts
   - Add import: `import * as Reporter from './ui/reporter.js'`
   - Replace method bodies with delegations
   - Test compilation

2. **Integrate models/rotation.ts** into resolver.ts
   - Add import: `import * as Rotation from './models/rotation.js'`
   - Replace method bodies with delegations
   - Update to use `RotationContext`
   - Test compilation

3. **Integrate git/operations.ts** into resolver.ts
   - Add import: `import * as GitOps from './git/operations.js'`
   - Replace method bodies with delegations
   - Test compilation

**Expected Impact:** Resolver drops from 4,503 → ~3,700 lines

### Phase 2: Extract Remaining Methods
4. **Extract helper methods** to resolver-proc.ts:
   - `buildSingleIssuePrompt()`
   - `calculateExpectedBotResponseTime()`
   - `shouldCheckForNewComments()`
   - `getCodeSnippet()`

5. **Extract medium async methods** to resolver-proc.ts:
   - `executeBailOut()` (~80 lines)
   - `trySingleIssueFix()` (~200 lines)
   - `tryDirectLLMFix()` (~100 lines)
   - `findUnresolvedIssues()` (~200 lines)
   - `ensureStateFileIgnored()` (~50 lines)
   - `runCleanupMode()` (~150 lines)
   - `checkForNewBotReviews()` (~60 lines)
   - `calculateSmartWaitTime()` (~30 lines)
   - `waitForBotReviews()` (~40 lines)

6. **Extract main resolve() method** to resolver-proc.ts:
   - This is the orchestration logic (~1000+ lines)
   - May need to split into multiple procedural functions
   - Create `resolveIterative()` or similar

### Phase 3: Final Cleanup
7. **Convert resolver.ts to thin wrapper**
   - Keep class structure for backward compatibility
   - All methods delegate to resolver-proc.ts functions
   - Similar pattern to StateManager

8. **Final verification**
   - Run full compilation
   - Check all imports
   - Test basic functionality

---

## 💾 File Backups

Created backup before modifications:
- `/tmp/resolver_backup.ts` - Original 4,503 line version

---

## 🎯 Success Metrics

**Target:** Reduce resolver.ts to ~300-500 lines (thin wrapper)
**Current:** 4,503 lines
**Progress:** ~30% (modules created but not integrated)

**Estimated Remaining Effort:**
- Phase 1 (Integration): 2-3 hours
- Phase 2 (Extraction): 8-10 hours  
- Phase 3 (Cleanup): 1-2 hours
- **Total:** ~15 hours of focused refactoring

---

## 📝 Notes

- All completed conversions maintain backward compatibility
- Compilation verified after each major conversion
- Pattern established: procedural functions + deprecated class wrapper
- Git stash contains attempted git operations integration (reverted due to complexity)
- Constants centralized in `src/constants.ts`

---

**Last Updated:** 2026-02-06
**Status:** Partial progress, ready to continue in fresh session
