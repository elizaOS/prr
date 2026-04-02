/**
 * Add inline code comments for dismissed review issues.
 * 
 * WHY: Review bots need to see a dialog trail in the code. When PRR dismisses
 * an issue (already-fixed, stale, remaining, etc.), adding an inline comment visible
 * in the diff lets bots and humans understand the reasoning on the next review pass.
 * 
 * CRITICAL: The LLM returns ONLY comment text. We insert it programmatically to
 * avoid any risk of the LLM modifying code logic.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DismissedIssue } from '../state/types.js';
import type { LLMClient } from '../llm/client.js';
import { debug } from '../../../shared/logger.js';
import { PROTECTED_DIRS } from '../../../shared/git/git-commit-core.js';
import { resolveTrackedPath } from './helpers/solvability.js';

/**
 * Map file extension to comment syntax.
 * Fallback to '//' for unknown extensions (safe for most C-style languages).
 */
function getCommentSyntax(filePath: string): { start: string; end?: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  
  // Single-line comment languages
  if (['ts', 'tsx', 'js', 'jsx', 'java', 'go', 'rs', 'c', 'cpp', 'cc', 'h', 'hpp', 'swift', 'kt', 'cs'].includes(ext)) {
    return { start: '//' };
  }
  if (['py', 'rb', 'sh', 'bash', 'yaml', 'yml', 'toml', 'pl', 'r'].includes(ext)) {
    return { start: '#' };
  }
  if (['sql'].includes(ext)) {
    return { start: '--' };
  }
  
  // Block comment languages
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return { start: '/*', end: '*/' };
  }
  if (['html', 'xml', 'svg', 'vue'].includes(ext)) {
    return { start: '<!--', end: '-->' };
  }
  
  // Fallback
  return { start: '//' };
}

/**
 * File extensions that have no comment syntax (e.g. JSON). We never insert
 * inline comments into these — filtering here avoids invalid syntax.
 */
const NO_COMMENT_EXTENSIONS = new Set(['json']);

/**
 * Binary file extensions that should never be commented.
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
  'wasm', 'bin', 'exe', 'dll', 'so', 'dylib',
  'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'lock', 'lockb', 'pyc', 'class', 'jar', 'o',
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Check if content contains null bytes (likely binary).
 */
function hasNullBytes(content: string): boolean {
  return content.includes('\0');
}

/**
 * True when the dismissal reason indicates the concern is not solvable via a code comment
 * (e.g. PR title, metadata, labels). WHY: Audit showed dismissal LLM asked for "vague PR title"
 * on README line 1 — no code comment helps; skipping saves tokens.
 */
const REASON_METADATA_OR_UNSOLVABLE = /\b(PR\s*(title|metadata|description|labels?)|title\s+too\s+vague|not\s+solvable\s+via\s+(file\s+edits?|code)|metadata\s+change|comment\s+requests\s+PR\s)/i;

function isReasonMetadataOrUnsolvable(reason: string): boolean {
  return REASON_METADATA_OR_UNSOLVABLE.test(reason);
}

