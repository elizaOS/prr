/**
 * Chunked conflict resolution for large files
 *
 * WHY: Large files (>50KB) exceed LLM token limits when sent whole.
 * This module extracts individual conflict regions, resolves them separately,
 * and reconstructs the file - enabling programmatic resolution of any size file.
 */

import type { LLMClient } from '../llm/client.js';
import { debug } from '../../../shared/logger.js';
import {
  MIN_CONFLICT_RESOLUTION_SIZE_RATIO,
  MIN_LINES_FOR_SIZE_REGRESSION_CHECK,
  ASYMMETRIC_CONFLICT_SIDE_RATIO,
  MAX_SINGLE_CHUNK_CHARS,
  FILE_OVERVIEW_SEGMENT_CHARS,
  FILE_OVERVIEW_MIN_CHUNKS,
  FILE_OVERVIEW_MIN_FILE_CHARS,
  TOP_TAILS_FALLBACK_MAX_CHUNK_LINES,
  TOP_TAILS_CONTEXT_LINES,
  TOP_TAILS_TOP_CONFLICT_LINES,
  TOP_TAILS_TAIL_LINES,
  TOP_TAILS_TWO_PASS_THRESHOLD_LINES,
} from '../../../shared/constants.js';

/**
 * A single conflict region extracted from a file
 */
export interface ConflictChunk {
  /** Line index where conflict starts (inclusive) */
  startLine: number;
  /** Line index where conflict ends (inclusive) */
  endLine: number;
  /** Lines before the conflict marker (for context) */
  contextBefore: string[];
  /** The conflicted section including markers */
  conflictLines: string[];
  /** Lines after the conflict marker (for context) */
  contextAfter: string[];
  /** All lines as single string for LLM */
  fullContent: string;
}

/**
 * Reconstruct the full file as "ours" (each conflict region replaced by our side) and "theirs".
 * WHY: For single-chunk (whole-file) resolution the LLM client needs base + full ours + full theirs,
 * not the raw conflicted content with markers; this gives the model three complete file versions.
 */
export function getFullFileSides(content: string): { ours: string; theirs: string } {
  const lines = content.split('\n');
  const chunks = extractConflictChunks(content, 0);
  if (chunks.length === 0) return { ours: content, theirs: content };
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let i = 0;
  for (const chunk of chunks.sort((a, b) => a.startLine - b.startLine)) {
    while (i < chunk.startLine) {
      const line = lines[i]!;
      oursLines.push(line);
      theirsLines.push(line);
      i++;
    }
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);
    oursLines.push(...ours);
    theirsLines.push(...theirs);
    i = chunk.endLine + 1;
  }
  while (i < lines.length) {
    const line = lines[i]!;
    oursLines.push(line);
    theirsLines.push(line);
    i++;
  }
  return { ours: oursLines.join('\n'), theirs: theirsLines.join('\n') };
}

/**
 * Derive the base file segment corresponding to a conflict chunk.
 * WHY content extent: We use max(ours.length, theirs.length) so we don't rely on marker line count; the
 * conflicted file has extra lines (<<<<<<<, =======, >>>>>>>) so base line range is content-based.
 * WHY chunk.startLine: In the base file the same logical region starts at the same line index when
 * pre-conflict lines are unchanged; when base is shorter we slice up to baseLines.length.
 */
export function getBaseSegmentForChunk(baseContent: string, chunk: ConflictChunk): string {
  const baseLines = baseContent.split('\n');
  if (baseLines.length === 0) return '';
  const { ours, theirs } = extractConflictSides(chunk.conflictLines);
  const extent = Math.max(ours.length, theirs.length);
  const start = chunk.startLine;
  const end = Math.min(start + extent, baseLines.length);
  if (start >= baseLines.length) return '';
  return baseLines.slice(start, end).join('\n');
}

/**
 * Build a 3-way merge resolution prompt: BASE + OURS + THEIRS.
 * WHY: Correct merge resolution requires the common ancestor so the LLM can merge both changes relative to base.
 * Optional fileOverview: short "story" of the file and what OURS vs THEIRS change (from shared overview step).
 */
export function buildConflictResolutionPromptThreeWay(
  baseSegment: string,
  oursSegment: string,
  theirsSegment: string,
  baseBranch: string,
  filePath?: string,
  previousParseError?: string,
  fileOverview?: string
): string {
  const fileHint = filePath ? `FILE: ${filePath}\n` : '';
  const overviewBlock = fileOverview
    ? `FILE OVERVIEW (use for context when merging):\n${fileOverview}\n\n`
    : '';
  const parseHint = previousParseError
    ? `\n\nIMPORTANT: A previous resolution attempt had a syntax/parse error: "${previousParseError}". Ensure the RESOLVED code is complete, valid code (e.g. close all block comments with */, no missing commas or brackets).\n`
    : '';
  return `${fileHint}${overviewBlock}Merge the changes from both sides relative to BASE. Produce a single resolved version (no conflict markers).${parseHint}

BASE (common ancestor):
\`\`\`
${baseSegment || '(empty)'}
\`\`\`

OURS (HEAD):
\`\`\`
${oursSegment}
\`\`\`

THEIRS (${baseBranch}):
\`\`\`
${theirsSegment}
\`\`\`

Return exactly:
RESOLVED:
\`\`\`
<resolved lines only>
\`\`\`
EXPLANATION: <one sentence>`;
}

/**
 * Extract the "ours" and "theirs" sides from conflict lines.
 * WHY: Needed for size comparison heuristics and stub-vs-comprehensive detection.
 */
export function extractConflictSides(conflictLines: string[]): { ours: string[]; theirs: string[] } {
  const ours: string[] = [];
  const theirs: string[] = [];
  let inTheirs = false;

  for (const line of conflictLines) {
    if (line.startsWith('<<<<<<<')) continue;
    if (line.startsWith('=======')) { inTheirs = true; continue; }
    if (line.startsWith('>>>>>>>')) continue;
    if (inTheirs) theirs.push(line);
    else ours.push(line);
  }

  return { ours, theirs };
}

/**
 * Extract all conflict regions from a file
 * WHY: Parse once, resolve many - more efficient than regex searching repeatedly
 */
export function extractConflictChunks(
  content: string,
  contextLines: number = 10
): ConflictChunk[] {
  const lines = content.split('\n');
  const chunks: ConflictChunk[] = [];
  let i = 0;

  while (i < lines.length) {
    // Find conflict marker
    if (lines[i].startsWith('<<<<<<<')) {
      const startLine = i;
      const contextBefore = lines.slice(Math.max(0, i - contextLines), i);

      // Find end of conflict (>>>>>>)
      let endLine = i;
      const conflictLines: string[] = [];

      while (endLine < lines.length && !lines[endLine].startsWith('>>>>>>>')) {
        conflictLines.push(lines[endLine]);
        endLine++;
      }

      if (endLine < lines.length) {
        conflictLines.push(lines[endLine]); // Include >>>>>>> line
        endLine++;

        const contextAfter = lines.slice(endLine, Math.min(lines.length, endLine + contextLines));

        chunks.push({
          startLine,
          endLine: endLine - 1,
          contextBefore,
          conflictLines,
          contextAfter,
          fullContent: [
            ...contextBefore,
            ...conflictLines,
            ...contextAfter
          ].join('\n')
        });

        i = endLine;
      } else {
        // Malformed conflict (no closing marker)
        debug('Malformed conflict marker - no closing >>>>>>>', { startLine });
        i++;
      }
    } else {
      i++;
    }
  }

  return chunks;
}

/**
 * Split content into consecutive full-content segments (no truncation; split at line boundaries).
 * Used for "full read" story when the file is too large for one request.
 */
function splitFileIntoFullSegments(content: string, maxSegmentChars: number): string[] {
  const segments: string[] = [];
  const lines = content.split('\n');
  let current: string[] = [];
  let currentChars = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (currentChars + lineLen > maxSegmentChars && current.length > 0) {
      segments.push(current.join('\n'));
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += lineLen;
  }
  if (current.length > 0) segments.push(current.join('\n'));
  return segments;
}

