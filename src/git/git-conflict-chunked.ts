/**
 * Chunked conflict resolution for large files
 * 
 * WHY: Large files (>50KB) exceed LLM token limits when sent whole.
 * This module extracts individual conflict regions, resolves them separately,
 * and reconstructs the file - enabling programmatic resolution of any size file.
 */

import type { LLMClient } from '../llm/client.js';
import { debug } from '../logger.js';

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
    if (resolvedCode.includes('<<<<<<<') || resolvedCode.includes('>>>>>>>')) {
      return {
        resolved: false,
        resolvedLines: chunk.conflictLines,
        explanation: 'Resolution still contains conflict markers'
      };
    }

    return {
      resolved: true,
      resolvedLines: resolvedCode.split('\n'),
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

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      ours = [];
      theirs = [];
      inTheirs = false;
    } else if (line.startsWith('=======') && inConflict) {
      inTheirs = true;
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      // Try to merge ours and theirs
      const merged = mergePackageJsonChunks(ours, theirs);
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
function mergePackageJsonChunks(ours: string[], theirs: string[]): string[] | null {
  // Simple strategy: parse dependencies, take higher versions
  const oursMap = parsePackageLines(ours);
  const theirsMap = parsePackageLines(theirs);
  
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
  const entries = Array.from(merged.entries())
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([pkg, version], idx) => {
    const comma = idx < entries.length - 1 ? ',' : '';
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
  if (nonEmptyLines > 0 && matchedLines < nonEmptyLines * 0.5) {
    return null;
  }
  
  return map;
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
    // (e.g., 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0)
    return prerelease1.localeCompare(prerelease2);
  }
  
  return 0;
}
