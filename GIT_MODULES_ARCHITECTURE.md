# Git Modules Architecture

## Overview

The git operations are split into 19 focused modules organized by responsibility.
Each module handles a specific aspect of git workflows with clear boundaries.

## Module Organization

### Commit Operations (7 modules)

#### 1. `git-commit-core.ts` (35 lines)
**Purpose**: Basic staging and committing  
**Functions**: `stageAll()`, `squashCommit()`  
**WHY**: Foundation operations used by other modules. No complex logic, just clean wrappers around simple-git.

#### 2. `git-commit-query.ts` (17 lines)
**Purpose**: Read-only git queries  
**Functions**: `getCurrentBranch()`, `getLastCommitHash()`  
**WHY**: Pure queries separated from mutations. Safe to call anywhere without side effects.

#### 3. `git-commit-iteration.ts` (52 lines)
**Purpose**: Commits with prr-fix markers for recovery  
**Functions**: `commitIteration()`  
**WHY**: Iteration commits need special handling (markers, skip hooks, specific format). Doesn't belong in generic commit operations.

#### 4. `git-commit-scan.ts` (51 lines)
**Purpose**: Extract prr-fix markers from git history  
**Functions**: `scanCommittedFixes()`  
**WHY**: Recovery logic - scans commits to restore state after interruption. Paired with iteration commit creation.

#### 5. `git-commit-message.ts` (160 lines)
**Purpose**: Format commit messages from issue data  
**Functions**: `buildCommitMessage()`, `stripMarkdownForCommit()`, helpers  
**WHY**: Complex message formatting logic (scope detection, description extraction, markdown cleanup) isolated from commit operations.

#### 6. `git-push.ts` (328 lines)
**Purpose**: Push with timeout, retry, and auth handling  
**Functions**: `push()`, `pushWithRetry()`  
**WHY**: Most complex commit module. Uses spawn() for process control, handles auth injection, implements retry with pull. Kept separate due to complexity.

#### 7. `git-commit-index.ts` (9 lines)
**Purpose**: Re-export facade  
**WHY**: Single import point for all commit operations.

### Clone/Update Operations (7 modules)

#### 1. `git-clone-core.ts` (110 lines)
**Purpose**: Clone or update repository  
**Functions**: `cloneOrUpdate()`  
**WHY**: Main entry point for getting a working repository. Handles both initial clone and updates of existing repos.

#### 2. `git-diff.ts` (43 lines)
**Purpose**: Query changes and diffs  
**Functions**: `getChangedFiles()`, `getDiff()`, `getDiffForFile()`, `hasChanges()`  
**WHY**: Read-only diff operations used by multiple workflows. Separated from mutations.

#### 3. `git-conflicts.ts` (73 lines)
**Purpose**: Detect and check for merge conflicts  
**Functions**: `checkForConflicts()`, `checkRemoteAhead()`  
**WHY**: Conflict detection logic used before pulls and merges. Separated from resolution.

#### 4. `git-pull.ts` (161 lines)
**Purpose**: Pull with auto-stash and conflict handling  
**Functions**: `pullLatest()`  
**WHY**: Complex pull logic (stash, pull, pop, handle conflicts). Kept separate from simple clone.

#### 5. `git-merge.ts` (221 lines)
**Purpose**: Merge operations and state cleanup  
**Functions**: `mergeBaseBranch()`, `startMergeForConflictResolution()`, `completeMerge()`, `cleanupGitState()`, helpers  
**WHY**: Merge workflows are complex and distinct from clone/pull. Includes conflict marker handling and git state cleanup.

#### 6. `git-lock-files.ts` (43 lines)
**Purpose**: Lock file detection and info  
**Functions**: `isLockFile()`, `getLockFileInfo()`, `hasConflictMarkers()`, `findFilesWithConflictMarkers()`  
**WHY**: Reusable utilities for lock file handling. Used by both merge and conflict resolution modules.

#### 7. `git-clone-index.ts` (10 lines)
**Purpose**: Re-export facade  
**WHY**: Single import point for all clone/update operations.

### Conflict Resolution Operations (5 modules)

#### 1. `git-conflict-prompts.ts` (36 lines)
**Purpose**: Build prompts for LLM conflict resolution  
**Functions**: `buildConflictResolutionPrompt()`  
**WHY**: Prompt text isolated from resolution logic. Easy to modify/improve prompts without touching complex code.

#### 2. `git-conflict-lockfiles.ts` (225 lines)
**Purpose**: Handle lock file conflicts automatically  
**Functions**: `handleLockFileConflicts()`  
**WHY**: Lock files can't be merged manually - must be regenerated. This is a complete sub-workflow (detect, delete, stage, tell user how to regenerate).