/**
 * Build the prompt for one "full read" story request: full file content (or one full segment) and instructions
 * to tell the story of the file and what OURS vs THEIRS are changing. No previews or truncation.
 */
function buildFileStoryPrompt(
  filePath: string,
  baseBranch: string,
  segmentContent: string,
  segmentIndex?: number,
  totalSegments?: number,
  previousStory?: string
): string {
  const header = `File: ${filePath}\nMerging branch: ${baseBranch}\n`;
  const segmentHint =
    totalSegments != null && totalSegments > 1
      ? `This is segment ${(segmentIndex ?? 0) + 1} of ${totalSegments} of the full file (full read, no truncation).\n\n`
      : 'Below is the full file content.\n\n';
  const previousBlock =
    previousStory != null && previousStory.length > 0
      ? `Story so far:\n${previousStory}\n\n`
      : '';
  const instruction =
    totalSegments != null && totalSegments > 1 && (segmentIndex ?? 0) > 0
      ? 'Extend the story to include this part. Keep a single coherent summary (2-4 sentences total) of what this file does and what OURS vs THEIRS are changing. Reply with only that summary, no code.'
      : 'Read the entire content. In 2-4 sentences, tell the story: what is this file\'s purpose and what are OURS vs THEIRS changing? Reply with only that summary, no code.';
  return `${header}${segmentHint}${previousBlock}\`\`\`\n${segmentContent}\n\`\`\`\n\n${instruction}`;
}

/**
 * Fetch a "file story" by doing a full read of the file in consecutive full-content segments (no cap;
 * we always chunk). Each segment is sent in full; the story is built across turns. Returns null if
 * overview is skipped or the LLM calls fail.
 */
export async function getFileConflictOverview(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string,
  model?: string
): Promise<string | null> {
  const chunks = extractConflictChunks(content);
  if (chunks.length < FILE_OVERVIEW_MIN_CHUNKS && content.length < FILE_OVERVIEW_MIN_FILE_CHARS) {
    return null;
  }
  return getFileConflictOverviewInternal(llm, filePath, content, baseBranch, model);
}

/**
 * Always build file story by chunking the entire file (full read in segments). Used by top+tails fallback
 * so we "process the entire file" and give every resolution prompt a consistent story.
 * WHY: When the fallback runs, we want every conflict-resolution prompt to see the same file "map";
 * getFileConflictOverview() skips small files, but in fallback we always need the story so the model
 * has context for top+tails resolution.
 */
export async function getFileConflictOverviewAlways(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string,
  model?: string
): Promise<string | null> {
  return getFileConflictOverviewInternal(llm, filePath, content, baseBranch, model);
}

async function getFileConflictOverviewInternal(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string,
  model?: string
): Promise<string | null> {
  const opts = model ? { model } : undefined;
  try {
    const segments = splitFileIntoFullSegments(content, FILE_OVERVIEW_SEGMENT_CHARS);
    let story = '';
    for (let i = 0; i < segments.length; i++) {
      const prompt = buildFileStoryPrompt(
        filePath,
        baseBranch,
        segments[i]!,
        i,
        segments.length,
        story || undefined
      );
      const response = await llm.complete(prompt, undefined, opts);
      const part = response?.content?.trim();
      if (!part) return null;
      story = part.length <= 2000 ? part : part.slice(0, 2000);
    }
    return story || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a single conflict chunk using LLM (3-way: base + ours + theirs).
 * WHY baseSegment: The model must see the common-ancestor slice for this chunk so it can merge both
 * sides relative to base; caller passes the result of getBaseSegmentForChunk(baseContent, chunk).
 */
export async function resolveConflictChunk(
  llm: LLMClient,
  filePath: string,
  chunk: ConflictChunk,
  baseBranch: string,
  model?: string,
  baseSegment?: string,
  previousParseError?: string,
  fileOverview?: string
): Promise<{ resolved: boolean; resolvedLines: string[]; explanation: string }> {
  const { ours, theirs } = extractConflictSides(chunk.conflictLines);
  const oursSegment = ours.join('\n');
  const theirsSegment = theirs.join('\n');
  const base = baseSegment ?? '';

  const prompt = buildConflictResolutionPromptThreeWay(
    base,
    oursSegment,
    theirsSegment,
    baseBranch,
    filePath,
    previousParseError,
    fileOverview
  );

  try {
    const response = await llm.complete(prompt, undefined, model ? { model } : undefined);
    if (!response || typeof response.content !== 'string') {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: 'LLM returned invalid response'
      };
    }
    if (!response || !response.content) {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: 'LLM returned empty response'
      };
    }
    // Review: retrieves response content for extracting resolved code and explanations.
    const content = response.content;

    // Extract resolved code from between backticks
    const codeMatch = content.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
    const explanationMatch = content.match(/EXPLANATION:\s*(.+)/);

    if (!codeMatch) {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: 'LLM did not return properly formatted resolution'
      };
    }

    const resolvedCode = codeMatch[1].trim();
    let explanation = explanationMatch?.[1]?.trim() || 'Resolved';
    if (/^<one sentence/i.test(explanation) || /^brief explanation/i.test(explanation)) {
      explanation = 'Resolved';
    }

    // Verify no conflict markers remain
    const markerRe = /^(<{7}|={7}|>{7})/m;
    if (markerRe.test(resolvedCode)) {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: 'Resolution still contains conflict markers'
      };
    // Review: verifies absence of conflict markers to ensure a clean resolution before processing.
    }

    // Size regression check: resolution should not catastrophically shrink the conflict
    // WHY: LLMs sometimes return only the first few entries of a large file,
    // e.g., reducing 23K-line schema to 250 lines. Catch this before it's committed.
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);
    const largerSideLines = Math.max(ours.length, theirs.length);
    const resolvedLines = resolvedCode.split('\n');

    if (largerSideLines >= MIN_LINES_FOR_SIZE_REGRESSION_CHECK) {
      const sizeRatio = resolvedLines.length / largerSideLines;
      if (sizeRatio < MIN_CONFLICT_RESOLUTION_SIZE_RATIO) {
        debug('Chunk resolution rejected - suspicious size regression', {
          filePath,
          largerSideLines,
          resolvedLineCount: resolvedLines.length,
          ratio: sizeRatio.toFixed(3),
        });
        return {
          resolved: false,
          resolvedLines: chunk.conflictLines,
          explanation: `Resolution suspiciously small: ${resolvedLines.length} lines vs ${largerSideLines} in larger conflict side (${(sizeRatio * 100).toFixed(1)}% - threshold is ${MIN_CONFLICT_RESOLUTION_SIZE_RATIO * 100}%)`
        };
      }
    }

    return {
      resolved: true,
      resolvedLines,
      explanation
    };
  } catch (error) {
    debug('Error resolving conflict chunk', { error });
    return {
      resolved: false,
      resolvedLines: chunk.conflictLines,
      explanation: `Error: ${error}`
    };
  }
}

/** Max lines per forced segment when no blank-line boundary in fallback. */
const FALLBACK_MAX_LINES_PER_SEGMENT = 150;

/**
 * Find safe chunk boundaries (AST or fallback) so each segment is <= maxSegmentChars.
 * Returns [0, e1, e2, ..., lines.length] with each lines.slice(edges[i], edges[i+1]) ≤ maxSegmentChars.
 * WHY AST for TS/JS: Splitting mid-statement would send invalid code and produce broken merges; statement
 * boundaries keep each segment parseable. WHY fallback: When parse fails or language has no parser we use
 * blank lines or a line cap so we still bound segment size and avoid one giant prompt.
 */
