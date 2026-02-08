# git/commit.ts Split Plan

## Current Status
- **Size**: 677 lines
- **Type**: Already procedural (all functions, no classes)
- **Issue**: Mixes multiple concerns in one file

## Proposed Split (5 modules)

### 1. git-commit-core.ts (~35 lines)
**Lines**: 1-34
**Purpose**: Basic commit operations
**Functions**:
- `stageAll()`
- `squashCommit()`
**Types**:
- `CommitResult`

### 2. git-push.ts (~290 lines)
**Lines**: 39-346
**Purpose**: Push operations with timeout/retry/recovery
**Functions**:
- `push()` - Push with timeout and signal handling
- `pushWithRetry()` - Push with automatic retry on conflicts
**Types**:
- `PushResult`
- `PushWithRetryResult`
**Complexity**: High (spawn management, timeout, signals, remote restoration)

### 3. git-commit-query.ts (~25 lines)
**Lines**: 347-367
**Purpose**: Query git information
**Functions**:
- `getCurrentBranch()`
- `getLastCommitHash()`

### 4. git-commit-iteration.ts (~50 lines)
**Lines**: 368-419
**Purpose**: Commit iteration-specific logic
**Functions**:
- `commitIteration()` - Create iteration commit with metadata

### 5. git-commit-scan.ts (~210 lines)
**Lines**: 420-631
**Purpose**: Scan committed fixes
**Functions**:
- `scanCommittedFixes()` - Extract issue IDs from commits

### 6. git-commit-message.ts (~50 lines)
**Lines**: 632-677
**Purpose**: Message formatting utilities
**Functions**:
- `stripMarkdownForCommit()`
- `buildCommitMessage()`

### 7. git-commit-index.ts (~15 lines)
**Purpose**: Re-export facade
**Content**:
```typescript
export * from './git-commit-core.js';
export * from './git-push.js';
export * from './git-commit-query.js';
export * from './git-commit-iteration.js';
export * from './git-commit-scan.js';
export * from './git-commit-message.js';
```

## Result
- **Before**: 677 lines in 1 file
- **After**: ~675 lines across 6 modules + facade
- **Largest module**: git-push.ts (~290 lines)
- **Benefit**: Clear separation of concerns, easier navigation

## Decision
**Proceed?** This is less about "god object" and more about organization.
- ✅ Improves organization
- ✅ Easier to find specific functionality
- ⚠️ Already procedural (no classes to convert)
- ⚠️ Requires updating imports in ~20 files

Alternative: Leave as-is since it's already procedural and working.