#### 3. `git-conflict-resolve.ts` (185 lines)
**Purpose**: Use LLM to resolve merge conflicts  
**Functions**: `resolveConflictsWithLLM()`  
**WHY**: Complex workflow involving file size checks, lock file handling, LLM invocation, verification. Separated from simpler conflict detection.

#### 4. `git-conflict-cleanup.ts` (65 lines)
**Purpose**: Clean up files created by prr  
**Functions**: `cleanupCreatedSyncTargets()`  
**WHY**: Specific cleanup logic for CLAUDE.md and CONVENTIONS.md. Separated because it's called at workflow end, not during conflict resolution.

#### 5. `git-operations-index.ts` (8 lines)
**Purpose**: Re-export facade  
**WHY**: Single import point for all conflict operations.

## Design Principles

### 1. Separation by Workflow Phase
Modules are grouped by when they're used, not by which git command they wrap:
- **Commit**: Operations used during fix iterations
- **Clone**: Operations used during repository setup
- **Conflict**: Operations used during merge conflict resolution

WHY: Improves cohesion - code that's used together lives together.

### 2. Complexity Isolation
Complex operations (push with retry, conflict resolution) are in their own modules.

WHY: Makes simple operations easy to understand without wading through error handling, retry logic, and edge cases.

### 3. Query/Mutation Separation
Read-only queries separated from state-changing operations.

WHY: Queries are safe to call anywhere. Separation makes side effects explicit.

### 4. Single Responsibility
Each module has one clear purpose. No "utility grab bags".

WHY: Easy to find code - if you need to modify push logic, check git-push.ts. If you need to modify conflict prompts, check git-conflict-prompts.ts.

### 5. Facade Pattern
Index files re-export related modules for convenient imports.

WHY: Callers can `import * as GitCommit from './git-commit-index.js'` instead of importing from 7 separate files. Maintains encapsulation while providing convenience.

## Usage Examples

### Commit a fix iteration
```typescript
import { commitIteration } from './git/git-commit-iteration.js';

const result = await commitIteration(
  git,
  ['comment-id-1', 'comment-id-2'],
  3, // iteration number
  [{ filePath: 'src/foo.ts', comment: 'Fix type error' }]
);

if (result) {
  console.log(`Committed ${result.filesChanged} files: ${result.hash}`);
}
```

### Push with automatic retry
```typescript
import { pushWithRetry } from './git/git-push.js';

const result = await pushWithRetry(
  git,
  branch,
  false, // not force push
  githubToken,
  3 // max retries
);

if (result.success) {
  console.log(`Pushed after ${result.retryCount} attempts`);
}
```

### Handle merge conflicts
```typescript
import { handleLockFileConflicts } from './git/git-conflict-lockfiles.js';
import { resolveConflictsWithLLM } from './git/git-conflict-resolve.js';

// First, handle lock files automatically
const { handledLockFiles, remainingConflicts } = 
  await handleLockFileConflicts(git, workdir, conflictedFiles, config);

// Then use LLM for remaining files
if (remainingConflicts.length > 0) {
  await resolveConflictsWithLLM(
    git, workdir, remainingConflicts, baseBranch,
    runner, lessonsContext, config
  );
}
```

## Migration from Old Code

### Old (monolithic git/commit.ts)
```typescript
import { squashCommit, push, getCurrentBranch } from './git/commit.js';
```

### New (modular)
```typescript
import { squashCommit } from './git/git-commit-core.js';
import { push } from './git/git-push.js';
import { getCurrentBranch } from './git/git-commit-query.js';

// Or use facade:
import * as GitCommit from './git/git-commit-index.js';
const branch = await GitCommit.getCurrentBranch(git);
```

## Benefits

1. **Easier to Navigate**: Find what you need by module name
2. **Easier to Test**: Test modules independently
3. **Easier to Modify**: Changes localized to specific modules
4. **Clearer Dependencies**: Import statements show exactly what's used
5. **Better Collaboration**: Smaller files, less merge conflicts

## File Size Comparison

### Before
- git/commit.ts: 677 lines
- git/clone.ts: 624 lines
- git/operations.ts: 505 lines
- **Total**: 1,806 lines in 3 files

### After
- Largest module: git-push.ts (328 lines)
- Average module: 91 lines
- **Total**: 1,733 lines in 19 modules
- **Reduction**: 73 lines (4%)

The line count reduction is modest, but the organizational improvement is significant.