export async function findConflictChunkEdges(
  lines: string[],
  filePath: string,
  maxSegmentChars: number
): Promise<number[]> {
  const content = lines.join('\n');
  const ext = filePath.replace(/^.*\./, '').toLowerCase();

  // TypeScript/JavaScript: use AST statement boundaries
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    try {
      const ts = await import('typescript').then(m => (m as { default?: unknown }).default ?? m) as typeof import('typescript');
      const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      if (content.trim().length > 0 && sf.statements.length === 0) {
        debug('AST produced no statements (parse error?), using fallback edges', { filePath });
        return findConflictChunkEdgesFallback(lines, maxSegmentChars);
      }
      const lineStarts = getLineStarts(content);
      const statementStarts: number[] = [];
      for (const stmt of sf.statements) {
        const lineIdx = offsetToLineIndex(stmt.getStart(sf), lineStarts);
        if (lineIdx >= 0 && lineIdx <= lines.length && !statementStarts.includes(lineIdx)) {
          statementStarts.push(lineIdx);
        }
      }
      statementStarts.sort((a, b) => a - b);
      if (statementStarts.length === 0) statementStarts.push(0);
      if (statementStarts[statementStarts.length - 1] !== lines.length) {
        statementStarts.push(lines.length);
      }
      return coalesceEdgesBySize(lines, statementStarts, maxSegmentChars);
    } catch (e) {
      debug('TypeScript parse failed, using fallback edges', { filePath, error: e });
      return findConflictChunkEdgesFallback(lines, maxSegmentChars);
    }
  }

  // Python: boundaries at def/class/async def or blank line at indent 0
  if (ext === 'py') {
    const boundaries: number[] = [0];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (indent === 0 && (trimmed === '' || /^(def |class |async def )/.test(trimmed))) {
        boundaries.push(i);
      }
    }
    boundaries.push(lines.length);
    const merged = [...new Set(boundaries)].sort((a, b) => a - b);
    return coalesceEdgesBySize(lines, merged, maxSegmentChars);
  }

  return findConflictChunkEdgesFallback(lines, maxSegmentChars);
}

function getLineStarts(content: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') out.push(i + 1);
  }
  return out;
}

function offsetToLineIndex(offset: number, lineStarts: number[]): number {
  for (let i = lineStarts.length - 1; i >= 0; i--) {
    if (lineStarts[i]! <= offset) return i;
  }
  return 0;
}

function coalesceEdgesBySize(lines: string[], boundaries: number[], maxSegmentChars: number): number[] {
  const edges: number[] = [boundaries[0]!];

  for (let i = 1; i < boundaries.length; i++) {
    const boundary = boundaries[i]!;
    const lastEdge = edges[edges.length - 1]!;
    let segmentChars = 0;
    for (let j = lastEdge; j < boundary; j++) {
      segmentChars += (lines[j]?.length ?? 0) + 1;
    }
    if (segmentChars > maxSegmentChars && lastEdge !== boundaries[i - 1]) {
      edges.push(boundaries[i - 1]!);
    }
  }
  if (edges[edges.length - 1] !== lines.length) edges.push(lines.length);
  return [...new Set(edges)].sort((a, b) => a - b);
}

function findConflictChunkEdgesFallback(lines: string[], maxSegmentChars: number): number[] {
  const boundaries: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === '') boundaries.push(i);
  }
  boundaries.push(lines.length);
  const merged = [...new Set(boundaries)].sort((a, b) => a - b);
  const edges = coalesceEdgesBySize(lines, merged, maxSegmentChars);
  // If any segment still too large (no blank line), force split every N lines
  const result: number[] = [0];
  for (let i = 1; i < edges.length; i++) {
    const start = edges[i - 1]!;
    const end = edges[i]!;
    const segmentLines = lines.slice(start, end);
    const segmentChars = segmentLines.join('\n').length;
    if (segmentChars > maxSegmentChars) {
      for (let j = start + FALLBACK_MAX_LINES_PER_SEGMENT; j < end; j += FALLBACK_MAX_LINES_PER_SEGMENT) {
        result.push(j);
      }
    }
    result.push(end);
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

/**
 * Resolve one sub-chunk with 3-way prompt (base + ours + theirs segment).
 * WHY 3-way per segment: Each sub-chunk is a slice of the conflict; the model still needs the
 * corresponding base slice so it can merge both sides relative to base, not guess.
 */
async function resolveOneSubChunk(
  llm: LLMClient,
  filePath: string,
  baseSegment: string,
  oursSegment: string,
  theirsSegment: string,
  baseBranch: string,
  model?: string,
  previousParseError?: string,
  fileOverview?: string
): Promise<{ resolved: boolean; resolvedLines: string[] }> {
  const prompt = buildConflictResolutionPromptThreeWay(
    baseSegment,
    oursSegment,
    theirsSegment,
    baseBranch,
    filePath,
    previousParseError,
    fileOverview
  );
  try {
    const response = await llm.complete(prompt, undefined, model ? { model } : undefined);
    const content = response?.content ?? '';
    const codeMatch = content.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
    if (!codeMatch) {
      return { resolved: false, resolvedLines: [] };
    }
    const resolvedCode = codeMatch[1].trim();
    if (/^(<{7}|={7}|>{7})/m.test(resolvedCode)) {
      return { resolved: false, resolvedLines: [] };
    }
    return { resolved: true, resolvedLines: resolvedCode.split('\n') };
  } catch {
    return { resolved: false, resolvedLines: [] };
  }
}

/**
 * Resolve an oversized conflict by sub-chunking at AST/fallback edges and merging with base.
 */
async function resolveOversizedChunk(
  llm: LLMClient,
  filePath: string,
  chunk: ConflictChunk,
  baseBranch: string,
  model: string | undefined,
  baseContent: string,
  maxSegmentChars: number,
  previousParseError?: string,
  fileOverview?: string
): Promise<{ resolved: boolean; resolvedLines: string[]; explanation: string }> {
  const { ours, theirs } = extractConflictSides(chunk.conflictLines);
  // WHY conflict's base segment: Edges are indices within the conflict (0..linesForEdges.length). We must
  // slice the conflict's base segment by those indices, not the full file, or we'd send wrong lines for
  // multi-conflict files or when the conflict doesn't start at line 0.
  const baseSegmentForChunk = getBaseSegmentForChunk(baseContent, chunk);
  const baseSegmentLines = baseSegmentForChunk.split('\n');
  const linesForEdges = ours.length >= theirs.length ? ours : theirs;
  const edges = await findConflictChunkEdges(linesForEdges, filePath, maxSegmentChars);

  if (edges.length <= 2) {
    return resolveConflictChunk(llm, filePath, chunk, baseBranch, model, baseSegmentForChunk, previousParseError, fileOverview);
  }

  const segmentCount = edges.length - 1;
  if (segmentCount > 20) {
    debug('Many sub-chunks for oversized conflict', { filePath, segmentCount });
  }

  const resolvedSegments: string[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    const oursSeg = ours.slice(start, end).join('\n');
    const theirsSeg = theirs.slice(start, end).join('\n');
    const baseSeg = baseSegmentLines.slice(start, Math.min(end, baseSegmentLines.length)).join('\n');

    const result = await resolveOneSubChunk(
      llm,
      filePath,
      baseSeg,
      oursSeg,
      theirsSeg,
      baseBranch,
      model,
      previousParseError,
      fileOverview
    );
    if (!result.resolved) {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: `Sub-chunk ${i + 1}/${segmentCount} failed to resolve`,
      };
    }
    resolvedSegments.push(...result.resolvedLines);
  }

  return {
    resolved: true,
    resolvedLines: resolvedSegments,
    explanation: `Resolved oversized conflict in ${segmentCount} sub-chunk(s)`,
  };
}

