/**
 * Issue solvability detection and snippet refresh
 * 
 * Catches unsolvable issues early (deleted files, line drift, chronic failure)
 * before any LLM call, and refreshes stale snippets between fix iterations.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import type { ReviewComment } from '../../github/types.js';
import type { StateContext } from '../../state/state-context.js';
import type { UnresolvedIssue } from '../../analyzer/types.js';
import * as Performance from '../../state/state-performance.js';
import * as Dismissed from '../../state/state-dismissed.js';
import { ALREADY_FIXED_EXHAUST_THRESHOLD, ALREADY_FIXED_ANY_THRESHOLD, CANNOT_FIX_EXHAUST_THRESHOLD, CHRONIC_FAILURE_THRESHOLD, CANNOT_FIX_MISSING_CONTENT_THRESHOLD, VERIFIER_REJECTION_DISMISS_THRESHOLD, WRONG_FILE_EXHAUST_THRESHOLD, WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD } from '../../../../shared/constants.js';
import { pluralize } from '../../../../shared/logger.js';
import { isLockFile, getLockFileInfo } from '../../../../shared/git/git-lock-files.js';
import { hashFileContentSync } from '../../../../shared/utils/file-hash.js';

export const SNIPPET_PLACEHOLDER = '(file not found or unreadable)';

const repoFilesCache = new Map<string, string[]>();

/**
 * Resolve a possibly truncated review path to a tracked repo file.
 *
 * WHY: Review bots often cite non-root-relative paths like `generate-skills-md.ts`,
 * `SKILL.md`, or `wallet/nfts/route.ts`. Using the raw path in solvability caused
 * incorrect "File no longer exists" dismissal before the fix loop even started.
 *
 * Strategy:
 * 1. Exact tracked-file match → use as-is.
 * 2. Unique suffix match (`foo/bar.ts` or bare basename) → use that file.
 * 3. Ambiguous basename → return null rather than guessing the wrong file.
 */
export function resolveTrackedPath(workdir: string, rawPath: string): string | null {
  let repoFiles = repoFilesCache.get(workdir);
  if (!repoFiles) {
    try {
      const out = execFileSync('git', ['ls-files'], { cwd: workdir, encoding: 'utf8' });
      repoFiles = out.split('\n').map((f) => f.trim()).filter(Boolean);
      repoFilesCache.set(workdir, repoFiles);
    } catch {
      return null;
    }
  }
  const exact = repoFiles.find((f) => f === rawPath);
  if (exact) return exact;
  const suffixMatches = repoFiles.filter((f) => f.endsWith('/' + rawPath) || f === rawPath);
  if (suffixMatches.length === 0) return null;
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (!rawPath.includes('/')) return null;
  return suffixMatches.reduce((a, b) => (a.length <= b.length ? a : b));
}

export interface SolvabilityResult {
  solvable: boolean;
  reason?: string;                    // For logging
  dismissCategory?: 'stale' | 'remaining' | 'not-an-issue' | 'chronic-failure' | 'already-fixed';
  /** Next-step for humans (e.g. lockfile: "Run: bun install") */
  remediationHint?: string;
  contextHints?: string[];            // Injected into LLM prompt in Phase 3
  retargetedLine?: number;            // If smart re-targeting found the code at a different line
}

