/**
 * Issue solvability detection and snippet refresh
 * 
 * Catches unsolvable issues early (deleted files, exhausted attempts, line drift)
 * before any LLM call, and refreshes stale snippets between fix iterations.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import type { ReviewComment } from '../../github/types.js';
import type { StateContext } from '../../state/state-context.js';
import type { UnresolvedIssue } from '../../analyzer/types.js';
import * as Performance from '../../state/state-performance.js';
import * as Dismissed from '../../state/state-dismissed.js';
import { MAX_DISTINCT_FAILED_ATTEMPTS, CHRONIC_FAILURE_THRESHOLD, VERIFIER_REJECTION_DISMISS_THRESHOLD, WRONG_FILE_EXHAUST_THRESHOLD } from '../../constants.js';
import { isLockFile, getLockFileInfo } from '../../git/git-lock-files.js';
import { hashFileContentSync } from '../../utils/file-hash.js';

export const SNIPPET_PLACEHOLDER = '(file not found or unreadable)';

export interface SolvabilityResult {
  solvable: boolean;
  reason?: string;                    // For logging
  dismissCategory?: 'stale' | 'exhausted' | 'not-an-issue' | 'chronic-failure';
  /** Next-step for humans (e.g. lockfile: "Run: bun install") */
  remediationHint?: string;
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
  // Check 0a: PR metadata requests (title, description, labels, etc.)
  // WHY: Some review comments ask to update the PR title/description/labels,
  // which are GitHub API operations — not file edits. The fixer can't solve
  // these, and they loop forever (observed: "update PR title" re-attempted 5+
  // times with 0 progress, generating noise lessons and wasting iterations).
  if (isPRMetadataRequest(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: 'Comment requests PR metadata change (title/description/labels) — not solvable via file edits',
    };
  }

  // Check 0b: Path traversal guard (comment.path comes from GitHub API)
  const fullPath = join(workdir, comment.path);
  const resolvedWorkdir = resolve(workdir);
  const resolvedPath = resolve(fullPath);
  if (!resolvedPath.startsWith(resolvedWorkdir + sep) && resolvedPath !== resolvedWorkdir) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: `Path outside workdir: ${comment.path}`,
    };
  }

  // Check 0c: Tool-artifact paths (.prr/ is tool-managed; fixer must not modify, and file may not exist yet)
  // WHY: Bots sometimes comment on .prr/lessons.md (e.g. "remove from version control"). We exclude these
  // so we never fetch snippets (ENOENT) or send fix prompts for our own artifact paths.
  const normalizedPath = comment.path.replace(/\\/g, '/');
  if (normalizedPath.startsWith('.prr/')) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: `Path is under .prr/ (tool-managed); excluded from fix loop`,
    };
  }

  // Check 0d: Lockfiles — LLM search/replace fails on lockfiles; use package manager instead
  // WHY: bun.lock, package-lock.json, etc. are generated; edits should be "run bun install" / "npm install"
  if (isLockFile(normalizedPath)) {
    const lockInfo = getLockFileInfo(normalizedPath);
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: `Lockfile — update with package manager (e.g. bun install, npm install) instead of editing`,
      remediationHint: lockInfo ? `Run: ${lockInfo.regenerateCmd}` : undefined,
    };
  }

  // Check 0e: Verifier rejected this issue N+ times — stop retrying to save tokens.
  // WHY: Fixer/verifier stalemates (fixer says ALREADY_FIXED, verifier says still exists) burn tokens
  // on repeated attempts; dismissing as "exhausted" defers to human follow-up.
  const rejectionCount = stateContext.state?.verifierRejectionCount?.[comment.id] ?? 0;
  if (rejectionCount >= VERIFIER_REJECTION_DISMISS_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'exhausted',
      reason: `Verifier rejected fix/claim ${rejectionCount} time(s) — dismissing to avoid repeated retries`,
    };
  }

  // Check 0f: "Tool modified wrong files" N+ times — fix likely requires a different file than comment path.
  // WHY: When the fix belongs in another file (e.g. duplicate interface in commit.ts, comment on git-push.ts),
  // the fixer keeps trying the commented file and burns all models; exhausting defers to human.
  const wrongFileCount = stateContext.state?.wrongFileLessonCountByCommentId?.[comment.id] ?? 0;
  if (wrongFileCount >= WRONG_FILE_EXHAUST_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'exhausted',
      reason: `Fixer modified wrong files ${wrongFileCount} time(s) — issue may require changes in another file; dismissing for human follow-up`,
    };
  }

  // Check 1: File existence
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
              solvable: false,
              dismissCategory: 'stale',
              contextHints: [`Comment targets line ${comment.line} but file only has ${totalLines} lines, and identifier \`${identifiers[0]}\` not found — code may have been removed or renamed`],
            };
          // Review: identifies no longer found indicates code has shifted; thus, marked as stale.
          }
        }
        // No identifiers to re-target with - mark as stale
        return {
          solvable: false,
          dismissCategory: 'stale',
          contextHints: [`File has ${totalLines} lines but comment targets line ${comment.line} — code location may have shifted and no identifiers found to re-target`],
        };
      } else if (identifiers.length > 0) {
        // Line is within range - check if identifiers are near the target line
        const targetIdx = comment.line - 1;
        const snippetRegionStart = Math.max(0, targetIdx - 15);
        const snippetRegionEnd = Math.min(totalLines, targetIdx + 15 + 1);
        // Review: captures a ±15 line context around the target for better identifier matching
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
          const retargetResult = findClosestOccurrence(lines, identifiers, comment.line);
          if (retargetResult.found && Math.abs(retargetResult.line! - comment.line) > 10) {
            return {
              solvable: true,
              retargetedLine: retargetResult.line,
              contextHints: [`Code for \`${identifiers[0]}\` found at line ${retargetResult.line} (comment targeted line ${comment.line})`],
            };
          } else if (!retargetResult.found) {
            // Identifiers not found anywhere in the file - mark as stale
            return {
              solvable: false,
              dismissCategory: 'stale',
              contextHints: [`Comment targets line ${comment.line} but identifier \`${identifiers[0]}\` not found in file — code may have been removed or renamed`],
            };
          }
        }
      }
    } catch {
      // File read failed after existsSync passed - let it fall through to snippet fetch
    }
  }

  // Check 3: Chronic failure — total failed attempts for current file version only
  // WHY: Same issue failing N+ times burns tokens; only count attempts on same file content so refactors reset the counter
  const attempts = Performance.getIssueAttempts(stateContext, comment.id);
  let failedAttempts = attempts.filter(a => a.result === 'failed' || a.result === 'no-changes');
  const currentHash = hashFileContentSync(fullPath);
  failedAttempts = failedAttempts.filter(a => !a.fileContentHash || a.fileContentHash === currentHash);
  if (failedAttempts.length >= CHRONIC_FAILURE_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'chronic-failure',
      reason: `Chronic failure: ${failedAttempts.length} fix attempts failed (current file version) — dismissing to avoid infinite retries`,
    };
  // Note: filters out past failures to avoid infinite retries on known chronic issues.
  }

  // Check 4: Attempt exhaustion — distinct tool/model combinations (same file-version filter)
  const failedCombos = new Set(
    failedAttempts.map(a => `${a.tool}/${a.model}`)
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
  let dismissed = 0;
  let refreshed = 0;

  // Split into changed vs unchanged (sync), then batch-fetch changed snippets.
  // WHY parallel: Each snippet read is for a different file. With 10+ changed
  // issues, sequential reads waste ~0.5-1s of accumulated I/O latency.
  const unchanged: UnresolvedIssue[] = [];
  const changed: UnresolvedIssue[] = [];

  for (const issue of unresolvedIssues) {
    if (changedFiles.includes(issue.comment.path)) {
      changed.push(issue);
    } else {
      unchanged.push(issue);
    }
  }

  // Fetch all changed snippets concurrently
  const snippetResults = await Promise.all(
    changed.map(async (issue) => {
      const newSnippet = await getCodeSnippetFn(
        issue.comment.path,
        issue.comment.line,
        issue.comment.body
      );
      return { issue, newSnippet };
    })
  );

  const updated: UnresolvedIssue[] = [...unchanged];

  for (const { issue, newSnippet } of snippetResults) {
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
      continue;
    }

    // Preserve all issue fields (e.g. verifierContradiction) so AAR and next fix prompt see them
    updated.push({
      ...issue,
      codeSnippet: newSnippet,
    });
    refreshed++;
  }

  return { updated, dismissed, refreshed };
}