export async function resolveConflictsChunked(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string,
  model?: string,
  baseContent?: string,
  maxSegmentChars?: number,
  previousParseError?: string
): Promise<{ resolved: boolean; content: string; explanation: string }> {
  const wholeFileGeneratedResolution = tryResolveWholeFileGeneratedConflict(filePath, content);
  if (wholeFileGeneratedResolution) {
    return wholeFileGeneratedResolution;
  }

  const chunks = extractConflictChunks(content);

  if (chunks.length === 0) {
    return {
      resolved: false,
      content,
      explanation: 'No conflict markers found'
    };
  }

  debug('Extracted conflict chunks', {
    file: filePath,
    chunks: chunks.length,
    totalLines: content.split('\n').length
  });

  // Build a short "file overview" (story) when multiple conflicts or large file, then inject into each chunk prompt.
  const fileOverview = await getFileConflictOverview(llm, filePath, content, baseBranch, model);
  if (fileOverview) debug('File conflict overview', { filePath, overviewLength: fileOverview.length });

  const lines = content.split('\n');
  const resolutions = new Map<number, string[]>(); // startLine -> resolved lines
  const explanations: string[] = [];
  let allResolved = true;

  const baseContentNorm = baseContent ?? '';
  const segmentCap = maxSegmentChars ?? MAX_SINGLE_CHUNK_CHARS;

  // WHY check oversized per chunk: A single conflict region can be 50k+ lines; sending it in one prompt
  // would exceed context and cause 504/truncation. We sub-chunk at AST boundaries and resolve each segment.
  for (const chunk of chunks) {
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);
    const largerSideChars = Math.max(ours.join('\n').length, theirs.join('\n').length);
    const isOversized = largerSideChars > segmentCap;

    const overview = fileOverview ?? undefined;
    const result = isOversized
      ? await resolveOversizedChunk(llm, filePath, chunk, baseBranch, model, baseContentNorm, segmentCap, previousParseError, overview)
      : await (async () => {
          const baseSegment = getBaseSegmentForChunk(baseContentNorm, chunk);
          return resolveConflictChunk(llm, filePath, chunk, baseBranch, model, baseSegment, previousParseError, overview);
        })();

    if (result.resolved) {
      resolutions.set(chunk.startLine, result.resolvedLines);
      explanations.push(`Lines ${chunk.startLine}-${chunk.endLine}: ${result.explanation}`);
    } else {
      allResolved = false;
      explanations.push(`Lines ${chunk.startLine}-${chunk.endLine}: FAILED - ${result.explanation}`);
    }
  }

  if (!allResolved) {
    return {
      resolved: false,
      content,
      explanation: `Could not resolve all conflicts:\n${explanations.join('\n')}`
    };
  }

  // Reconstruct file with resolved chunks
  const resolvedLines: string[] = [];
  let i = 0;

  for (const chunk of chunks.sort((a, b) => a.startLine - b.startLine)) {
    // Add lines before this conflict
    while (i < chunk.startLine) {
      resolvedLines.push(lines[i]);
      i++;
    }

    // Add resolved chunk
    const resolved = resolutions.get(chunk.startLine);
    if (resolved) {
      resolvedLines.push(...resolved);
    } else {
      debug('BUG: missing resolution for chunk', { startLine: chunk.startLine });
      resolvedLines.push(...chunk.conflictLines);
    // Review: fallback to original lines prevents data loss if resolution is missing.
    }

    // Skip original conflict lines
    i = chunk.endLine + 1;
  }

  // Add remaining lines after last conflict
  while (i < lines.length) {
    resolvedLines.push(lines[i]);
    i++;
  }

  return {
    resolved: true,
    content: resolvedLines.join('\n'),
    explanation: `Resolved ${chunks.length} conflict(s):\n${explanations.join('\n')}`
  };
}

/**
 * Build prompt for top+tails fallback: merge conflict using top of conflict + tail of OURS + tail of THEIRS (and base top/tail).
 * WHY: When the main strategy (full region or AST sub-chunk) fails, we try this so we don't process the entire file
 * unless we need to; the model sees how the conflict starts and how each side ends and produces a full resolution.
 */
function buildTopTailsConflictPrompt(
  topConflict: string,
  tailOurs: string,
  tailTheirs: string,
  baseTop: string,
  baseTail: string,
  baseBranch: string,
  filePath: string,
  fileOverview?: string,
  previousParseError?: string
): string {
  const overviewBlock = fileOverview
    ? `FILE OVERVIEW (use for context when merging):\n${fileOverview}\n\n`
    : '';
  const parseHint = previousParseError
    ? `\nIMPORTANT: A previous attempt had a syntax/parse error: "${previousParseError}". Ensure the RESOLVED code is valid (close block comments with */, no missing commas).\n\n`
    : '';
  return `FILE: ${filePath}
${overviewBlock}${parseHint}Merge this conflict using only the TOP (start of conflict) and TAILS (how each side ends). Produce the FULL resolved conflict content (no conflict markers).

TOP OF CONFLICT (context + start):
\`\`\`
${topConflict || '(empty)'}
\`\`\`

BASE (common ancestor) — TOP:
\`\`\`
${baseTop || '(empty)'}
\`\`\`

BASE — TAIL:
\`\`\`
${baseTail || '(empty)'}
\`\`\`

OURS (HEAD) — TAIL (last lines):
\`\`\`
${tailOurs || '(empty)'}
\`\`\`

THEIRS (${baseBranch}) — TAIL (last lines):
\`\`\`
${tailTheirs || '(empty)'}
\`\`\`

Return exactly:
RESOLVED:
\`\`\`
<full resolved conflict lines only, no markers>
\`\`\`
EXPLANATION: <one sentence>`;
}

/**
 * Two-pass: prompt for resolving the HEAD (first portion) of a conflict from top + base top.
 * WHY two-pass: For conflicts > 150 lines, one-shot (top + tails → full resolution) would ask the model
 * to invent the middle; splitting into head then tail keeps each request bounded and avoids hallucinated middle.
 */
function buildTopTailsHeadPrompt(
  topConflict: string,
  baseTop: string,
  baseBranch: string,
  filePath: string,
  fileOverview?: string,
  previousParseError?: string
): string {
  const overviewBlock = fileOverview ? `FILE OVERVIEW:\n${fileOverview}\n\n` : '';
  const parseHint = previousParseError ? `\nIMPORTANT: Fix this parse error in your output: "${previousParseError}"\n\n` : '';
  return `FILE: ${filePath}
${overviewBlock}${parseHint}Merge the START of this conflict. Produce only the first portion of the resolved conflict (same approximate length as the TOP below). No conflict markers. This will be followed by a second request to merge the ending.

TOP OF CONFLICT (context + start):
\`\`\`
${topConflict || '(empty)'}
\`\`\`

BASE (common ancestor) — TOP:
\`\`\`
${baseTop || '(empty)'}
\`\`\`

Return exactly:
RESOLVED:
\`\`\`
<resolved head lines only>
\`\`\`
EXPLANATION: <one sentence>`;
}

/**
 * Two-pass: prompt for resolving the TAIL (rest of conflict) given resolved head + tail OURS + tail THEIRS.
 * WHY: The model sees the already-resolved start and the last lines of both sides; it outputs only the
 * continuation so we can reassemble head + tail without overlap or gap.
 */
function buildTopTailsTailPrompt(
  resolvedHead: string,
  tailOurs: string,
  tailTheirs: string,
  baseTail: string,
  baseBranch: string,
  filePath: string,
  fileOverview?: string,
  previousParseError?: string
): string {
  const overviewBlock = fileOverview ? `FILE OVERVIEW:\n${fileOverview}\n\n` : '';
  const parseHint = previousParseError ? `\nIMPORTANT: Fix this parse error in your output: "${previousParseError}"\n\n` : '';
  return `FILE: ${filePath}
${overviewBlock}${parseHint}Merge the END of this conflict. You are given the already-resolved START. Produce the REMAINING lines that continue from the start and merge how OURS and THEIRS end. No conflict markers. Output only the continuation (do not repeat the head).

RESOLVED START (already merged):
\`\`\`
${resolvedHead || '(empty)'}
\`\`\`

BASE — TAIL:
\`\`\`
${baseTail || '(empty)'}
\`\`\`

OURS (HEAD) — TAIL (last lines):
\`\`\`
${tailOurs || '(empty)'}
\`\`\`

THEIRS (${baseBranch}) — TAIL (last lines):
\`\`\`
${tailTheirs || '(empty)'}
\`\`\`

Return exactly:
RESOLVED:
\`\`\`
<resolved tail lines only, continuation from head>
\`\`\`
EXPLANATION: <one sentence>`;
}

