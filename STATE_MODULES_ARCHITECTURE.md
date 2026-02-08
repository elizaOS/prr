# State Modules Architecture

## Overview

State management is split into 24 focused modules across two main categories:
- **State modules** (10 files): Persist resolver state (iterations, verification, performance)
- **Lessons modules** (14 files): Manage lessons learned from review comments

## State Modules (10 files)

### 1. `state-context.ts` (28 lines)
**Purpose**: Define StateContext interface and factory  
**WHY**: Context object holds state path and current state. Passed to all functions instead of class instance with `this`.

### 2. `state-core.ts` (130 lines)
**Purpose**: Load, save, and basic state operations  
**Functions**: `loadState()`, `saveState()`, `setPhase()`, `markInterrupted()`, `wasInterrupted()`, etc.  
**WHY**: Core persistence logic. All other modules assume state is already loaded.

### 3. `state-verification.ts` (93 lines)
**Purpose**: Track which comments were verified as fixed  
**Functions**: `isCommentVerifiedFixed()`, `markCommentVerifiedFixed()`, `getVerifiedComments()`, etc.  
**WHY**: Verification state is complex (per-iteration tracking, staleness detection). Separated from core state.

### 4. `state-dismissed.ts` (61 lines)
**Purpose**: Track dismissed issues (won't fix, duplicate, etc)  
**Functions**: `addDismissedIssue()`, `getDismissedIssues()`, `isCommentDismissed()`  
**WHY**: Dismissed issues have their own lifecycle. Kept separate from verification tracking.

### 5. `state-lessons.ts` (57 lines)
**Purpose**: Manage lessons in resolver state (wrapper around LessonsManager)  
**Functions**: `addLesson()`, `getLessons()`, `compactLessons()`  
**WHY**: State needs to persist lessons, but actual lessons logic is in lessons-* modules. This is the bridge.

### 6. `state-iterations.ts` (55 lines)
**Purpose**: Track fix iteration history  
**Functions**: `recordIteration()`, `getCurrentIteration()`, `getIterationHistory()`  
**WHY**: Iteration tracking (what was tried, when, with which model) separated from verification tracking.

### 7. `state-rotation.ts` (41 lines)
**Purpose**: Persist model rotation state  
**Functions**: `updateModelRotation()`, `getLastUsedModel()`, `markRotationReset()`  
**WHY**: Model rotation state needs to persist across restarts. Simple enough to be its own module.

### 8. `state-performance.ts` (172 lines)
**Purpose**: Track model performance and generate reports  
**Functions**: `recordModelUsage()`, `getModelStats()`, `generatePerformanceReport()`, etc.  
**WHY**: Performance tracking is complex (per-model stats, success rates, timing). Largest state module.

### 9. `state-bailout.ts` (55 lines)
**Purpose**: Track when to stop trying (bailout conditions)  
**Functions**: `recordBailout()`, `shouldBailOut()`, `getBailoutRecords()`  
**WHY**: Bailout logic (max retries, pattern detection) separated from general state management.

### 10. `index.ts` (14 lines)
**Purpose**: Re-export facade for all state modules  
**WHY**: Single import point: `import * as State from './state/index.js'`

## Lessons Modules (14 files)

### 1. `lessons-context.ts` (72 lines)
**Purpose**: Define LessonsContext and configuration  
**WHY**: Lessons system is independent of resolver state. Context holds owner/repo/branch and sync targets.

### 2. `lessons-paths.ts` (58 lines)
**Purpose**: Path resolution and constants  
**Functions**: `getLocalLessonsPath()`, `getPrrLessonsPath()`  
**Constants**: `SYNC_TARGETS`, `MAX_LESSONS_FOR_SYNC`  
**WHY**: Path logic and constants used across multiple modules. Centralized for consistency.

### 3. `lessons-load.ts` (116 lines)
**Purpose**: Load lessons from disk  
**Functions**: `loadLessons()`, `loadLocalLessons()`, `loadPrrLessons()`  
**WHY**: Loading logic (parsing, error handling, fallbacks) separated from saving.

### 4. `lessons-normalize.ts` (246 lines)
**Purpose**: Text normalization and deduplication  
**Functions**: `normalizeLessonText()`, `lessonKey()`, `canonicalizeToolAttempts()`, `sanitizeFilePathHeader()`, etc.  
**WHY**: Largest lessons module. Text processing is complex (cleaning, deduping, extracting file paths). Isolated from I/O.

### 5. `lessons-parse.ts` (63 lines)
**Purpose**: Parse markdown format to lesson objects  
**Functions**: `parseMarkdownLessons()`  
**WHY**: Parsing logic decoupled from file I/O. Can parse any markdown string.

### 6. `lessons-format.ts` (166 lines)
**Purpose**: Format lessons as markdown  
**Functions**: `toMarkdown()`, `toCompactedMarkdown()`, `collectOrphanLessons()`, etc.  
**WHY**: Formatting logic (grouping by file, sorting, compacting) separated from persistence.

### 7. `lessons-prune.ts` (129 lines)
**Purpose**: Remove stale, transient, or invalid lessons  
**Functions**: `pruneTransientLessons()`, `pruneRelativeLessons()`, `pruneDeletedFiles()`, etc.  
**WHY**: Pruning logic (pattern detection, file existence checks) complex enough for its own module.

### 8. `lessons-save.ts` (44 lines)
**Purpose**: Save lessons to disk  
**Functions**: `save()`, `saveToRepo()`  
**WHY**: Save logic isolated. Handles atomic writes, directory creation.

### 9. `lessons-sync.ts` (89 lines)
**Purpose**: Sync lessons to target files (CLAUDE.md, CONVENTIONS.md)  
**Functions**: `syncToTargets()`, `cleanupSyncTargets()`  
**WHY**: Sync targets have special handling (sections, line limits, creation tracking). Separate workflow.

### 10. `lessons-detect.ts` (37 lines)
**Purpose**: Auto-detect sync target files  
**Functions**: `autoDetectSyncTargets()`, `didSyncTargetExist()`  
**WHY**: Detection logic can change (new file conventions, patterns). Isolated from main sync.

### 11. `lessons-add.ts` (59 lines)
**Purpose**: Add new lessons  
**Functions**: `addLesson()`, `addGlobalLesson()`, `addFileLesson()`  
**WHY**: Add operations need validation, normalization, deduplication. Separated from retrieval.

### 12. `lessons-retrieve.ts` (77 lines)
**Purpose**: Query lessons  
**Functions**: `getLessonsForFiles()`, `getAllLessons()`, `getCounts()`, `hasNewLessonsForRepo()`  
**WHY**: Read operations separated from write operations.

### 13. `lessons-compact.ts` (31 lines)
**Purpose**: Remove duplicate lessons  
**Functions**: `compact()`  
**WHY**: Deduplication after loading. Small enough to be its own module for clarity.

### 14. `lessons-index.ts` (14 lines)
**Purpose**: Re-export facade  
**WHY**: Single import point: `import * as LessonsAPI from './state/lessons-index.js'`

## Design Principles

### 1. Context Objects Instead of Classes
```typescript
// Old (class-based):
const stateManager = new StateManager(workdir);
await stateManager.loadState(pr, branch, sha);
stateManager.markCommentVerifiedFixed(commentId);

// New (procedural):
const stateContext = createStateContext(workdir);
await loadState(stateContext, pr, branch, sha);
markCommentVerifiedFixed(stateContext, commentId);
```

**WHY contexts instead of classes:**
- Explicit state passing (no hidden `this`)
- Easier to test (pass mock context)
- No inheritance complexity
- Functions can be independently tested
- Clearer data flow

### 2. Separation of Concerns
Each module has one clear purpose:
- I/O separate from logic (load/save vs normalize/format)
- Queries separate from mutations (retrieve vs add)
- Subsystems separate (verification vs iterations vs performance)

**WHY**: Changes localized. Need to modify formatting? Check lessons-format.ts. Need to change how verification is tracked? Check state-verification.ts.

### 3. Small, Focused Modules
Average module size: 70 lines. Largest: 246 lines (lessons-normalize.ts).

**WHY**: Easy to understand, modify, and test. The entire module fits in your head.

### 4. Explicit Dependencies
Import only what you need:
```typescript
import { loadState, saveState } from './state/state-core.js';
import { markCommentVerifiedFixed } from './state/state-verification.js';
```

**WHY**: Clear dependencies. TypeScript catches missing imports immediately.

### 5. Facade Pattern for Convenience
```typescript
// Direct imports (if you only need a few functions):
import { addLesson } from './state/lessons-add.js';
import { getLessonsForFiles } from './state/lessons-retrieve.js';

// Facade (if you need many functions):
import * as LessonsAPI from './state/lessons-index.js';
LessonsAPI.Add.addLesson(context, 'lesson text');
LessonsAPI.Retrieve.getLessonsForFiles(context, files);
```

**WHY**: Best of both worlds - explicit imports for simple cases, namespace for complex cases.

## Usage Examples

### State Management
```typescript
import { createStateContext } from './state/state-context.js';
import { loadState, saveState } from './state/state-core.js';
import { markCommentVerifiedFixed } from './state/state-verification.js';
import { recordIteration } from './state/state-iterations.js';

// Create context
const ctx = createStateContext(workdir);

// Load state
await loadState(ctx, prNumber, branch, headSha);

// Use state
markCommentVerifiedFixed(ctx, commentId);
recordIteration(ctx, {
  number: 1,
  model: 'claude-sonnet',
  success: true,
  // ...
});

// Save state
await saveState(ctx);
```

### Lessons Management
```typescript
import * as LessonsAPI from './state/lessons-index.js';

// Create context
const ctx = LessonsAPI.createLessonsContext(owner, repo, branch, workdir);

// Load lessons
await LessonsAPI.Load.loadLessons(ctx);

// Add lesson
LessonsAPI.Add.addFileLesson(
  ctx,
  'src/foo.ts',
  'Always validate input before processing'
);

// Get lessons for specific files
const lessons = LessonsAPI.Retrieve.getLessonsForFiles(ctx, ['src/foo.ts']);

// Save lessons
await LessonsAPI.Save.save(ctx);

// Sync to CLAUDE.md
await LessonsAPI.Sync.syncToTargets(ctx);
```

## Migration from Class-Based Code

### Old (StateManager class):
```typescript
const stateManager = new StateManager(workdir);
await stateManager.loadState(pr, branch, sha);

if (stateManager.isCommentVerifiedFixed(commentId)) {
  // already fixed
}

stateManager.recordIteration({...});
await stateManager.saveState();
```

### New (Procedural):
```typescript
import * as State from './state/index.js';

const ctx = State.createStateContext(workdir);
await State.loadState(ctx, pr, branch, sha);

if (State.isCommentVerifiedFixed(ctx, commentId)) {
  // already fixed
}

State.recordIteration(ctx, {...});
await State.saveState(ctx);
```

### Old (LessonsManager class):
```typescript
const lessonsManager = new LessonsManager(owner, repo, branch);
await lessonsManager.loadLessons();

lessonsManager.addLesson('Always use const');
const lessons = lessonsManager.getLessonsForFiles(['src/foo.ts']);

await lessonsManager.save();
```

### New (Procedural):
```typescript
import * as LessonsAPI from './state/lessons-index.js';

const ctx = LessonsAPI.createLessonsContext(owner, repo, branch, workdir);
await LessonsAPI.Load.loadLessons(ctx);

LessonsAPI.Add.addGlobalLesson(ctx, 'Always use const');
const lessons = LessonsAPI.Retrieve.getLessonsForFiles(ctx, ['src/foo.ts']);

await LessonsAPI.Save.save(ctx);
```

## Benefits

1. **No Hidden State**: Everything is explicit - no `this`, no private fields
2. **Easier Testing**: Pass mock contexts, test pure functions
3. **Better Composition**: Mix and match functions as needed
4. **Clearer Data Flow**: See exactly what data goes where
5. **Simpler Mental Model**: Functions transform data, no object lifecycle to track
6. **Better Tree Shaking**: Import only what you use, unused code eliminated

## File Size Comparison

### Before (Classes)
- StateManager: 782 lines
- LessonsManager: 1,341 lines
- **Total**: 2,123 lines in 2 files

### After (Procedural Modules)
- State modules: 645 lines in 10 files (avg 64 lines)
- Lessons modules: 1,175 lines in 14 files (avg 84 lines)
- **Total**: 1,820 lines in 24 files
- **Reduction**: 303 lines (14.3%)

More importantly: **Largest file went from 1,341 → 246 lines** (82% reduction)
