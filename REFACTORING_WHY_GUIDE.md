# Refactoring WHY Guide

## Purpose of This Document

This guide explains the "WHY" behind our refactoring decisions. Every module, every split, every design choice has a reason. This document captures that reasoning for future maintainers.

## Core Philosophy

### Why Eliminate God Objects?

**Problem**: Classes with 1,300+ lines mixing multiple concerns
**Solution**: Split into focused modules by responsibility
**Result**: Easier to navigate, modify, and test

**WHY it matters:**
- Finding code: Know exactly where to look (git-push.ts for push logic, not "somewhere in git operations")
- Changing code: Modify one concern without affecting others
- Understanding code: Each module small enough to hold in your head
- Testing code: Test individual modules, not giant classes

### Why Procedural Instead of Classes?

**Old (class-based):**
```typescript
class StateManager {
  private state: ResolverState;
  
  async loadState() { ... }
  markCommentFixed(id: string) {
    this.state.verifiedComments[id] = true;
  }
}

const mgr = new StateManager();
await mgr.loadState();
mgr.markCommentFixed('id');
```

**New (procedural):**
```typescript
function markCommentFixed(ctx: StateContext, id: string) {
  ctx.state.verifiedComments[id] = true;
}

const ctx = createStateContext();
await loadState(ctx);
markCommentFixed(ctx, 'id');
```

**WHY procedural:**
1. **Explicit State**: See exactly what data flows where (no hidden `this`)
2. **Easier Testing**: Pass mock contexts, test pure functions
3. **Better Composition**: Mix and match functions, no inheritance
4. **Simpler Mental Model**: Functions transform data, no object lifecycle
5. **Clear Dependencies**: Import statements show exactly what's used

