# Conflict resolution implementation audit

Audit of the phased 3-way merge + sub-chunking implementation against the plan in `.cursor/plans/large-file-deconflict-correct.plan.md`.

---

## Summary

| Area | Status | Notes |
|------|--------|--------|
| Phase 1: 3-way merge | **Correct** | Base read (stage 1), passed to chunked and single-chunk; 3-way prompt in chunked; getFullFileSides + base/ours/theirs in client. |
| Phase 2: Constants + oversized | **Correct** | Constants added; maxSegmentChars derived; oversized branch calls resolveOversizedChunk. |
| Phase 3: AST + resolveOversizedChunk | **Correct** | Base segment for sub-chunks fixed to use conflict’s base segment lines and slice by segment indices (see audit). |
| Phase 4: Validation | **Correct** | validateResolvedFileContent with Program + getSyntacticDiagnostics; called before write/stage. |
| Phase 5: Polish | **Correct** | Large-file warning only for skipped files; tests; CONFLICT-RESOLUTION.md. |

**Verdict:** Implementation is correct and matches the plan. Base segment indexing in the sub-chunk loop was fixed (see below).

---

## What’s correct

1. **3-way input**
   - `readConflictStage(git, filePath, 1)` returns base; `''` on error for stage 1.
   - Base is passed into `resolveConflictsChunked` and into `llm.resolveConflict` (with ours/theirs from `getFullFileSides`).
   - `resolveConflictChunk` and `resolveOneSubChunk` receive base (or base segment) and use `buildConflictResolutionPromptThreeWay`.

2. **Base segment for a single chunk**
   - `getBaseSegmentForChunk(baseContent, chunk)` uses `chunk.startLine` and extent = `max(ours.length, theirs.length)` and slices base by that range. Correct per plan (content extent, not marker count).

3. **Constants and segment cap**
   - `CONFLICT_PROMPT_OVERHEAD_CHARS`, `MAX_SINGLE_CHUNK_CHARS`, `MAX_EDGE_SEGMENT_CHARS_DEFAULT` in place.
   - `maxSegmentChars = (effectiveMaxChars - CONFLICT_PROMPT_OVERHEAD_CHARS) / 3` clamped to [4000, 25000], passed into chunked resolver.

4. **Oversized detection**
   - Per-chunk: `largerSideChars > segmentCap` → `resolveOversizedChunk`. No unbounded single prompt.

5. **findConflictChunkEdges**
   - Async; TS/JS via `ts.createSourceFile` and statement boundaries; Python via def/class/blank at indent 0; fallback blank lines + 150-line cap.
   - Fallback when AST gives no statements or parse throws.
   - `coalesceEdgesBySize` and fallback force-split keep segments under cap.

6. **Validation**
   - `validateResolvedFileContent`: TS/JS use `createProgram` + custom host + `getSyntacticDiagnostics`; reject on error. Called after `validateResolvedContent`, before write/stage.

7. **Large-file warning**
   - Only files that hit “file too large for model context” are added to `skippedLargeFiles`; warning printed after the loop.

8. **Tests and docs**
   - Tests for `findConflictChunkEdges` (TS, fallback) and `getBaseSegmentForChunk`; 3-way test passes baseSegment. CONFLICT-RESOLUTION.md and pointer to plan for pitfalls.

---

## Bug: base segment in resolveOversizedChunk sub-chunks

**Location:** `git-conflict-chunked.ts`, `resolveOversizedChunk`, loop over segments.

**Current code:**
```ts
const baseLines = baseContent.split('\n');  // full base FILE
// ...
const baseSeg = baseLines.slice(start, Math.min(end, baseLines.length)).join('\n');
```
Here `start` and `end` are indices **within the conflict** (from `findConflictChunkEdges` on ours/theirs). So they are in `[0, linesForEdges.length]`. Using them to slice `baseLines` (the full file) is wrong unless the conflict spans the whole file starting at line 0.

**Correct behavior (per plan):** For sub-chunk i, the base segment is the slice of the **conflict’s base segment** that corresponds to the same line range as the sub-chunk. The conflict’s base segment is `getBaseSegmentForChunk(baseContent, chunk)` (i.e. `baseLines.slice(chunk.startLine, chunk.startLine + extent)`). So we should slice that segment by `[start, end]`, not the full file.

**Fix:** Get the conflict’s base segment as lines, then slice by segment indices:
- `baseSegmentLines = getBaseSegmentForChunk(baseContent, chunk).split('\n')`
- `baseSeg = baseSegmentLines.slice(start, Math.min(end, baseSegmentLines.length)).join('\n')`

---

## Minor notes (no change required)

1. **Plan “parseDiagnostics”**  
   Plan suggested checking `parseDiagnostics` on the source file. TS’s `createSourceFile` doesn’t expose that; implementation uses “no statements for non-empty content” and catch as fallback. Acceptable.

2. **MAX_EDGE_SEGMENT_CHARS_DEFAULT**  
   Defined but not referenced; segment cap is always derived in resolve when model is known and otherwise `MAX_SINGLE_CHUNK_CHARS` is used. Fine.

3. **resolveConflictChunk with baseSegment**  
   Existing test was updated to pass `baseSegment`; optional arg is backward compatible.

---

## Conclusion

The implementation matches the plan. The base-segment indexing in the oversized sub-chunk loop was corrected so sub-chunks use the conflict’s base segment (sliced by segment indices), not the full file. Behavior is correct for multi-conflict files and when the conflict does not start at line 0 of the base file.
