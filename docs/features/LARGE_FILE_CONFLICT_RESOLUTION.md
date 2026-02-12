# Large File Conflict Resolution

## Problem

Previously, `prr` could not automatically resolve merge conflicts in files larger than 50KB due to LLM token limits. This often left users with manual work on large configuration files, generated code, or lock files.

## Solution

`prr` now uses **multiple strategies** to resolve conflicts in files of any size:

### 1. Heuristic Resolution (Fastest)

For structured files with predictable patterns, `prr` uses rule-based resolution:

- **`package.json`**: Automatically merges dependencies, preferring higher version numbers
- **Lock files** (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`): Recommends regeneration

**Advantages:**
- Instant resolution (no API calls)
- No token usage
- Deterministic behavior

### 2. Chunked Resolution (For Large Files)

When files exceed 50KB, `prr` automatically switches to chunked strategy:

1. **Extract conflicts**: Parse file to find individual conflict regions (`<<<<<<<` to `>>>>>>>`)
2. **Add context**: Include 10 lines before/after each conflict for understanding
3. **Resolve separately**: Send each conflict chunk to LLM (stays well under token limits)
4. **Reconstruct**: Merge all resolved chunks back into original file structure

**Example:**
```texttexttext
File: 150KB source file with 8 conflicts
├─ Conflict 1 (lines 100-150) + context → Resolved ✓
├─ Conflict 2 (lines 340-380) + context → Resolved ✓
├─ Conflict 3 (lines 890-920) + context → Resolved ✓
...
└─ Reconstructed: Full 150KB file with all conflicts resolved
```

**Advantages:**
- Handles files of **any size**
- Each chunk stays within token limits (~2-5KB per chunk)
- LLM has focused context for better resolution quality
- Parallel resolution possible (future optimization)

### 3. Standard Resolution (For Small Files)

Files under 50KB continue to use the original strategy: send entire file to LLM for resolution in one pass.

## How It Works

The resolution strategy is chosen automatically based on file characteristics:

```typescript
// From src/git/git-conflict-resolve.ts

// 1. Try heuristic first (package.json, etc.)
let result = tryHeuristicResolution(conflictFile, conflictedContent);

if (!result.resolved) {
  // 2. Choose LLM strategy based on size
  if (fileSize > 50KB) {
    result = await resolveConflictsChunked(...);  // Chunked strategy
  } else {
    result = await llm.resolveConflict(...);      // Standard strategy
  }
}
```

## Token Usage

**Before (rejected large files):**
- 50KB file → ❌ "File too large for automatic resolution"
- Manual intervention required

**After (chunked resolution):**
- 50KB file with 5 conflicts → 5 chunks × ~4KB each = ~20KB total
- Each chunk: ~2K input tokens + ~500 output tokens
- Total: ~12,500 tokens (well within any model's limits)

## Configuration

No configuration needed - the system automatically selects the best strategy.

However, you can monitor which strategy was used:

```bash
# Output shows strategy selection:
    Resolving: src/large-file.ts
    → Using chunked strategy (120KB file)
    ✓ src/large-file.ts: Resolved 8 conflict(s)
```

## Limitations

While chunked resolution works for most files, some edge cases remain:

1. **Very dense conflicts**: Files where every line is in conflict (rare)
2. **Context dependencies**: Conflicts that require understanding distant code (mitigated by context lines)
3. **Semantic conflicts**: Logic conflicts that aren't textual (requires human judgment)

For these cases, `prr` will report the issue and provide manual resolution instructions.

## Implementation Files

- **`src/git/git-conflict-chunked.ts`**: Chunked resolution engine
  - `extractConflictChunks()` - Parse file into conflict regions
  - `resolveConflictChunk()` - Resolve single chunk with LLM
  - `resolveConflictsChunked()` - Orchestrate full file resolution
  - `tryHeuristicResolution()` - Rule-based resolution
  
- **`src/git/git-conflict-resolve.ts`**: Main conflict resolution orchestrator
  - Strategy selection logic
  - Integration with existing resolution flow

## Future Improvements

1. **Parallel resolution**: Resolve multiple chunks concurrently (10x speedup for large files)
2. **Semantic merging**: Use AST parsing for better code conflict resolution
3. **Learning system**: Track success rates per strategy, auto-tune selection
4. **Interactive mode**: Preview resolutions before applying
5. **More heuristics**: Add rules for common file types (Dockerfile, YAML configs, etc.)

## Testing

To test with large files:

```bash
# Create a test branch with large file conflicts
git checkout feature-branch
# ... edit large file ...
git checkout main
git merge feature-branch  # Creates conflicts

# Run prr
bun run src/index.ts https://github.com/user/repo/pull/123

# Observe chunked resolution in action
```
