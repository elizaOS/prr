/**
 * Lessons retrieval functions
 */
import type { LessonsContext } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';

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
