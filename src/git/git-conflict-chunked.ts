/**
 * Chunked conflict resolution for large files
 * 
 * WHY: Large files (>50KB) exceed LLM token limits when sent whole.
 * This module extracts individual conflict regions, resolves them separately,
 * and reconstructs the file - enabling programmatic resolution of any size file.
 */

import type { LLMClient } from '../llm/client.js';
import { debug } from '../logger.js';
import {
  MIN_CONFLICT_RESOLUTION_SIZE_RATIO,
  MIN_LINES_FOR_SIZE_REGRESSION_CHECK,
  ASYMMETRIC_CONFLICT_SIDE_RATIO,
} from '../constants.js';

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
 * Resolve a single conflict chunk using LLM
 */
export async function resolveConflictChunk(
  llm: LLMClient,
  filePath: string,
  chunk: ConflictChunk,
  baseBranch: string
): Promise<{ resolved: boolean; resolvedLines: string[]; explanation: string }> {
  const prompt = `You are resolving a single Git merge conflict in ${filePath}.

MERGING: ${baseBranch} into current branch

Context before conflict:
\`\`\`
${chunk.contextBefore.join('\n')}
\`\`\`

CONFLICTED SECTION (resolve this):
\`\`\`
${chunk.conflictLines.join('\n')}
\`\`\`

Context after conflict:
\`\`\`
${chunk.contextAfter.join('\n')}
\`\`\`

Instructions:
1. Analyze both sides of the conflict (between <<<<<<< and =======, and between ======= and >>>>>>>)
2. Intelligently merge both changes, keeping what makes sense
3. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)
4. Output ONLY the resolved lines (no markers, no explanations in the code)
5. After the code block, explain your resolution in one sentence

Format:
RESOLVED:
\`\`\`
resolved code here
\`\`\`
EXPLANATION: Brief explanation of what you merged/kept/changed`;

  try {
    const response = await llm.complete(prompt);
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
    const explanation = explanationMatch?.[1]?.trim() || 'Resolved';

    // Verify no conflict markers remain
    const markerRe = /^(<{7}|={7}|>{7})/m;
    if (markerRe.test(resolvedCode)) {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: 'Resolution still contains conflict markers'
      };
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

/**
 * Resolve all conflicts in a large file using chunked strategy
 * 
 * WHY: This is the main entry point for large file resolution.
 * It orchestrates extraction, resolution, and reconstruction.
 */
export async function resolveConflictsChunked(
  llm: LLMClient,
  filePath: string,
  content: string,
  baseBranch: string
): Promise<{ resolved: boolean; content: string; explanation: string }> {
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

  const lines = content.split('\n');
  const resolutions = new Map<number, string[]>(); // startLine -> resolved lines
  const explanations: string[] = [];
  let allResolved = true;

  // Resolve each chunk
  for (const chunk of chunks) {
    const result = await resolveConflictChunk(llm, filePath, chunk, baseBranch);
    
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
    return resolvePackageJsonConflict(content);
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
        // Couldn't parse as dependency entries — keep conflict for manual/LLM resolution
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
  baseBranch: string
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
      llm, filePath, largeSide, smallSide, baseBranch
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
  baseBranch: string
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
    const response = await llm.complete(prompt);
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
  } catch (error) {
    // LLM failed — fail-safe: assume small side may have additions to avoid data loss
    debug('LLM small-side check failed, flagging for manual review', { error });
    return { hasAdditions: true, explanation: 'LLM check failed — manual review required' };
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
}