/**
 * Fallback: resolve conflicts using top-of-conflict + tail of OURS + tail of THEIRS (and base top/tail).
 * Only used when the main strategy (chunked or single-shot) has already failed for this file.
 * WHY: We don't process the entire file with this strategy unless we need to; it's a fallback only.
 * Complete implementation: always chunk the entire file and build the story; then per conflict use top+tails,
 * with two-pass (head then tail) when the conflict is large.
 */
export async function resolveConflictsWithTopTailsFallback(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string,
  model: string | undefined,
  baseContent: string,
  fileOverview?: string | null,
  previousParseError?: string
): Promise<{ resolved: boolean; content: string; explanation: string }> {
  const chunks = extractConflictChunks(content);
  if (chunks.length === 0) {
    return { resolved: false, content, explanation: 'No conflict markers' };
  }

  // WHY cap: Asking the model to produce a full resolution from only top+tails works when the conflict
  // is small enough that the model can infer the middle; above 280 lines we'd get hallucinated or truncated output.
  for (const chunk of chunks) {
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);
    const maxLines = Math.max(ours.length, theirs.length);
    if (maxLines > TOP_TAILS_FALLBACK_MAX_CHUNK_LINES) {
      debug('Top+tails fallback skipped: chunk too large', { filePath, maxLines, limit: TOP_TAILS_FALLBACK_MAX_CHUNK_LINES });
      return { resolved: false, content, explanation: `Conflict region too large for top+tails fallback (${maxLines} > ${TOP_TAILS_FALLBACK_MAX_CHUNK_LINES} lines)` };
    }
  }

  // Always build file story by chunking the entire file (complete implementation: process entire file in fallback).
  const overview = fileOverview ?? await getFileConflictOverviewAlways(llm, filePath, content, baseBranch, model);
  if (!overview) debug('Top+tails fallback: file overview (story) unavailable; resolving without it', { filePath });

  const lines = content.split('\n');
  const resolutions = new Map<number, string[]>();
  const explanations: string[] = [];
  const opts = model ? { model } : undefined;

  for (const chunk of chunks) {
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);
    const maxLines = Math.max(ours.length, theirs.length);
    const baseSegment = getBaseSegmentForChunk(baseContent ?? '', chunk);
    const baseLines = baseSegment.split('\n');

    const topConflictLines = chunk.conflictLines.slice(0, TOP_TAILS_TOP_CONFLICT_LINES);
    const topConflict = [...chunk.contextBefore, ...topConflictLines].join('\n');
    const tailOurs = ours.slice(-TOP_TAILS_TAIL_LINES).join('\n');
    const tailTheirs = theirs.slice(-TOP_TAILS_TAIL_LINES).join('\n');
    const baseTop = baseLines.slice(0, TOP_TAILS_TOP_CONFLICT_LINES).join('\n');
    const baseTail = baseLines.slice(-TOP_TAILS_TAIL_LINES).join('\n');

    // WHY 150-line threshold: Below that, one-shot (top + tails → full) is reliable; above it the model
    // would invent too much middle from partial input, so we split into head then tail.
    const useTwoPass = maxLines > TOP_TAILS_TWO_PASS_THRESHOLD_LINES;

    try {
      let resolvedLines: string[];
      if (useTwoPass) {
        const headPrompt = buildTopTailsHeadPrompt(topConflict, baseTop, baseBranch, filePath, overview ?? undefined, previousParseError);
        const headResponse = await llm.complete(headPrompt, undefined, opts);
        const headBody = headResponse?.content ?? '';
        const headMatch = headBody.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
        if (!headMatch) {
          return { resolved: false, content, explanation: 'Top+tails fallback (two-pass): LLM did not return RESOLVED block for head' };
        }
        const resolvedHead = headMatch[1].trim();
        if (/^(<{7}|={7}|>{7})/m.test(resolvedHead)) {
          return { resolved: false, content, explanation: 'Top+tails fallback (two-pass): head still had conflict markers' };
        }

        const tailPrompt = buildTopTailsTailPrompt(resolvedHead, tailOurs, tailTheirs, baseTail, baseBranch, filePath, overview ?? undefined, previousParseError);
        const tailResponse = await llm.complete(tailPrompt, undefined, opts);
        const tailBody = tailResponse?.content ?? '';
        const tailMatch = tailBody.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
        if (!tailMatch) {
          return { resolved: false, content, explanation: 'Top+tails fallback (two-pass): LLM did not return RESOLVED block for tail' };
        }
        const resolvedTail = tailMatch[1].trim();
        if (/^(<{7}|={7}|>{7})/m.test(resolvedTail)) {
          return { resolved: false, content, explanation: 'Top+tails fallback (two-pass): tail still had conflict markers' };
        }

        resolvedLines = [...resolvedHead.split('\n'), ...resolvedTail.split('\n')];
        explanations.push(`Lines ${chunk.startLine}-${chunk.endLine}: top+tails (two-pass)`);
      } else {
        const prompt = buildTopTailsConflictPrompt(
          topConflict,
          tailOurs,
          tailTheirs,
          baseTop,
          baseTail,
          baseBranch,
          filePath,
          overview ?? undefined,
          previousParseError
        );
        const response = await llm.complete(prompt, undefined, opts);
        const body = response?.content ?? '';
        const codeMatch = body.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
        if (!codeMatch) {
          return { resolved: false, content, explanation: 'Top+tails fallback: LLM did not return RESOLVED block' };
        }
        const resolvedCode = codeMatch[1].trim();
        if (/^(<{7}|={7}|>{7})/m.test(resolvedCode)) {
          return { resolved: false, content, explanation: 'Top+tails fallback: resolution still had conflict markers' };
        }
        resolvedLines = resolvedCode.split('\n');
        explanations.push(`Lines ${chunk.startLine}-${chunk.endLine}: top+tails`);
      }
      resolutions.set(chunk.startLine, resolvedLines);
    } catch (e) {
      debug('Top+tails fallback LLM error', { filePath, error: e });
      return { resolved: false, content, explanation: `Top+tails fallback failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const resolvedLines: string[] = [];
  let i = 0;
  for (const chunk of chunks.sort((a, b) => a.startLine - b.startLine)) {
    while (i < chunk.startLine) {
      resolvedLines.push(lines[i]!);
      i++;
    }
    const resolved = resolutions.get(chunk.startLine);
    if (resolved) resolvedLines.push(...resolved);
    else resolvedLines.push(...chunk.conflictLines);
    i = chunk.endLine + 1;
  }
  while (i < lines.length) {
    resolvedLines.push(lines[i]!);
    i++;
  }

  return {
    resolved: true,
    content: resolvedLines.join('\n'),
    explanation: `Resolved ${chunks.length} conflict(s) via top+tails fallback:\n${explanations.join('\n')}`
  };
}

/**
 * Heuristic resolution for structured files (package.json, package-lock.json, etc.)
 *
 * WHY: Some conflicts have simple patterns we can resolve without LLM.
 * This is faster, more reliable, and doesn't consume tokens.
 */
export function tryHeuristicResolution(
  filePath: string,
  content: string
): { resolved: boolean; content: string; explanation: string } {
  const fileName = filePath.split('/').pop() || '';

  // Package.json: prefer higher versions
  if (fileName === 'package.json') {
    const isDependencySection = (chunk: string[]): boolean => {
      const depSections = ['dependencies', 'devDependencies', 'peerDependencies'];
      return chunk.some(line => depSections.some(section => line.includes(`"${section}"`)));
    };

    const chunks = extractConflictChunks(content);
    const nonDepChunks = chunks.filter(chunk => !isDependencySection(chunk.conflictLines));
    if (nonDepChunks.length > 0) {
      return { resolved: false, content, explanation: 'Conflict section outside of dependencies - manual resolution needed' };
    }

    return resolvePackageJsonConflict(content) ?? { resolved: false, content, explanation: 'Failed to parse package.json conflicts' };
  }

  // Package-lock.json / yarn.lock: regenerate recommended
  if (fileName === 'package-lock.json' || fileName === 'yarn.lock' || fileName === 'pnpm-lock.yaml') {
    return {
      resolved: false,
      content,
      explanation: 'Lock file should be regenerated (delete and run install)'
    };
  }

  return { resolved: false, content, explanation: 'No heuristic available' };
}

/**
 * Resolve package.json conflicts by preferring higher version numbers
 */
function resolvePackageJsonConflict(content: string): { resolved: boolean; content: string; explanation: string } {
  const lines = content.split('\n');
  const resolved: string[] = [];
  let inConflict = false;
  let ours: string[] = [];
  let theirs: string[] = [];
  let inTheirs = false;
  let conflictsResolved = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      ours = [];
      theirs = [];
      inTheirs = false;
    } else if (line.startsWith('=======') && inConflict) {
      inTheirs = true;
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      // Peek ahead past blank lines to determine if trailing comma is needed.
      // If the next non-blank, non-comment line starts with a quote (another
      // JSON key) or is another conflict marker, the last merged entry needs
      // a trailing comma so the resulting JSON stays valid.
      let needsTrailingComma = false;
      for (let j = i + 1; j < lines.length; j++) {
        const peek = lines[j].trim();
        if (peek === '' || peek.startsWith('//')) continue;
        // Another key, another conflict, or a non-closing token means more entries follow
        needsTrailingComma = peek.startsWith('"') || peek.startsWith('<<<<<<<');
        break;
      }

      // Try to merge ours and theirs
      const merged = mergePackageJsonChunks(ours, theirs, needsTrailingComma);
      if (merged) {
        resolved.push(...merged);
        conflictsResolved++;
      } else {
        return { resolved: false, content, explanation: 'Conflict section not parseable as dependency entries' };
      }

      inConflict = false;
      ours = [];
      theirs = [];
    } else if (inConflict) {
      if (inTheirs) {
        theirs.push(line);
      } else {
        ours.push(line);
      }
    } else {
      resolved.push(line);
    }
  }

  if (inConflict) {
    // Unclosed conflict
    return { resolved: false, content, explanation: 'Malformed conflict markers' };
  }

  if (conflictsResolved > 0) {
    return {
      resolved: true,
      content: resolved.join('\n'),
      explanation: `Resolved ${conflictsResolved} package.json conflict(s) by preferring higher versions`
    };
  }

  return { resolved: false, content, explanation: 'No conflicts found' };
// Review: assumes all conflicts are version-related for simplicity, ignoring non-version fields.
}

/**
 * Merge two package.json sections, preferring higher versions
 */
function mergePackageJsonChunks(ours: string[], theirs: string[], needsTrailingComma: boolean): string[] | null {
  // Simple strategy: parse dependencies, take higher versions
  const oursMap = parsePackageLines(ours);
  const theirsMap = parsePackageLines(theirs);

  // If either side failed to parse (non-dependency sections), bail out to LLM
  if (oursMap === null || theirsMap === null) {
    return null;
  }

  // If either side can't be parsed as dependency entries (e.g., scripts, engines), bail out to LLM
  if (!oursMap || !theirsMap) {
    return null;
  }

  // Detect indentation from input lines (default to 4 spaces)
  const indentMatch = [...ours, ...theirs].find(l => l.match(/^(\s+)"/));
  const indent = indentMatch ? indentMatch.match(/^(\s+)/)?.[1] ?? '    ' : '    ';

  // Merge: for each package, take higher version
  const merged = new Map<string, string>();

  for (const [pkg, version] of oursMap) {
    merged.set(pkg, version);
  }

  for (const [pkg, version] of theirsMap) {
    const ourVersion = merged.get(pkg);
    if (!ourVersion || compareVersions(version, ourVersion) > 0) {
      merged.set(pkg, version);
    }
  }

  // Reconstruct lines
  // Use needsTrailingComma to decide if the last entry needs a comma
  // (true when the conflict sits mid-object with more keys following)
  const entries = Array.from(merged.entries())
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([pkg, version], idx) => {
    const isLast = idx === entries.length - 1;
    const comma = isLast ? (needsTrailingComma ? ',' : '') : ',';
    return `${indent}"${pkg}": "${version}"${comma}`;
  });
}

/**
 * Parse package lines into Map<packageName, version>
 */
function parsePackageLines(lines: string[]): Map<string, string> | null {
  const map = new Map<string, string>();
  let matchedLines = 0;
  let nonEmptyLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === '{' || trimmed === '}' || trimmed === '},') {
      continue;
    }
    nonEmptyLines++;
    // Match: "package-name": "1.2.3",
    const match = line.match(/"([^"]+)":\s*"([^"]+)"/);
    if (match) {
      map.set(match[1], match[2]);
      matchedLines++;
    }
  }

  // If we couldn't parse most non-empty lines, signal failure
  // Require 100% match to guarantee no data loss (e.g., non-dependency entries like "private": true)
  // Require 100% of non-empty lines to parse as valid dependency entries
  // to prevent silently dropping non-dependency entries in mixed conflict sections
  if (nonEmptyLines > 0 && matchedLines < nonEmptyLines) {
    return null;
  }

  return map;
// Review: strict requirements ensure all valid lines are included, preventing data loss.
}

/**
 * Check if a file path matches known generated schema/migration file patterns.
 * WHY: Generated files need special handling during conflict resolution because
 * LLMs catastrophically fail on them (e.g., truncating 23K-line schemas to 250 lines).
 */
export function isGeneratedSchemaFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');

  // Drizzle ORM migration metadata
  if (normalized.includes('/meta/') && normalized.endsWith('_snapshot.json')) return true;
  if (normalized.includes('/meta/') && normalized.endsWith('_journal.json')) return true;

  // Prisma migration metadata
  if (normalized.includes('/migrations/') && normalized.endsWith('migration_lock.toml')) return true;

  // Generic schema snapshots
  if (normalized.endsWith('.schema.json') && normalized.includes('/migration')) return true;

  return false;
}

/**
 * Broader generated-artifact detection used for deterministic conflict fallbacks.
 * WHY: examples manifests, generated action docs, and plugins.generated.json are
 * machine-produced artifacts that often conflict as a single huge region.
 */
export function isGeneratedArtifactFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (isGeneratedSchemaFile(filePath)) return true;
  if (normalized.endsWith('/examples-manifest.json')) return true;
  if (normalized.endsWith('/plugins.generated.json')) return true;
  if (/\/generated\/.+\.(json|py|rs|ts|tsx|js)$/i.test(normalized)) return true;
  if (/action[-_]?docs?\.(py|rs|ts|tsx|js)$/i.test(normalized)) return true;
  return false;
}

function getSignificantLines(lines: string[]): string[] {
  return lines
    .map(line => line.trim())
    .filter(line =>
      line.length >= 4 &&
      line !== '{' &&
      line !== '}' &&
      line !== '[' &&
      line !== ']' &&
      line !== ',' &&
      !/^\/\/\s*generated/i.test(line)
    );
}

/**
 * Resolve a whole-file generated conflict without the LLM when possible.
 * WHY: If a generated file collapses into one giant conflict region, chunked mode
 * is effectively another full-file request and still 504s. Prefer structural merges.
 */
function tryResolveWholeFileGeneratedConflict(
  filePath: string,
  content: string
): { resolved: boolean; content: string; explanation: string } | null {
  if (!isGeneratedArtifactFile(filePath)) return null;

  const chunks = extractConflictChunks(content, 0);
  if (chunks.length !== 1) return null;

  const lines = content.split('\n');
  const chunk = chunks[0];
  const before = lines.slice(0, chunk.startLine).join('\n').trim();
  const after = lines.slice(chunk.endLine + 1).join('\n').trim();
  if (before.length > 0 || after.length > 0) return null;

  const { ours, theirs } = extractConflictSides(chunk.conflictLines);
  const oursText = ours.join('\n');
  const theirsText = theirs.join('\n');
  return tryResolveGeneratedArtifactSides(filePath, oursText, theirsText);
}

export function tryResolveGeneratedArtifactSides(
  filePath: string,
  oursText: string,
  theirsText: string
): { resolved: boolean; content: string; explanation: string } | null {
  if (!isGeneratedArtifactFile(filePath)) return null;

  if (filePath.endsWith('.json')) {
    try {
      const oursObj = JSON.parse(oursText) as JSONValue;
      const theirsObj = JSON.parse(theirsText) as JSONValue;

      if (isJsonSubset(oursObj, theirsObj)) {
        return {
          resolved: true,
          content: JSON.stringify(theirsObj, null, detectJSONIndent(theirsText)),
          explanation: 'Resolved generated JSON conflict by choosing the structural superset (incoming contained all HEAD data)',
        };
      }

      if (isJsonSubset(theirsObj, oursObj)) {
        return {
          resolved: true,
          content: JSON.stringify(oursObj, null, detectJSONIndent(oursText)),
          explanation: 'Resolved generated JSON conflict by choosing the structural superset (HEAD contained all incoming data)',
        };
      }
    } catch {
      // Fall through to text containment heuristic
    }
  }

  const oursSig = getSignificantLines(oursText.split('\n'));
  const theirsSig = getSignificantLines(theirsText.split('\n'));
  const oursInTheirs = oursSig.every(line => theirsText.includes(line));
  const theirsInOurs = theirsSig.every(line => oursText.includes(line));
  if (oursInTheirs || theirsInOurs) {
    const keepOurs = theirsInOurs || oursText.length >= theirsText.length;
    return {
      resolved: true,
      content: keepOurs ? oursText : theirsText,
      explanation: `Resolved generated artifact conflict by keeping the structural superset (${keepOurs ? 'HEAD' : 'incoming'})`,
    };
  }

  return null;
}

/**
 * Check if a conflicted file has highly asymmetric conflict sides.
 * Returns true if ALL conflict chunks have one side <5% the size of the other.
 *
 * Example: a 17-line empty Drizzle skeleton conflicting with a 23K-line full
 * schema is asymmetric (ratio 0.07%). Two 500-line files with different content
 * are not (ratio ~100%).
 */
export function hasAsymmetricConflict(content: string): boolean {
  const chunks = extractConflictChunks(content);
  if (chunks.length === 0) return false;

  for (const chunk of chunks) {
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);
    const larger = Math.max(ours.length, theirs.length);
    const smaller = Math.min(ours.length, theirs.length);
    if (larger === 0 || (smaller / larger) >= ASYMMETRIC_CONFLICT_SIDE_RATIO) {
      return false;
    }
  }
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ASYMMETRIC CONFLICT RESOLUTION (large side as base + smart merge)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Resolve highly asymmetric conflicts in generated files.
 *
 * WHY: When one conflict side is dramatically larger than the other (e.g., 23K-line
 * full Drizzle schema vs 17-line empty skeleton), sending the entire file to the
 * LLM causes catastrophic truncation. Instead:
 *
 * 1. Use the LARGE side as the base (guaranteed no truncation)
 * 2. Send only the SMALL side to the LLM to check for unique content
 * 3. For JSON: programmatically deep-merge any unique additions from the small side
 * 4. For non-JSON: if unique content found, reject for manual merge (safe)
 *
 * This ensures nothing meaningful is lost from either side while avoiding the
 * catastrophic failure mode of sending huge files to the LLM.
 */
export async function resolveAsymmetricConflict(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string,
  model?: string
): Promise<{ resolved: boolean; content: string; explanation: string }> {
  const chunks = extractConflictChunks(content);
  if (chunks.length === 0) {
    return { resolved: false, content, explanation: 'No conflicts found' };
  }

  const lines = content.split('\n');
  const resolvedLines: string[] = [];
  const explanations: string[] = [];
  let i = 0;

  for (const chunk of chunks.sort((a, b) => a.startLine - b.startLine)) {
    const { ours, theirs } = extractConflictSides(chunk.conflictLines);

    if (Math.max(ours.length, theirs.length) === 0) {
      return { resolved: false, content, explanation: 'Empty conflict sides' };
    }
    const sizeRatio = Math.min(ours.length, theirs.length) / Math.max(ours.length, theirs.length);
    if (sizeRatio >= ASYMMETRIC_CONFLICT_SIDE_RATIO) {
      return { resolved: false, content, explanation: 'Conflict sides are similar size — not asymmetric' };
    }

    const largeSide = ours.length > theirs.length ? ours : theirs;
    const smallSide = ours.length > theirs.length ? theirs : ours;
    const largeSideLabel = ours.length > theirs.length ? 'HEAD' : baseBranch;

    // Add lines before this conflict
    while (i < chunk.startLine) {
      resolvedLines.push(lines[i]);
      i++;
    }

    // Use large side as base, check small side for any unique content worth merging
    const mergeResult = await checkSmallSideForAdditions(
      llm, filePath, largeSide, smallSide, baseBranch, model
    );

    if (mergeResult.hasAdditions && mergeResult.merged) {
      // Programmatic merge succeeded — both sides' content preserved
      resolvedLines.push(...mergeResult.merged);
      explanations.push(
        `Lines ${chunk.startLine + 1}-${chunk.endLine + 1}: ` +
        `Based on ${largeSideLabel} (${largeSide.length} lines), ` +
        `merged additions from small side: ${mergeResult.explanation}`
      );
    } else if (mergeResult.hasAdditions && !mergeResult.merged) {
      // LLM found meaningful content but couldn't merge programmatically.
      // Reject for manual resolution rather than risk data loss.
      return {
        resolved: false,
        content,
        explanation: `Both sides have meaningful content that needs manual merge: ${mergeResult.explanation}`,
      };
    } else {
      // No meaningful additions in small side — large side is complete
      resolvedLines.push(...largeSide);
      explanations.push(
        `Lines ${chunk.startLine + 1}-${chunk.endLine + 1}: ` +
        `Kept ${largeSideLabel} (${largeSide.length} lines), ` +
        `small side (${smallSide.length} lines) had no meaningful unique content`
      );
    }

    i = chunk.endLine + 1;
  }

  // Add remaining lines after last conflict
  while (i < lines.length) {
    resolvedLines.push(lines[i]);
    i++;
  }

  const resolvedContent = resolvedLines.join('\n');

  debug('Asymmetric conflict resolution', {
    file: filePath,
    chunks: chunks.length,
    originalLines: lines.length,
    resolvedLines: resolvedLines.length,
  });

  return {
    resolved: true,
    content: resolvedContent,
    explanation: explanations.join('; '),
  };
}

/**
 * Check if the small side of a conflict has meaningful unique content.
 * If so, try to merge it into the large side programmatically.
 *
 * For JSON files: programmatic deep-merge (large side wins conflicts,
 *   small side contributes new keys / non-empty values where large side is empty).
 * For non-JSON files: LLM-based analysis of the small side content.
 */
async function checkSmallSideForAdditions(
  llm: LLMClient,
  filePath: string,
  largeSide: string[],
  smallSide: string[],
  baseBranch: string,
  model?: string
): Promise<{ hasAdditions: boolean; merged?: string[]; explanation: string }> {
  // For JSON files: try programmatic deep-merge first (no LLM needed)
  if (filePath.endsWith('.json')) {
    try {
      const largeObj = JSON.parse(largeSide.join('\n'));
      const smallObj = JSON.parse(smallSide.join('\n'));
      const { additions, merged } = deepMergeJSON(largeObj, smallObj);

      if (additions.length === 0) {
        return { hasAdditions: false, explanation: 'No unique non-empty fields in small side (programmatic check)' };
      }

      // Detect indentation from large side to preserve formatting
      const indent = detectJSONIndent(largeSide.join('\n'));
      const mergedStr = JSON.stringify(merged, null, indent);

      debug('JSON deep-merge found additions from small side', { filePath, additions });
      return {
        hasAdditions: true,
        merged: mergedStr.split('\n'),
        explanation: `${additions.join(', ')}`,
      };
    } catch {
      // JSON parse failed on one or both sides — fall through to LLM check
      debug('JSON parse failed for deep-merge, falling back to LLM check', { filePath });
    }
  }

  // For non-JSON files (or failed JSON parse): use LLM to check small side for unique content
  const largeSideSample = getFileSample(largeSide, 30);

  const prompt = `You are checking if the smaller side of a merge conflict contains any meaningful unique content that is NOT already present in the larger side.

FILE: ${filePath} (generated/schema file)
MERGING: ${baseBranch} into current branch

The LARGER side (${largeSide.length} lines) is being kept as the base resolution.
Here is a sample of the larger side (first and last lines):
\`\`\`
${largeSideSample}
\`\`\`

SMALLER SIDE (${smallSide.length} lines) — check this for unique content:
\`\`\`
${smallSide.join('\n')}
\`\`\`

Does the smaller side contain ANY meaningful data, entries, or content that is NOT already covered by the larger side?
Empty structural placeholders (e.g., "tables": {}, empty objects/arrays) are NOT meaningful additions.

Answer with ONLY one of:
NO_ADDITIONS - if the smaller side has nothing meaningful beyond what the larger version covers
ADDITIONS_FOUND: <brief description of what unique content exists>`;

  try {
    const response = await llm.complete(prompt, undefined, model ? { model } : undefined);
    const responseText = response.content.trim();

    if (responseText.startsWith('NO_ADDITIONS')) {
      return { hasAdditions: false, explanation: 'LLM confirmed no meaningful additions in small side' };
    }

    if (responseText.startsWith('ADDITIONS_FOUND')) {
      const desc = responseText.replace(/^ADDITIONS_FOUND:\s*/, '').trim();
      debug('LLM found additions in small side', { filePath, description: desc });
      // Found additions but can't programmatically merge non-JSON files
      // Return without merged content — caller will reject for manual resolution
      return { hasAdditions: true, explanation: `Small side has unique content: ${desc}` };
    }

    // Unexpected LLM response format — conservative: assume no additions
    debug('Unexpected LLM response for small-side check, assuming no additions', {
      responsePreview: responseText.substring(0, 200),
    });
    return { hasAdditions: false, explanation: 'LLM response unclear — assuming no additions' };
  // Review: prioritizing safety — unclear LLM responses assume possible additions, flag for review.
  } catch (error) {
    // LLM failed — fail-safe: assume small side may have additions to avoid data loss
    debug('LLM small-side check failed, flagging for manual review', { error });
    return { hasAdditions: true, explanation: 'LLM check failed — manual review required' };
  // Review: conservative assumption prioritizes safety to prevent potential data loss.
  }
}

/**
 * Deep-merge two JSON objects, tracking what was added from the small side.
 * Large side wins all conflicts; small side only contributes NEW keys
 * or non-empty values where large side has empty ones.
 *
 * WHY: Preserves everything from the large side while capturing any meaningful
 * additions from the small side (e.g., new tables, new fields, new schema keys).
 */
function deepMergeJSON(
  largeSide: JSONValue,
  smallSide: JSONValue,
  path: string = ''
): { additions: string[]; merged: JSONValue } {
  const additions: string[] = [];

  // Non-objects: large side wins
  if (typeof largeSide !== 'object' || largeSide === null ||
      typeof smallSide !== 'object' || smallSide === null) {
    return { additions: [], merged: largeSide };
  }

  // Array merge: find items in small side not present in large side
  if (Array.isArray(largeSide)) {
    if (!Array.isArray(smallSide)) return { additions: [], merged: largeSide };

    const largeSet = new Set(largeSide.map(item => JSON.stringify(item)));
    const uniqueFromSmall = smallSide.filter(item => !largeSet.has(JSON.stringify(item)));

    if (uniqueFromSmall.length > 0) {
      additions.push(`${path || 'root'}[+${uniqueFromSmall.length} items]`);
      return { additions, merged: [...largeSide, ...uniqueFromSmall] };
    }
    return { additions: [], merged: largeSide };
  }

  // Object merge
  const largeRecord = largeSide as Record<string, JSONValue>;
  const smallRecord = smallSide as Record<string, JSONValue>;
  const merged: Record<string, JSONValue> = { ...largeRecord };

  const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  for (const key of Object.keys(smallRecord)) {
    if (PROTO_KEYS.has(key)) continue; // Prevent prototype pollution
    const fullPath = path ? `${path}.${key}` : key;

    if (!(key in largeRecord)) {
      // Brand new key from small side — always add it
      merged[key] = smallRecord[key];
      if (!isEmptyJSONValue(smallRecord[key])) {
        additions.push(fullPath);
      }
    } else if (typeof largeRecord[key] === 'object' && typeof smallRecord[key] === 'object') {
      // Both sides have this key as objects — recurse
      if (isEmptyJSONValue(smallRecord[key])) continue; // Small side empty, large side wins

      if (isEmptyJSONValue(largeRecord[key])) {
        // Large side is empty but small side has content — take small side's
        merged[key] = smallRecord[key];
        additions.push(fullPath);
      } else {
        // Both have content — recurse
        const sub = deepMergeJSON(largeRecord[key], smallRecord[key], fullPath);
        if (sub.additions.length > 0) {
          additions.push(...sub.additions);
          merged[key] = sub.merged;
        }
      }
    }
    // For primitives where both exist, large side always wins
  }

  return { additions, merged };
}

/** JSON-compatible value type for deep merge operations */
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

function isJsonSubset(subset: JSONValue, superset: JSONValue): boolean {
  if (isEmptyJSONValue(subset)) return true;

  if (typeof subset !== 'object' || subset === null || typeof superset !== 'object' || superset === null) {
    return subset === superset;
  }

  if (Array.isArray(subset)) {
    if (!Array.isArray(superset)) return false;
    const supersetSerialized = new Set(superset.map(item => JSON.stringify(item)));
    return subset.every(item => supersetSerialized.has(JSON.stringify(item)));
  }

  if (Array.isArray(superset)) return false;

  const subsetRecord = subset as Record<string, JSONValue>;
  const supersetRecord = superset as Record<string, JSONValue>;
  for (const [key, value] of Object.entries(subsetRecord)) {
    if (!(key in supersetRecord)) {
      if (isEmptyJSONValue(value)) continue;
      return false;
    }
    if (!isJsonSubset(value, supersetRecord[key])) {
      return false;
    }
  }
  return true;
}

/** Check if a JSON value is "empty" (null, empty string, empty object/array) */
function isEmptyJSONValue(val: JSONValue): boolean {
  if (val === null || val === undefined || val === '') return true;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object') return Object.keys(val).length === 0;
  return false;
}

/** Detect JSON indentation from a string (defaults to 2 spaces) */
function detectJSONIndent(text: string): number {
  const match = text.match(/\n(\s+)"/);
  return match ? match[1].length : 2;
}

/** Get a representative sample of a large file (first N + last N lines) */
function getFileSample(lines: string[], n: number): string {
  if (lines.length <= n * 2) return lines.join('\n');
  const first = lines.slice(0, n);
  const last = lines.slice(-n);
  return [...first, `\n... (${lines.length - n * 2} lines omitted) ...\n`, ...last].join('\n');
}

/**
 * Compare semantic versions (simple implementation)
 * Returns: >0 if v1 > v2, <0 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  // Split version into base and prerelease parts
  const [base1, prerelease1] = v1.split('-', 2);
  const [base2, prerelease2] = v2.split('-', 2);

  // Compare base versions
  const parts1 = base1.replace(/[^0-9.]/g, '').split('.').map(Number);
  // Note: designed to strip non-numeric chars for comparison simplicity, handling version formats.
  const parts2 = base2.replace(/[^0-9.]/g, '').split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }

  // If base versions are equal, handle prerelease
  // No prerelease (release version) > has prerelease (prerelease version)
  if (!prerelease1 && prerelease2) return 1;
  if (prerelease1 && !prerelease2) return -1;
  if (prerelease1 && prerelease2) {
    // Both have prereleases, compare them lexicographically
    // NOTE: This is a heuristic - per semver, prerelease ordering is complex
    // Note: lexicographic comparison is a heuristic - not fully semver-compliant
    // (e.g., 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0)
    return prerelease1.localeCompare(prerelease2);
  }

  return 0;
// Review: uses localeCompare for simplicity; assumes lexicographic order suffices for this case
}
