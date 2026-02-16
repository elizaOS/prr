/**
 * Add inline code comments for dismissed review issues.
 * 
 * WHY: Review bots need to see a dialog trail in the code. When PRR dismisses
 * an issue (already-fixed, stale, exhausted), adding an inline comment visible
 * in the diff lets bots and humans understand the reasoning on the next review pass.
 * 
 * CRITICAL: The LLM returns ONLY comment text. We insert it programmatically to
 * avoid any risk of the LLM modifying code logic.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DismissedIssue } from '../state/types.js';
import type { LLMClient } from '../llm/client.js';
import { debug } from '../logger.js';

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
 * Binary file extensions that should never be commented.
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
  'wasm', 'bin', 'exe', 'dll', 'so', 'dylib',
  'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'lock', 'pyc', 'class', 'jar', 'o',
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
 * Check if a "Review:" comment already exists near the target line.
 * Fast check to avoid unnecessary LLM calls (belt-and-suspenders on top of LLM's check).
 */
function hasExistingReviewComment(
  lines: string[],
  targetLine: number,
  commentPrefix: string
): boolean {
  const checkRadius = 3;
  const start = Math.max(0, targetLine - 1 - checkRadius);
  const end = Math.min(lines.length, targetLine + checkRadius);
  
  for (let i = start; i < end; i++) {
    const line = lines[i].trim();
    // Check for "Review:" with the expected comment syntax
    if (line.startsWith(commentPrefix) && line.includes('Review:')) {
      return true;
    }
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
      debug('File no longer exists, skipping comment insertion', { filePath });
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
    
    // Fast check: does a "Review:" comment already exist nearby?
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
  llm: LLMClient
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  
  // Filter to commentable categories
  const commentableCategories = new Set(['already-fixed', 'stale', 'not-an-issue', 'false-positive', 'exhausted']);
  const commentable = dismissedIssues.filter(issue => {
    // Must have a category we want to comment on
    if (!commentableCategories.has(issue.category)) {
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
  
  // Group by file
  const byFile = new Map<string, DismissedIssue[]>();
  for (const issue of commentable) {
    if (!byFile.has(issue.filePath)) {
      byFile.set(issue.filePath, []);
    }
    byFile.get(issue.filePath)!.push(issue);
  }
  
  // Process each file
  for (const [filePath, issues] of byFile.entries()) {
    const fullPath = join(workdir, filePath);
    
    // Check file still exists
    if (!existsSync(fullPath)) {
      debug('File no longer exists, skipping all issues', { filePath, count: issues.length });
      skipped += issues.length;
      continue;
    }
    
    // Sort by line DESC (Pitfall #2: insert bottom-to-top to avoid line shifting)
    const sorted = issues.sort((a, b) => (b.line || 0) - (a.line || 0));
    
    // Process each issue in this file
    for (const issue of sorted) {
      if (issue.line === null) {
        skipped++;
        continue;
      }
      
      try {
        // Read surrounding code for LLM context
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        
        const contextBefore = 7;
        const contextAfter = 7;
        const start = Math.max(0, issue.line - contextBefore - 1);
        const end = Math.min(lines.length, issue.line + contextAfter);
        
        const surroundingCode = lines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}: ${l}`)
          .join('\n');
        
        // Call LLM to check if comment is needed and generate text
        const result = await llm.generateDismissalComment({
          filePath: issue.filePath,
          line: issue.line,
          surroundingCode,
          reviewComment: issue.commentBody,
          dismissalReason: issue.reason,
          category: issue.category,
        });
        
        if (!result.needed || !result.commentText) {
          skipped++;
          continue;
        }
        
        // Insert the comment programmatically
        const inserted = await insertCommentAtLine(
          workdir,
          issue.filePath,
          issue.line,
          result.commentText
        );
        
        if (inserted) {
          added++;
        } else {
          skipped++;
        }
      } catch (error) {
        debug('Error processing dismissal comment', { 
          filePath: issue.filePath, 
          line: issue.line,
          error: String(error) 
        });
        skipped++;
      }
    }
  }
  
  debug('Dismissal comments complete', { added, skipped });
  return { added, skipped };
}