/**
 * Detect whether a review comment is asking for a PR metadata change
 * (title, description, labels, branch name) rather than a code change.
 *
 * WHY heuristic instead of LLM: This runs before any LLM call, for every
 * comment, every iteration. Must be zero-cost. False negatives are fine
 * (comment goes to LLM as normal); false positives are bad (real issue
 * dismissed). The patterns are conservative — they require both a PR
 * metadata keyword AND an action verb in the same sentence.
 */
function isPRMetadataRequest(commentBody: string): boolean {
  // Normalize: collapse whitespace, lowercase for matching
  const normalized = commentBody.toLowerCase().replace(/\s+/g, ' ');

  // Patterns: "PR title should", "update the PR description", etc.
  const metadataPatterns = [
    /\bpr\s+title\b.*\b(should|must|needs?\s+to|update|change|rename|reflect|misleading|inaccurate)\b/,
    /\b(update|change|rename|fix|improve|revise)\b.*\bpr\s+title\b/,
    /\bpr\s+description\b.*\b(should|must|needs?\s+to|update|change|reflect|misleading|inaccurate)\b/,
    /\b(update|change|rename|fix|improve|revise)\b.*\bpr\s+description\b/,
    /\bpull\s+request\s+title\b.*\b(should|must|needs?\s+to|update|change|reflect)\b/,
    /\b(update|change)\b.*\bpull\s+request\s+(title|description)\b/,
  ];

  return metadataPatterns.some(p => p.test(normalized));
}
