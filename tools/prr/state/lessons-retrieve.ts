/**
 * Lessons retrieval functions
 */
import type { LessonsContext } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';

const LESSON_TARGET_PATH_PATTERN = /\b([a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt))\b/g;
const ISSUE_TOKEN_STOPWORDS = new Set([
  'about', 'actual', 'address', 'already', 'because', 'change', 'changes', 'comment', 'current',
  'detail', 'different', 'edit', 'error', 'file', 'files', 'fix', 'fixed', 'issue', 'issues',
  'listed', 'location', 'needs', 'only', 'path', 'paths', 'provided', 'review', 'runtime',
  'should', 'snippet', 'target', 'targets', 'test', 'tests', 'that', 'their', 'there', 'these',
  'they', 'this', 'those', 'tries', 'trying', 'update', 'with', 'wrong',
]);

function tokenizeIssueContext(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 4) continue;
    if (ISSUE_TOKEN_STOPWORDS.has(part)) continue;
    tokens.add(part);
  }
  return tokens;
}

function extractLessonTargetPaths(lesson: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  LESSON_TARGET_PATH_PATTERN.lastIndex = 0;
  while ((m = LESSON_TARGET_PATH_PATTERN.exec(lesson)) !== null) {
    const path = Normalize.sanitizeFilePathHeader(m[1] ?? '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function lessonMatchesIssueContext(
  lesson: string,
  issueFilePath: string,
  commentBody: string,
  allowedPaths: string[] = []
): boolean {
  const cleanedIssue = Normalize.sanitizeFilePathHeader(issueFilePath);
  const currentPaths = new Set(
    [cleanedIssue, ...allowedPaths.map((p) => Normalize.sanitizeFilePathHeader(p))].filter(Boolean)
  );
  const lessonTargets = extractLessonTargetPaths(lesson);
  if (/TARGET FILE\(S\)|Only edit the file\(s\) listed in TARGET FILE\(S\)/i.test(lesson) && lessonTargets.length > 0) {
    if (!lessonTargets.some((p) => currentPaths.has(p))) return false;
  }

  const issueTokens = tokenizeIssueContext(`${issueFilePath}\n${commentBody}`);
  if (issueTokens.size === 0) return true;
  const lessonTokens = tokenizeIssueContext(lesson);
  if (lessonTokens.size === 0) return true;
  for (const token of lessonTokens) {
    if (issueTokens.has(token)) return true;
  }
  return false;
}

/**
 * Get lessons for a SINGLE file (no global lessons).
 * Used for inline per-issue lesson injection in the fix prompt.
 */
export function getLessonsForFile(ctx: LessonsContext, filePath: string): string[] {
  const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
  return [...(ctx.store.files[cleanedPath] || [])];
}

/**
 * Get lessons for a single-issue prompt: file-scoped for this path plus only global lessons
 * that are path-relevant to the current issue (audit M2). Excludes global lessons that
 * mention a different file path (e.g. "Only edit ... TARGET FILE(S): other/path") so
 * we don't show disallowed-file lessons from unrelated issues.
 */
export function getLessonsForSingleIssue(ctx: LessonsContext, issueFilePath: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const cleanedIssue = Normalize.sanitizeFilePathHeader(issueFilePath);
  const issueRoot = issueFilePath.split('/')[0] ?? '';

  // File-scoped lessons for this issue's path
  const fileLessons = ctx.store.files[cleanedIssue] || [];
  for (const lesson of fileLessons) {
    const key = Normalize.lessonKey(lesson);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(lesson);
    }
  }

  // Global lessons only if path-relevant: exclude lessons that mention a different target file (audit M2)
  const otherPathPattern = /(?:TARGET FILE\(S\)|Only edit the file\(s\) listed in TARGET FILE\(S\)|edit the file\(s\) listed in)\s*[:\s]*([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_/.()-]+)/i;
  for (const lesson of ctx.store.global) {
    const match = lesson.match(otherPathPattern);
    if (match) {
      const mentionedPath = (match[1] ?? '').trim();
      const mentionedRoot = mentionedPath.split('/')[0] ?? '';
      if (mentionedPath && mentionedRoot !== issueRoot && !cleanedIssue.includes(mentionedPath) && !mentionedPath.includes(cleanedIssue)) {
        continue; // skip global lesson that targets a different file
      }
    }
    const key = Normalize.lessonKey(lesson);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(lesson);
    }
  }

  return result;
}

/** Get lessons relevant to one issue, not just one file. */
export function getLessonsForIssue(
  ctx: LessonsContext,
  issueFilePath: string,
  commentBody: string,
  allowedPaths: string[] = []
): string[] {
  return getLessonsForSingleIssue(ctx, issueFilePath)
    .filter((lesson) => lessonMatchesIssueContext(lesson, issueFilePath, commentBody, allowedPaths));
}

export function getLessonsForFiles(ctx: LessonsContext, filePaths: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  
  for (const lesson of ctx.store.global) {
    const key = Normalize.lessonKey(lesson);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(lesson);
    }
  }
  
  for (const filePath of filePaths) {
    const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
    const lessons = ctx.store.files[cleanedPath] || [];
    for (const lesson of lessons) {
      const key = Normalize.lessonKey(lesson);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(lesson);
      }
    }
  }
  
  return result;
}

export function getAllLessons(ctx: LessonsContext): {
  global: string[];
  files: Record<string, string[]>;
} {
  return {
    global: [...ctx.store.global],
    files: { ...ctx.store.files },
  };
}

export function getTotalCount(ctx: LessonsContext): number {
  const globalCount = ctx.store.global.length;
  const fileCount = Object.values(ctx.store.files).reduce((sum, arr) => sum + arr.length, 0);
  return globalCount + fileCount;
}

export function getNewLessonsCount(ctx: LessonsContext): number {
  return ctx.newLessonsThisSession;
}

export function getExistingLessonsCount(ctx: LessonsContext): number {
  return ctx.initialLessonCount;
}

export function getCounts(ctx: LessonsContext): {
  global: number;
  fileSpecific: number;
  files: number;
  newThisSession: number;
} {
  const fileSpecificCount = Object.values(ctx.store.files).reduce((sum, arr) => sum + arr.length, 0);
  return {
    global: ctx.store.global.length,
    fileSpecific: fileSpecificCount,
    files: Object.keys(ctx.store.files).length,
    newThisSession: ctx.newLessonsThisSession,
  };
}

export function hasNewLessonsForRepo(ctx: LessonsContext): boolean {
  return ctx.repoLessonsDirty;
}