**WHY contexts:**
- Replaces class instances with simple data structures
- Same ergonomics as classes (pass context around)
- But explicit (can't forget to pass state)
- And testable (easy to create test contexts)

### Why Module Boundaries Matter

**Bad module boundary (mixed concerns):**
```typescript
// git-operations.ts (505 lines)
export function buildConflictPrompt() { }      // Prompt text
export function handleLockFiles() { }           // Lock file logic
export function resolveWithLLM() { }            // LLM integration
export function cleanupSyncTargets() { }        // File cleanup
```

**Good module boundaries (single concern):**
```typescript
// git-conflict-prompts.ts (36 lines) - Just prompt text
export function buildConflictPrompt() { }

// git-conflict-lockfiles.ts (225 lines) - Just lock file handling
export function handleLockFiles() { }

// git-conflict-resolve.ts (185 lines) - Just LLM resolution
export function resolveWithLLM() { }

// git-conflict-cleanup.ts (65 lines) - Just cleanup
export function cleanupSyncTargets() { }
```

**WHY this matters:**
- **Prompt text changed?** Edit git-conflict-prompts.ts (36 lines, not 505)
- **Lock file bug?** Debug git-conflict-lockfiles.ts (clear scope)
- **Testing LLM?** Mock just git-conflict-resolve.ts (isolated)
- **New cleanup task?** Add to git-conflict-cleanup.ts (obvious location)

## Specific Design Decisions

### Why git-push.ts is Large (328 lines)

**Why we kept it together instead of splitting further:**
- Timeout, auth, and retry logic are tightly coupled
- spawn() process management spans the entire push operation
- Auth token injection/restoration must bracket the push
- Splitting would create artificial boundaries through coupled code

**When to split a module:**
✅ Split when concerns are **independent** (prompts don't affect resolution)
❌ Don't split when concerns are **coupled** (timeout needs auth needs retry)

### Why git-commit vs git-clone Separation

**Why separate commit and clone operations:**
- **Different workflows**: Commits happen during fix iterations, clones happen at startup
- **Different complexity**: Clone is complex (merge, conflicts, stash), commit is simpler
- **Different dependencies**: Clone needs conflict resolution, commit needs message formatting
- **Used separately**: Code that commits doesn't clone, code that clones doesn't commit

**Grouping by workflow** (when used) **not by git command** (what command they use)

### Why State vs Lessons Separation

**Two independent systems:**

**State** (resolver workflow state):
- Which comments were verified?
- Which iteration are we on?
- What models were tried?
- Should we bail out?

**Lessons** (knowledge extracted from reviews):
- What patterns did reviewers flag?
- What fixes were effective?
- What should the fixer avoid?
- What context should be included?

**Why separate:**
- State is workflow-specific (only prr needs it)
- Lessons are knowledge that could be shared across tools
- State is ephemeral (deleted after PR merges)
- Lessons are persistent (kept in repo for future PRs)
- Different data models, different lifecycles, different purposes

### Why Facade Pattern (index.ts Files)

**Without facade:**
```typescript
import { addLesson } from './state/lessons-add.js';
import { getLessonsForFiles } from './state/lessons-retrieve.js';
import { loadLessons } from './state/lessons-load.js';
import { save } from './state/lessons-save.js';
import { syncToTargets } from './state/lessons-sync.js';
// 14 import lines for a complex workflow...
```

**With facade:**
```typescript
import * as LessonsAPI from './state/lessons-index.js';

LessonsAPI.Add.addLesson(ctx, 'text');
LessonsAPI.Retrieve.getLessonsForFiles(ctx, files);
LessonsAPI.Load.loadLessons(ctx);
LessonsAPI.Save.save(ctx);
LessonsAPI.Sync.syncToTargets(ctx);
```

**WHY facades:**
- **Convenience**: One import for related operations
- **Namespacing**: Clear organization (LessonsAPI.Add.*, LessonsAPI.Retrieve.*)
- **Discoverability**: IDE autocomplete shows all available functions
- **Flexibility**: Can still import directly for simple cases

**When to use facade:**
- Complex systems with many functions (Lessons, State)
- Callers typically use multiple functions together
- Want namespace organization

**When to import directly:**
- Simple cases (only need 1-2 functions)
- Want explicit imports for tree shaking

## Common Questions

### "Why not just keep the class and split methods into private methods?"

**Problem with large classes:**
- Private methods still access `this`, still coupled
- Can't test private methods without exposing them
- All code still in one file (navigation problem persists)
- Import of class pulls in all methods (tree shaking fails)

**Solution with modules:**
- Each module independently testable
- Clear boundaries (can't accidentally couple)
- Code in separate files (easy navigation)
- Import only what you need

### "Why is lines of code reduction modest (4-14%)?"

**Answer**: That's not the goal!

**What we gained:**
- **File size**: 1,341 lines → max 328 lines (75% reduction in largest file)
- **Navigability**: Know exactly where to look
- **Testability**: Test modules independently
- **Maintainability**: Localized changes
- **Understandability**: Each module fits in your head

**Line count reduction is a nice side effect**, not the primary goal.

### "How do I decide where to add new code?"

**Use the module structure as a guide:**

**Need to add push timeout handling?**
→ git-push.ts (already handles timeouts)

**Need new commit message formatting?**
→ git-commit-message.ts (message formatting)

**Need to track new verification state?**
→ state-verification.ts (verification tracking)

**Need new lesson normalization?**
→ lessons-normalize.ts (text processing)

**Not sure?**
→ Look at imports of similar code. Where does it get used? Put new code nearby.

## Success Metrics

### Before Refactoring
- ❌ Largest file: 1,341 lines
- ❌ God objects with hidden state
- ❌ Unclear where to add new features
- ❌ Hard to test individual concerns
- ❌ Changes ripple through unrelated code

### After Refactoring
- ✅ Largest file: 328 lines (75% reduction)
- ✅ Explicit state in context objects
- ✅ Clear module boundaries guide new code
- ✅ Modules independently testable
- ✅ Changes localized to single modules

## Future Refactoring Guidelines

### When to Extract a Module

**Extract when:**
- ✅ Function group has clear single purpose
- ✅ Functions are used together frequently
- ✅ Code is reused across different workflows
- ✅ Testing requires isolating specific logic
- ✅ File is becoming hard to navigate (>300 lines)

**Don't extract when:**
- ❌ Functions are tightly coupled (share lots of local state)
- ❌ Only used once in one place
- ❌ Creates circular dependencies
- ❌ Makes the code harder to understand

### When to Use Classes

**Use classes for:**
- ✅ External API/library adapters (LLMClient, GitHubAPI)
- ✅ When you need inheritance/polymorphism
- ✅ When object lifecycle matters (construct, use, dispose)

**Use procedural for:**
- ✅ Domain logic (state, lessons, workflows)
- ✅ Stateless operations (formatting, validation)
- ✅ When data flow should be explicit

### Module Naming Conventions

**Pattern**: `{system}-{concern}.ts`

Examples:
- `git-commit-core.ts` - Git commit system, core operations
- `git-conflict-resolve.ts` - Git conflict system, resolution logic
- `state-verification.ts` - State system, verification tracking
- `lessons-normalize.ts` - Lessons system, text normalization

**Why this pattern:**
- Groups related modules alphabetically
- Makes purpose immediately clear
- Scales well (can add git-commit-hooks.ts, git-conflict-auto.ts, etc)

## Conclusion

Every split, every boundary, every design choice optimizes for:
1. **Understandability** - Can you hold the module in your head?
2. **Navigability** - Can you find the code you need quickly?
3. **Modifiability** - Can you change one thing without breaking others?
4. **Testability** - Can you test this code in isolation?

**Line count reduction is a nice side effect, not the goal.**
**The goal is a codebase that's easier to work with.**
