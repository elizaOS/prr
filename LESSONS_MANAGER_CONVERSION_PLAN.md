# LessonsManager Conversion Plan

## Status: 20% Complete

### Completed Modules (244 lines)
1. ✅ `lessons-context.ts` (72 lines) - Context interface & setters
2. ✅ `lessons-paths.ts` (56 lines) - Path resolution & constants
3. ✅ `lessons-load.ts` (116 lines) - Loading logic

### Remaining Modules (~1,100 lines to create)

#### 4. lessons-normalize.ts (~250 lines)
**Functions to extract:**
- `normalizeLessonText()` - Clean and normalize lesson text
- `lessonKey()` - Generate unique key for deduplication
- `lessonNearKey()` - Generate fuzzy match key
- `canonicalizeToolAttempts()` - Normalize tool attempt messages
- `sanitizeFilePathHeader()` - Clean file path headers
- `sanitizeLessonsList()` - Clean list of lessons
- `extractLessonFilePath()` - Extract file path from lesson

**Lines in original**: 322-540

#### 5. lessons-parse.ts (~150 lines)
**Functions to extract:**
- `parseMarkdownLessons()` - Parse markdown format lessons
- Helper parsing functions

**Lines in original**: 602-692

#### 6. lessons-format.ts (~200 lines)
**Functions to extract:**
- `toMarkdown()` - Convert to full markdown
- `toCompactedMarkdown()` - Convert to compact markdown for sync
- `getMergedFileEntries()` - Merge and order file entries
- `collectOrphanLessons()` - Find orphan lessons

**Lines in original**: 540-692, 1099-1158

#### 7. lessons-prune.ts (~250 lines)
**Functions to extract:**
- `pruneTransientLessons()` - Remove temporary error lessons
- `sanitizeModelNames()` - Remove model names from lessons
- `pruneRelativeLessons()` - Remove relative reference lessons
- `pruneDeletedFiles()` - Remove lessons for deleted files

**Lines in original**: 738-918

#### 8. lessons-save.ts (~150 lines)
**Functions to extract:**
- `save()` - Save to local storage
- `saveToRepo()` - Save to .prr/lessons.md
- Helper save functions

**Lines in original**: 918-1049

#### 9. lessons-sync.ts (~200 lines)
**Functions to extract:**
- Sync to CLAUDE.md
- Sync to CONVENTIONS.md
- Sync to .cursor/rules
- `cleanupSyncTargets()` - Remove created files
- `didSyncTargetExist()` - Check if file existed before

**Lines in original**: 943-1091

#### 10. lessons-detect.ts (~80 lines)
**Functions to extract:**
- `autoDetectSyncTargets()` - Auto-detect which files to sync to
- Sync target detection logic

**Lines in original**: 168-198

#### 11. lessons-add.ts (~100 lines)
**Functions to extract:**
- `addLesson()` - Add lesson (auto-categorize)
- `addGlobalLesson()` - Add global lesson
- `addFileLesson()` - Add file-specific lesson

**Lines in original**: 1166-1250

#### 12. lessons-retrieve.ts (~100 lines)
**Functions to extract:**
- `getLessonsForFiles()` - Get lessons for specific files
- `getAllLessons()` - Get all lessons
- `getTotalCount()` - Count all lessons
- `getNewLessonsCount()` - Count new lessons this session
- `getCounts()` - Get detailed counts
- `hasNewLessonsForRepo()` - Check if new lessons to save

**Lines in original**: 1250-1320

#### 13. lessons-compact.ts (~50 lines)
**Functions to extract:**
- `compact()` - Compact lessons to size limits

**Lines in original**: 1320-end

#### 14. lessons-utils.ts (~50 lines)
**Utility functions:**
- `formatLessonForDisplay()` - Format for display
- Other small utilities

**Lines in original**: 14-26

## Conversion Pattern (from StateManager)

### 1. Create Context Interface
```typescript
export interface LessonsContext {
  store: LessonsStore;
  workdir: string | null;
  dirty: boolean;
  // ...
}
```

### 2. Create Module with Functions
```typescript
export function addLesson(ctx: LessonsContext, lesson: string): void {
  // Implementation
}
```

### 3. Update Call Sites
```typescript
// Before
lessonsManager.addLesson(lesson);

// After
Lessons.addLesson(lessonsContext, lesson);
```

## Implementation Steps

1. ✅ Create context & paths modules
2. ✅ Create load module
3. ⏳ Create normalize module (~250 lines)
4. ⏳ Create parse module (~150 lines)
5. ⏳ Create format module (~200 lines)
6. ⏳ Create prune module (~250 lines)
7. ⏳ Create save module (~150 lines)
8. ⏳ Create sync module (~200 lines)
9. ⏳ Create detect module (~80 lines)
10. ⏳ Create add module (~100 lines)
11. ⏳ Create retrieve module (~100 lines)
12. ⏳ Create compact module (~50 lines)
13. ⏳ Create utils module (~50 lines)
14. Update all call sites (~20-30 files)
15. Delete original lessons.ts
16. Test compilation and build

## Estimated Final Result

- **Original**: 1,341 lines in 1 file
- **Target**: ~1,100 lines across 14 modules
- **Reduction**: ~240 lines (18%)
- **Max module size**: ~250 lines (normalize & prune)
- **Avg module size**: ~80 lines

## Benefits

1. **Better organization**: Clear separation by functionality
2. **Easier to navigate**: Each module under 250 lines
3. **Easier to test**: Isolated functions with explicit dependencies
4. **Consistent pattern**: Matches StateManager conversion
5. **Maintainable**: Clear module boundaries
