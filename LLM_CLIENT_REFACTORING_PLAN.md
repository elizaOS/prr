# LLMClient Refactoring Plan

## Status: STARTED (Core API Complete)

### Current Progress
- ✅ **llm-context.ts** (51 lines) - Context interface, types
- ✅ **llm-core.ts** (153 lines) - Core API adapter (complete, completeAnthropic, completeOpenAI)

**Total Created**: 204 lines

### Remaining Work (888 lines to extract)

#### 1. llm-issue-checker.ts (~330 lines)
**Lines**: 203-532 in client.ts
**Functions**:
- `checkIssueExists()` - Single issue check
- `batchCheckIssuesExist()` - Batch check with dynamic batching
- Helper: `buildIssueText()` (inline in batchCheck)

**Complexity**: High (batching logic, model recommendation parsing)

#### 2. llm-audit.ts (~159 lines)
**Lines**: 533-691 in client.ts
**Functions**:
- `finalAudit()` - Adversarial re-verification
- Helper: `buildIssueText()` method reference

**Complexity**: Medium (similar to batchCheck but adversarial)

#### 3. llm-verifier.ts (~184 lines)
**Lines**: 692-875 in client.ts
**Functions**:
- `verifyFix()` - Single fix verification
- `analyzeFailedFix()` - Analyze why fix failed
- `batchVerifyFixes()` - Batch verification

**Complexity**: Medium

#### 4. llm-conflicts.ts (~118 lines)
**Lines**: 876-993 in client.ts
**Functions**:
- `resolveConflict()` - Merge conflict resolution

**Complexity**: Low

#### 5. llm-commits.ts (~99 lines)
**Lines**: 994-1092 in client.ts
**Functions**:
- `generateCommitMessage()` - Generate commit messages

**Complexity**: Low

#### 6. llm-index.ts (~10 lines)
**Purpose**: Re-export facade
**Content**:
```typescript
export * from './llm-context.js';
export * as Core from './llm-core.js';
export * as IssueChecker from './llm-issue-checker.js';
export * as Audit from './llm-audit.js';
export * as Verifier from './llm-verifier.js';
export * as Conflicts from './llm-conflicts.js';
export * as Commits from './llm-commits.js';
```

### Integration Work (~50-70 files)

**Files using LLMClient**:
- All workflow files using verification
- Issue analysis
- Commit generation
- Conflict resolution
- Any code calling `llmClient.method()`

**Changes Required**:
1. Import LLMClient → import LLMContext + modules
2. `new LLMClient(config)` → `createLLMContext(...)`
3. `llmClient.method()` → `Module.method(ctx, ...)`

### Why Pause Here

**Reasons**:
1. **Core is complete** - API adapter cleanly extracted
2. **Pattern is proven** - Same as StateManager/LessonsManager
3. **Remaining is straightforward** - Similar extraction process
4. **Time investment** - Each module needs ~30 min to extract properly
5. **Can continue anytime** - Clear plan and structure established

### Estimated Remaining Time

- **Module Extraction**: ~2-3 hours (5 modules × 30-40 min each)
- **Integration**: ~1-2 hours (update call sites)
- **Testing**: ~30 min (compilation + verification)
- **Total**: ~4-5 hours

### Benefits When Complete

- ✅ No more god objects in codebase
- ✅ 1,092 lines → ~1,000 lines across 6 modules
- ✅ Clear separation: API vs domain logic
- ✅ Easier testing (isolated functions)
- ✅ Better file navigation

### Next Steps (When Resuming)

1. Create `llm-issue-checker.ts` (330 lines)
   - Extract lines 203-532
   - Convert class methods to functions
   - Add imports and exports
   
2. Create `llm-audit.ts` (159 lines)
   - Extract lines 533-691
   - Convert methods
   
3. Create `llm-verifier.ts` (184 lines)
   - Extract lines 692-875
   
4. Create `llm-conflicts.ts` (118 lines)
   - Extract lines 876-993
   
5. Create `llm-commits.ts` (99 lines)
   - Extract lines 994-1092
   
6. Create `llm-index.ts` (10 lines)
   - Re-export facade
   
7. Update all call sites
   - Find with: `grep -r "LLMClient" src`
   - Update imports and method calls
   
8. Delete `src/llm/client.ts`

9. Test compilation

### Alternative: Keep as-is

**Arguments for leaving LLMClient as a class**:
- It's primarily an API adapter (legitimate use of classes)
- 1,092 lines, while large, is not catastrophic
- Already well-documented
- Working correctly

**Arguments for refactoring**:
- Mixing API adapter with domain logic (issue checking, audit, verification)
- Would benefit from testing in isolation
- Consistent with rest of codebase (procedural)
- Easier to understand individual concerns

### Recommendation

**Short-term**: Keep LLMClient as-is (working, not critical)
**Long-term**: Complete refactoring when time permits (consistency + testability)

---

*Status: Core API extracted, 5 modules remaining*
*Time invested: ~45 min*
*Time remaining: ~4-5 hours*
