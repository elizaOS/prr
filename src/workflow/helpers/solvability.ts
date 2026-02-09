/**
 * Issue solvability detection and snippet refresh
 * 
 * Catches unsolvable issues early (deleted files, exhausted attempts, line drift)
 * before any LLM call, and refreshes stale snippets between fix iterations.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ReviewComment } from '../../github/types.js';
import type { StateContext } from '../../state/state-context.js';
import type { UnresolvedIssue } from '../../analyzer/types.js';
import * as Performance from '../../state/state-performance.js';
import * as Dismissed from '../../state/state-dismissed.js';
import { MAX_DISTINCT_FAILED_ATTEMPTS } from '../../constants.js';

export const SNIPPET_PLACEHOLDER = '(file not found or unreadable)';

export interface SolvabilityResult {
  solvable: boolean;
  reason?: string;                    // For logging
  dismissCategory?: 'stale' | 'exhausted';
  contextHints?: string[];            // Injected into LLM prompt in Phase 3
  retargetedLine?: number;            // If smart re-targeting found the code at a different line
}

/**
 * Assess whether an issue is solvable before attempting any LLM call.
 * Checks file existence, line validity with smart re-targeting, and attempt exhaustion.
 * 
 * WHY: Eliminates LLM cost for deleted files, line drift, and exhausted retries.
 */
export function assessSolvability(
  workdir: string,
  comment: ReviewComment,
  stateContext: StateContext
): SolvabilityResult {
  // Check 1: File existence
  const fullPath = join(workdir, comment.path);
  if (!existsSync(fullPath)) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: `File no longer exists: ${comment.path}`,
    };
  }

  // Check 2: Smart snippet re-targeting for line drift
  if (comment.line !== null) {
    try {
      const fileContent = readFileSync(fullPath, 'utf-8');
      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // Extract identifiers from comment (backtick-wrapped)
      const identifiers = extractIdentifiers(comment.body);

      if (comment.line > totalLines) {
        // Line is out of range - try to re-target using identifiers
        if (identifiers.length > 0) {
          const retargetResult = findClosestOccurrence(lines, identifiers, comment.line);
          if (retargetResult.found) {
            return {
              solvable: true,
              retargetedLine: retargetResult.line,
              contextHints: [`Code for \`${identifiers[0]}\` found at line ${retargetResult.line} (comment targeted line ${comment.line})`],
            };
          } else {
            return {
              solvable: true,
              contextHints: [`Identifier \`${identifiers[0]}\` from comment not found in file — code may have been removed or renamed`],
            };
          }
        }
        // No identifiers to re-target with - add warning hint
        return {
          solvable: true,
          contextHints: [`File has ${totalLines} lines but comment targets line ${comment.line} — code location may have shifted`],
        };
      } else if (identifiers.length > 0) {
        // Line is within range - check if identifiers are near the target line
        const snippetRegionStart = Math.max(0, comment.line - 15);
        const snippetRegionEnd = Math.min(totalLines, comment.line + 15);
        const snippetRegion = lines.slice(snippetRegionStart, snippetRegionEnd).join('\n');

        let foundInRegion = false;
        for (const ident of identifiers) {
          if (snippetRegion.includes(ident)) {
            foundInRegion = true;
            break;
          }
        }

        if (!foundInRegion) {
          // Identifiers not in expected region - try to re-target
          const retargetResult = findClosestOccurrence(fileContent, lines, identifiers, comment.line);
          if (retargetResult.found && Math.abs(retargetResult.line! - comment.line) > 10) {
            return {
              solvable: true,
              retargetedLine: retargetResult.line,
              contextHints: [`Code for \`${identifiers[0]}\` found at line ${retargetResult.line} (comment targeted line ${comment.line})`],
            };
          }
        }
      }
    } catch {
      // File read failed after existsSync passed - let it fall through to snippet fetch
    }
  }

  // Check 3: Attempt exhaustion
  const attempts = Performance.getIssueAttempts(stateContext, comment.id);
  const failedCombos = new Set(
    attempts
      .filter(a => a.result === 'failed' || a.result === 'no-changes')
      .map(a => `${a.tool}/${a.model}`)
  );

  if (failedCombos.size >= MAX_DISTINCT_FAILED_ATTEMPTS) {
    return {
      solvable: false,
      dismissCategory: 'exhausted',
      reason: `${failedCombos.size} distinct tool/model combinations failed`,
    };
  }

  // All checks passed - issue is solvable
  return { solvable: true };
}

/**
 * Extract identifiers from comment body (backtick-wrapped).
 * Example: "The `processUser` function needs..." => ["processUser"]
 */
export function extractIdentifiers(commentBody: string): string[] {
  const identPattern = /`(\w+)`/g;
  const matches: string[] = [];
  let match;
  while ((match = identPattern.exec(commentBody)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

/**
 * Find the closest occurrence of identifiers to the original line.
 * Prefers occurrences near the original line to handle insertion-drift correctly.
 */
function findClosestOccurrence(
  lines: string[],
  identifiers: string[],
  originalLine: number
): { found: boolean; line?: number } {
  for (const ident of identifiers) {
    // Find all line numbers where this identifier appears
    const occurrences: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(ident)) {
        occurrences.push(i + 1); // 1-indexed
      }
    }

    if (occurrences.length > 0) {
      // Pick the occurrence closest to the original line
      let closestLine = occurrences[0];
      let minDistance = Math.abs(occurrences[0] - originalLine);
      for (const lineNum of occurrences) {
        const distance = Math.abs(lineNum - originalLine);
        if (distance < minDistance) {
          minDistance = distance;
          closestLine = lineNum;
        }
      }
      return { found: true, line: closestLine };
    }
  }
  return { found: false };
}

/**
 * Refresh code snippets for issues whose files were touched by the fixer.
 * Catches files deleted by the fixer and updates snippets so next iteration's prompt is accurate.
 * 
 * Returns a new array (does not mutate input).
 * WHY: Caller decides how to apply the update (consistent with push-iteration-loop patterns).
 */
export async function recheckSolvability(
  unresolvedIssues: UnresolvedIssue[],
  changedFiles: string[],
  workdir: string,
  stateContext: StateContext,
  getCodeSnippetFn: (path: string, line: number | null, body?: string) => Promise<string>
): Promise<{ updated: UnresolvedIssue[]; dismissed: number; refreshed: number }> {
  const updated: UnresolvedIssue[] = [];
  let dismissed = 0;
  let refreshed = 0;

  for (const issue of unresolvedIssues) {
    if (changedFiles.includes(issue.comment.path)) {
      // File was touched - re-fetch snippet
      const newSnippet = await getCodeSnippetFn(
        issue.comment.path,
        issue.comment.line,
        issue.comment.body
      );

      if (newSnippet === SNIPPET_PLACEHOLDER) {
        // File was deleted by fixer - dismiss as stale
        // CRITICAL: dismissIssue ONLY, NOT markVerified (see plan gotcha #1)
        Dismissed.dismissIssue(
          stateContext,
          issue.comment.id,
          'File deleted by fixer',
          'stale',
          issue.comment.path,
          issue.comment.line,
          issue.comment.body
        );
        dismissed++;
        // Exclude from output array
        continue;
      }

      // Update snippet
      updated.push({
        ...issue,
        codeSnippet: newSnippet,
      });
      refreshed++;
    } else {
      // File not touched - keep as-is
      updated.push(issue);
    }
  }

  return { updated, dismissed, refreshed };
}