/**
 * Assess whether an issue is solvable before attempting any LLM call.
 * Checks file existence, line validity with smart re-targeting, and attempt exhaustion.
 * 
 * WHY: Eliminates LLM cost for deleted files, line drift, and chronic retries.
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

  // Check 0a2: Summary/meta-review comments (reviewer recap tables: "| Issue | Status |" with ✅/❌/Fixed/Still missing)
  // WHY: These are status recaps of many issues, not a single fixable item. Treating them as one issue causes
  // verifier confusion (e.g. "patchComponent tests: Still missing" row → NO with wrong reasoning). Dismiss so we don't fix "the summary".
  if (isSummaryOrMetaReviewComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Summary or meta-review comment (status recap table), not a single fixable issue',
    };
  }

  // Check 0a3: Pure approval comments ("Approve", "All critical issues addressed/resolved", "LGTM")
  // WHY: Audit showed approval comments consumed 10+ fix cycles because they survived dedup and existence checks.
  if (isApprovalComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Approval/verdict comment — no issue to fix',
    };
  }

  // Check 0a4: "What's Good" / positive-summary meta-comments (reviewer recap, not a single fixable issue).
  // WHY: Audit showed "### ✅ What's Good" comments entered the fix loop and consumed iterations; they are meta-review, not actionable.
  if (isWhatsGoodOrPositiveSummaryComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: "Positive summary / \"What's Good\" meta-comment — not a single fixable issue",
    };
  }

  // Check 0a5: Bot progress / checklist comments ("PR Review in Progress", "Task List", etc.)
  // WHY: output.log/prompts.log audit showed these status posts can enter the fix loop,
  // where every model correctly says "not actionable" but we still burn a full stale cycle.
  if (isBotProgressOrChecklistComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Bot progress/checklist comment — review status update, not a code issue to fix',
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

  // Check 0e: Synthetic path "(PR comment)" — no file path in comment body (inferPathLineFromBody fallback).
  // WHY: Fixer cannot edit a non-file; every attempt fails and burns iterations; dismiss up front.
  if (normalizedPath === '(PR comment)') {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Synthetic path "(PR comment)" — no target file for fixer to edit',
    };
  }

  // Resolve truncated/basename review paths to tracked repo files before existence checks.
  // WHY: Without this, comments on `generate-skills-md.ts` or `SKILL.md` were dismissed as stale
  // even though the real repo files existed at `scripts/...` / `skills/babylon/...`.
  const effectivePath = resolveTrackedPath(workdir, comment.path) ?? comment.path;
  const effectiveFullPath = join(workdir, effectivePath);

  // Check 0e1: Issue references line numbers beyond current file length (file was shortened → comment stale).
  // WHY: output.log audit — DATABASE_API_README.md had 37 lines but review referenced "lines 56-57, 120-121"; verifier couldn't confirm and we burned 3+ iterations.
  try {
    if (existsSync(effectiveFullPath)) {
      const content = readFileSync(effectiveFullPath, 'utf8');
      const lineCount = content.split('\n').length;
      const maxRef = extractMaxLineRefFromBody(comment.body);
      if (maxRef != null && lineCount < maxRef) {
        return {
          solvable: false,
          dismissCategory: 'stale',
          reason: `Issue references line(s) up to ${maxRef} but file has ${lineCount} line(s) — likely stale (file shortened)`,
        };
      }
    }
  } catch {
    /* ignore read errors */
  }

  // Check 0e2: CANNOT_FIX exhaustion — fixer said CANNOT_FIX N times (output.log audit); dismiss as not-an-issue.
  const cannotFixConsecutive = stateContext.state?.cannotFixConsecutiveByCommentId?.[comment.id] ?? 0;
  if (cannotFixConsecutive >= CANNOT_FIX_EXHAUST_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: `CANNOT_FIX ${cannotFixConsecutive}× — dismissing as not fixable via code changes`,
    };
  }

  // Check 0f: CANNOT_FIX with missing/placeholder file content — circuit breaker.
  // WHY: Audit showed 10+ retries on placeholder files (500K+ tokens wasted). If the file content
  // is broken/missing and the fixer has said so N times, retrying with the same broken input won't help.
  const cannotFixCount = stateContext.state?.cannotFixMissingContentCountByCommentId?.[comment.id] ?? 0;
  if (cannotFixCount >= CANNOT_FIX_MISSING_CONTENT_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `CANNOT_FIX (file content missing/placeholder) ${cannotFixCount}× — skipping to avoid token waste`,
    };
  }

  // Check 1: File existence
  if (!existsSync(effectiveFullPath)) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: `File no longer exists: ${comment.path}`,
    };
  }

  // Check 2: Smart snippet re-targeting for line drift
  if (comment.line !== null) {
    try {
      const fileContent = readFileSync(effectiveFullPath, 'utf-8');
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
            const msg = `Comment targets line ${comment.line} but file only has ${totalLines} lines, and identifier \`${identifiers[0]}\` not found — code may have been removed or renamed`;
            return {
              solvable: false,
              dismissCategory: 'stale',
              reason: msg,
              contextHints: [msg],
            };
          // Review: identifies no longer found indicates code has shifted; thus, marked as stale.
          }
        }
        // No identifiers to re-target with - mark as stale
        const msg = `File has ${totalLines} lines but comment targets line ${comment.line} — code location may have shifted and no identifiers found to re-target`;
        return {
          solvable: false,
          dismissCategory: 'stale',
          reason: msg,
          contextHints: [msg],
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
            const msg = `Comment targets line ${comment.line} but identifier \`${identifiers[0]}\` not found in file — code may have been removed or renamed`;
            return {
              solvable: false,
              dismissCategory: 'stale',
              reason: msg,
              contextHints: [msg],
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

  // Check 3b: Verifier rejection exhaustion — verifier kept rejecting fix/ALREADY_FIXED; stop retries (remaining for human follow-up).
  const verifierRejections = stateContext.state?.verifierRejectionCount?.[comment.id] ?? 0;
  if (verifierRejections >= VERIFIER_REJECTION_DISMISS_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `Verifier rejected fix/claim ${verifierRejections} ${pluralize(verifierRejections, 'time', 'times')} — dismissing to avoid repeated retries`,
    };
  }

  // Check 3c: Wrong-file exhaustion — fixer kept editing the wrong file; issue may need another file (e.g. tests, README). Stop retries.
  const wrongFileCount = stateContext.state?.wrongFileLessonCountByCommentId?.[comment.id] ?? 0;
  if (wrongFileCount >= WRONG_FILE_EXHAUST_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `Fixer modified wrong files ${wrongFileCount} ${pluralize(wrongFileCount, 'time', 'times')} — issue may require changes in another file; dismissing for human follow-up`,
    };
  }

  // Check 4: WRONG_LOCATION/UNCLEAR — after N consecutive same explanation, stop retries (remaining for human follow-up).
  const consecutiveSame = stateContext.state?.wrongLocationUnclearConsecutiveSameByCommentId?.[comment.id] ?? 0;
  if (consecutiveSame >= WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `UNCLEAR/WRONG_LOCATION with same explanation ${consecutiveSame}× — stopping retries`,
    };
  }

  // Check 5a: ALREADY_FIXED any-explanation counter.
  // WHY check here (before LLM calls): If 3+ models already said ALREADY_FIXED, re-running
  // the fixer would waste another iteration. Dismissing in solvability avoids the LLM call entirely.
  const alreadyFixedAny = stateContext.state?.consecutiveAlreadyFixedAnyByCommentId?.[comment.id] ?? 0;
  if (alreadyFixedAny >= ALREADY_FIXED_ANY_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'already-fixed',
      reason: `ALREADY_FIXED ${alreadyFixedAny}× (multiple models) — dismissing as already-fixed`,
    };
  }

  // Check 5b: ALREADY_FIXED exhaustion — after N consecutive same explanation, dismiss as not-an-issue (prompts.log audit).
  const alreadyFixedConsecutive = stateContext.state?.alreadyFixedConsecutiveSameByCommentId?.[comment.id] ?? 0;
  if (alreadyFixedConsecutive >= ALREADY_FIXED_EXHAUST_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: `ALREADY_FIXED ${alreadyFixedConsecutive}× with same explanation — dismissing as not-an-issue`,
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
    const primaryPath = issue.resolvedPath ?? issue.comment.path;
    if (changedFiles.includes(primaryPath)) {
      changed.push(issue);
    } else {
      unchanged.push(issue);
    }
  }

  // Fetch all changed snippets concurrently (use primary path so basename-resolved issues get correct file)
  const snippetResults = await Promise.all(
    changed.map(async (issue) => {
      const primaryPath = issue.resolvedPath ?? issue.comment.path;
      const newSnippet = await getCodeSnippetFn(
        primaryPath,
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
      const primaryPath = issue.resolvedPath ?? issue.comment.path;
      Dismissed.dismissIssue(
        stateContext,
        issue.comment.id,
        'File deleted by fixer',
        'stale',
        primaryPath,
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
function isSummaryOrMetaReviewComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 800);
  // Table with Status column and status-like cells (✅/❌/Fixed/Still missing/Addressed)
  const hasStatusTable =
    /\|[^|]*\bStatus\b[^|]*\|/i.test(head) &&
    (/\|\s*(?:✅|❌|✔|✗|Fixed|Still missing|Addressed|addressed|fixed|missing)\s*\|/i.test(head) ||
      /\|\s*.*(?:✅|❌|Fixed|Still missing).*\|\s*/.test(head));
  if (hasStatusTable) return true;
  // "### Summary" or "## Summary" with multiple issue statuses (3+)
  const summaryHeading = /^[\s\S]{0,200}(?:^|\n)\s*#{1,3}\s*Summary\b/im.test(head);
  if (summaryHeading) {
    const statusLike = head.match(/(?:✅|❌|Fixed|addressed|Still missing|missing|not done)/gi);
    if (statusLike && statusLike.length >= 3) return true;
  }
  return false;
}

/**
 * Detect pure approval/verdict comments that contain no actionable fix request.
 * Examples: "Approve", "All critical issues addressed ✅", "LGTM", "All issues resolved."
 */
function isApprovalComment(commentBody: string): boolean {
  const trimmed = commentBody.trim();
  if (trimmed.length > 500) return false;
  const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (/^(approve[d]?\.?|lgtm\.?|looks good\.?|ship it\.?)$/i.test(lower)) return true;
  if (/\ball\s+(?:critical\s+)?issues?\s+(?:have\s+been\s+)?(?:addressed|resolved|fixed)\b/i.test(lower) && !/\bbut\b|\bhowever\b|\bexcept\b|\bstill\b/i.test(lower)) return true;
  if (/\ball\s+(?:critical\s+)?issues?\s+addressed\s*✅/i.test(lower)) return true;
  return false;
}

/**
 * Detect "What's Good" / positive-summary meta-comments that list strengths, not a single fix request.
 * WHY: output.log audit — "### ✅ What's Good" at component.test.ts:12 entered fix loop and wasted iterations.
 */
function isWhatsGoodOrPositiveSummaryComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 400);
  if (/^#+\s*✅\s*What'?s Good\b/im.test(head)) return true;
  if (/^#+\s*What'?s Good\s*$/im.test(head)) return true;
  if (/^#+\s*Strengths\b/im.test(head) && !/\b(fix|change|add|remove|update)\b.*\b(line|here)\b/i.test(head)) return true;
  return false;
}

/**
 * Detect bot workflow/status comments that describe the review process itself.
 * Examples: "PR Review in Progress", "Task List", checklist-only progress posts with job links.
 */
function isBotProgressOrChecklistComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 1400);
  const checklistCount = (head.match(/^\s*-\s*\[[ xX]\]\s+/gm) || []).length;
  const hasProgressHeading = /^#+\s*(?:PR Review in Progress|PR Review Complete|Task List)\b/im.test(head);
  const hasReviewWorkflowText =
    /\b(?:read repository guidelines|review existing feedback|analyze changed files and pr diff|check for tests|provide consolidated review feedback)\b/i.test(head);
  const hasJobRunLink = /\[view job run\]\(https:\/\/github\.com\/.+\/actions\/runs\/\d+\)/i.test(head);
  const requestsCodeChange =
    /\b(?:fix|change|update|rename|remove|add|implement|refactor)\b.{0,60}\b(?:file|code|function|class|test|line|path)\b/i.test(head);

  if (requestsCodeChange) return false;
  if (hasProgressHeading && checklistCount >= 2) return true;
  if (checklistCount >= 4 && hasReviewWorkflowText) return true;
  if ((hasProgressHeading || hasReviewWorkflowText) && hasJobRunLink) return true;
  return false;
}

/**
 * Extract the highest line number referenced in text (e.g. "lines 56-57, 120-121" → 121).
 * Used to detect when a review comment references lines beyond the current file length (stale).
 */
function extractMaxLineRefFromBody(body: string): number | null {
  let max = 0;
  const rangeRe = /\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(body)) !== null) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a > max) max = a;
    if (b > max) max = b;
  }
  return max > 0 ? max : null;
}

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
