/**
 * Lesson cleanup after issue verification.
 *
 * When a fix is verified as correct, many of the lessons accumulated for that
 * file were specific to *failed attempts* (e.g., "Fix for X:Y - the diff
 * didn't add Z"). These are no longer useful and pollute future prompts.
 *
 * We distinguish two types:
 *   1. Fix-attempt lessons — prefixed with "Fix for <path>" — describe what
 *      a specific attempt got wrong. Safe to remove once the issue is fixed.
 *   2. Constraint lessons — technical facts about the codebase that remain
 *      true regardless of whether a particular issue was fixed. Keep these.
 *
 * The caller decides which file/line pairs have been fixed and calls
 * `cleanupLessonsForFixedIssue` for each. We remove the attempt-specific
 * lessons and keep everything else.
 */

import type { LessonsContext } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';

/**
 * Remove fix-attempt lessons for a specific file after its issue was verified.
 *
 * @param ctx      The lessons context (mutated in place)
 * @param filePath The file whose issue was just fixed
 * @param line     Optional line number for more targeted cleanup
 * @returns        Number of lessons removed
 */
export function cleanupLessonsForFixedIssue(
  ctx: LessonsContext,
  filePath: string,
  line: number | null
): number {
  const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
  if (!cleanedPath) return 0;

  const lessons = ctx.store.files[cleanedPath];
  if (!lessons || lessons.length === 0) return 0;

  const before = lessons.length;
  ctx.store.files[cleanedPath] = lessons.filter(lesson => {
    // Keep lessons that don't look like fix-attempt debris.
    // Fix-attempt lessons follow the pattern: "Fix for <path>:<line> - <description>"
    const isFixAttempt = /^Fix for\s+/i.test(lesson);
    if (!isFixAttempt) return true; // Keep: it's a constraint, not an attempt

    // If we have a specific line, only remove lessons for that exact line
    if (line !== null) {
      const lineMatch = lesson.match(/^Fix for\s+[^:]+:(\d+|null)\b/i);
      if (lineMatch) {
        const lessonLine = lineMatch[1];
        // Remove if lesson targets this exact line OR targets "null" (no line)
        return lessonLine !== String(line) && lessonLine !== 'null';
      }
    }

    // No line or can't parse line → remove all fix-attempt lessons for this file
    return false;
  });

  const removed = before - ctx.store.files[cleanedPath].length;

  if (ctx.store.files[cleanedPath].length === 0) {
    delete ctx.store.files[cleanedPath];
  }

  if (removed > 0) {
    ctx.dirty = true;
    ctx.repoLessonsDirty = true;
    // Keep newLessonsThisSession in sync so "New lessons: +N (total: M)" is consistent after cleanup.
    ctx.newLessonsThisSession = Math.max(0, ctx.newLessonsThisSession - removed);
  }

  return removed;
}