/** Matches common comment starts (//, #, /*, *, <!--) so we catch Note:/Review: in any style. */
const REVIEW_COMMENT_START = /^\s*(\/\/|#|\/\*|\*|<!--)/;

/**
 * Phrases that indicate a comment already "addresses the concern" (LLM would respond EXISTING).
 * WHY: Pre-check matched only "Review:". Bots and prior runs also use "Note:", "Addresses", "Fixed", etc.
 * Matching these avoids LLM calls that return EXISTING and saves tokens + latency.
 */
const DISMISSAL_COMMENT_PHRASES = [
  /Note:/i,
  /Review:/i,
  /Addresses?\s/i,
  /Dismissed/i,
  /already\s+fixed/i,
  /no\s+change\s+(needed|required)?/i,
  /PRR:/i,
  /not\s+an\s+issue/i,
  /false\s+positive/i,
  /self-?explanatory/i,
  /intentional\s*[—\-]/i,
];

/**
 * Check if a "Note:", "Review:", or similar dismissal comment already exists near the target line.
 * WHY: Skips the dismissal LLM call when we or a previous run already added an explanatory comment.
 * We recognize both Note: (current) and Review: (legacy) so existing comments are not duplicated.
 * Radius ±7 matches the LLM context window so we don't call the LLM only to get EXISTING back.
 */
function hasExistingReviewComment(
  lines: string[],
  targetLine: number,
  _commentPrefix: string
): boolean {
  // WHY 7: Matches the LLM context window (contextBefore/contextAfter). With 3 we missed existing
  // Note:/Review: comments that the LLM could see, causing redundant calls that always returned EXISTING.
  const checkRadius = 7;
  const start = Math.max(0, targetLine - 1 - checkRadius);
  const end = Math.min(lines.length, targetLine + checkRadius);

  for (let i = start; i < end; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Require comment syntax so we don't match code; then match any phrase that means "already addressed"
    if (!REVIEW_COMMENT_START.test(lines[i])) continue;
    if (DISMISSAL_COMMENT_PHRASES.some((p) => p.test(line))) return true;
  }

  return false;
}

/**
 * Insert a comment at the specified line in a file.
 * 
 * CRITICAL DESIGN:
 * - The comment text comes from the LLM as a plain string
 * - We add comment syntax and indentation programmatically
 * - We insert ABOVE the target line (target line is line N, we insert at N-1)
 * - We match the target line's indentation
 * 
 * Returns true if inserted, false if skipped.
 */
async function insertCommentAtLine(
  workdir: string,
  filePath: string,
  line: number,
  commentText: string
): Promise<boolean> {
  try {
    const fullPath = join(workdir, filePath);
    
    if (!existsSync(fullPath)) {
      debug('Skipping insertion of dismissal comment: file not in workdir (no place to insert comment)', { filePath });
      return false;
    }
    
    const content = readFileSync(fullPath, 'utf-8');
    
    // Check for null bytes (binary file)
    if (hasNullBytes(content)) {
      debug('File contains null bytes (binary), skipping', { filePath });
      return false;
    }
    
    const lines = content.split('\n');
    
    // Validate line number
    if (line < 1 || line > lines.length) {
      debug('Line number out of range', { filePath, line, totalLines: lines.length });
      return false;
    }
    
    // Get comment syntax for this file type
    const commentSyntax = getCommentSyntax(filePath);
    
    // Fast check: does a Note:/Review: comment already exist nearby?
    if (hasExistingReviewComment(lines, line, commentSyntax.start)) {
      debug('Review comment already exists near target line', { filePath, line });
      return false;
    }
    
    // Get indentation from target line
    const targetLine = lines[line - 1];
    const indentMatch = targetLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    
    // Format the comment with proper syntax and indentation
    let formattedComment: string;
    if (commentSyntax.end) {
      // Block comment (e.g., /* ... */ or <!-- ... -->)
      formattedComment = `${indent}${commentSyntax.start} ${commentText} ${commentSyntax.end}`;
    } else {
      // Single-line comment (e.g., // or #)
      formattedComment = `${indent}${commentSyntax.start} ${commentText}`;
    }
    
    // Insert the comment ABOVE the target line
    // Line numbers are 1-indexed, array is 0-indexed
    lines.splice(line - 1, 0, formattedComment);
    
    // Write back
    writeFileSync(fullPath, lines.join('\n'), 'utf-8');
    
    debug('Inserted dismissal comment', { filePath, line, commentLength: commentText.length });
    return true;
  } catch (error) {
    debug('Failed to insert comment', { filePath, line, error: String(error) });
    return false;
  }
}

/**
 * Add dismissal comments for all eligible dismissed issues.
 * 
 * ALGORITHM:
 * 1. Filter to commentable categories and non-null lines
 * 2. Group by file
 * 3. Sort by line DESC within each file (avoid line number shifting)
 * 4. For each issue: check for existing comment, LLM generate if needed, insert
 * 
 * Returns counts for logging.
 */
export async function addDismissalComments(
  dismissedIssues: DismissedIssue[],
  workdir: string,
  llm: LLMClient,
  verifiedThisSession?: Set<string>
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  
  // Filter to commentable categories
  const commentableCategories = new Set(['already-fixed', 'stale', 'not-an-issue', 'false-positive', 'exhausted', 'remaining', 'chronic-failure']);
  const commentable = dismissedIssues.filter(issue => {
    // Must have a category we want to comment on
    if (!commentableCategories.has(issue.category)) {
      return false;
    }

    // Skip issues the fixer resolved this session — adding a "dismissed" comment
    // on code the fixer just fixed creates a confusing re-insertion loop.
    if (verifiedThisSession?.has(issue.commentId)) {
      return false;
    }

    // WHY skip: For already-fixed, the LLM would only respond EXISTING; audit showed 62% of dismissal LLM responses were EXISTING. Skipping saves tokens; code/diff is self-documenting.
    if (issue.category === 'already-fixed') {
      debug('Skipping dismissal comment (already-fixed — no LLM call; code/diff is self-documenting)', {
        filePath: issue.filePath,
        line: issue.line,
        reasonPreview: issue.reason.substring(0, 60),
      });
      return false;
    }

    // Skip when the reason indicates positive feedback or no actionable issue — no need for a "dismissed" comment (prompts.log audit).
    if (/\b(?:positive\s+feedback|no\s+actionable\s+issue|no\s+issue\s+to\s+address)\b/i.test(issue.reason)) {
      debug('Skipping dismissal comment (positive feedback / no actionable issue)', {
        filePath: issue.filePath,
        reasonPreview: issue.reason.substring(0, 60),
      });
      return false;
    }

    // Skip when the reason says the concern is PR metadata/title/labels — no code comment helps.
    if (isReasonMetadataOrUnsolvable(issue.reason)) {
      debug('Skipping dismissal comment (metadata/PR-level, not solvable via code comment)', {
        filePath: issue.filePath,
        reasonPreview: issue.reason.substring(0, 60),
      });
      return false;
    }

    // Skip when the reason says the file no longer exists — no code location to insert a comment.
    if (/\b(?:file\s+no\s+longer\s+exists|file\s+not\s+found|no\s+longer\s+exists)\b/i.test(issue.reason)) {
      debug('Skipping dismissal comment: issue target file no longer exists (no place to insert comment)', {
        filePath: issue.filePath,
        reasonPreview: issue.reason.substring(0, 60),
      });
      return false;
    }

    // Skip fix-failure categories: these are real issues the fixer couldn't resolve.
    // Adding a "Note:" that explains them as intentional is misleading.
    if (['exhausted', 'remaining', 'chronic-failure'].includes(issue.category)) {
      debug('Skipping dismissal comment (fix-failure category — real issue, not intentional)', {
        filePath: issue.filePath,
        category: issue.category,
        reasonPreview: issue.reason.substring(0, 60),
      });
      return false;
    }
    
    // Must have a line number (not null)
    if (issue.line === null) {
      return false;
    }
    
    // Must not be a binary file
    if (isBinaryFile(issue.filePath)) {
      return false;
    }

    // Must not be a file type with no comment syntax (e.g. JSON)
    const ext = issue.filePath.split('.').pop()?.toLowerCase() || '';
    if (NO_COMMENT_EXTENSIONS.has(ext)) {
      return false;
    }

    // Skip tool-managed paths (same list as commit artifact exclusion)
    if (PROTECTED_DIRS.some(dir => issue.filePath.startsWith(dir))) {
      return false;
    }

    // Must have a non-empty reason
    if (!issue.reason || issue.reason.trim().length === 0) {
      return false;
    }
    
    return true;
  });
  
  if (commentable.length === 0) {
    debug('No dismissed issues eligible for comments');
    return { added, skipped };
  }
  
  debug('Processing dismissal comments', { 
    total: dismissedIssues.length, 
    commentable: commentable.length 
  });

  // One dismissal comment per (filePath, line) to avoid duplicate LLM calls and "already exists" skips
  const byFileAndLine = new Map<string, DismissedIssue>();
  for (const issue of commentable) {
    const key = `${issue.filePath}:${issue.line}`;
    if (!byFileAndLine.has(key)) byFileAndLine.set(key, issue);
  }
  const toProcess = [...byFileAndLine.values()];
  if (toProcess.length < commentable.length) {
    debug('Deduplicated dismissal comments by (file, line)', { before: commentable.length, after: toProcess.length });
  }
  
  // Group by file for "check once" pass (read each file once)
  const byFile = new Map<string, DismissedIssue[]>();
  for (const issue of toProcess) {
    if (!byFile.has(issue.filePath)) {
      byFile.set(issue.filePath, []);
    }
    byFile.get(issue.filePath)!.push(issue);
  }

  // Pass 1: Check once per (file, line) — skip LLM if Note:/Review: comment already exists.
  // Dedupe by (filePath, effectiveLine) so multiple issues that clamp to the same line
  // get one LLM call and one insert (avoids wasted parallel calls and duplicate-insert skips).
  // Resolve truncated paths (e.g. "verify/route.ts" from bot markdown) to full repo paths via git ls-files.
  type ToGenerate = { issue: DismissedIssue; filePath: string; effectiveLine: number; surroundingCode: string };
  const toGenerate: ToGenerate[] = [];
  for (const [filePath, issues] of byFile.entries()) {
    let resolvedPath = filePath;
    let fullPath = join(workdir, resolvedPath);
    if (!existsSync(fullPath)) {
      const resolved = resolveTrackedPath(workdir, filePath, issues[0]?.commentBody ?? '');
      if (resolved) {
        resolvedPath = resolved;
        fullPath = join(workdir, resolvedPath);
        debug('Resolved truncated path to repo file', { from: filePath, to: resolvedPath });
      }
    }
    if (!existsSync(fullPath)) {
      debug('Skipping insertion of dismissal comments: file not in workdir (no place to insert comment)', { filePath: resolvedPath, count: issues.length });
      skipped += issues.length;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch (err) {
      debug('Error reading file for dismissal check', { filePath: resolvedPath, error: String(err) });
      skipped += issues.length;
      continue;
    }
    const lines = content.split('\n');
    if (lines.length === 0) {
      skipped += issues.length;
      continue;
    }
    const commentSyntax = getCommentSyntax(resolvedPath);
    const seenLineInFile = new Set<number>();
    for (const issue of issues) {
      if (issue.line === null) {
        skipped++;
        continue;
      }
      const effectiveLine = Math.min(Math.max(1, issue.line), lines.length);
      if (seenLineInFile.has(effectiveLine)) {
        debug('Deduplicated by (file, effectiveLine) — one comment per location', { filePath: resolvedPath, effectiveLine });
        skipped++;
        continue;
      }
      if (hasExistingReviewComment(lines, effectiveLine, commentSyntax.start)) {
        debug('Review comment already exists near target line (skipping LLM)', { filePath: resolvedPath, line: effectiveLine });
        skipped++;
        continue;
      }
      seenLineInFile.add(effectiveLine);
      const contextBefore = 7;
      const contextAfter = 7;
      const start = Math.max(0, effectiveLine - contextBefore - 1);
      const end = Math.min(lines.length, effectiveLine + contextAfter);
      const surroundingCode = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n');
      toGenerate.push({ issue, filePath: resolvedPath, effectiveLine, surroundingCode });
    }
  }

  if (toGenerate.length === 0) {
    debug('Dismissal comments complete (all skipped by pre-check)', { added, skipped });
    return { added, skipped };
  }

  // Pass 2: Call LLM in parallel for all issues that need a comment
  const results = await Promise.all(
    toGenerate.map((t) =>
      llm.generateDismissalComment({
        filePath: t.filePath,
        line: t.effectiveLine,
        surroundingCode: t.surroundingCode,
        reviewComment: t.issue.commentBody,
        dismissalReason: t.issue.reason!,
        category: t.issue.category,
      })
    )
  );

  // Pass 3: Insert comments per file, bottom-to-top (line DESC) so line numbers don't shift
  const withComment = toGenerate
    .map((t, i) => ({ ...t, result: results[i] }))
    .filter((x) => x.result.needed && x.result.commentText) as (ToGenerate & { result: { commentText: string } })[];
  const byFileForInsert = new Map<string, { effectiveLine: number; commentText: string }[]>();
  for (const x of withComment) {
    if (!byFileForInsert.has(x.filePath)) byFileForInsert.set(x.filePath, []);
    byFileForInsert.get(x.filePath)!.push({ effectiveLine: x.effectiveLine, commentText: x.result.commentText });
  }
  for (const [filePath, items] of byFileForInsert.entries()) {
    items.sort((a, b) => b.effectiveLine - a.effectiveLine);
    for (const { effectiveLine, commentText } of items) {
      try {
        const inserted = await insertCommentAtLine(workdir, filePath, effectiveLine, commentText);
        if (inserted) added++;
        else skipped++;
      } catch (err) {
        debug('Error inserting dismissal comment', { filePath, effectiveLine, error: String(err) });
        skipped++;
      }
    }
  }
  skipped += toGenerate.length - withComment.length;

  debug('Dismissal comments complete', { added, skipped });
  return { added, skipped };
}
