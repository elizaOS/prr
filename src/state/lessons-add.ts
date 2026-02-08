/**
 * Add lessons functions
 */
import type { LessonsContext } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';

export function addLesson(ctx: LessonsContext, lesson: string): void {
  const normalized = Normalize.normalizeLessonText(lesson);
  if (!normalized) return;
  
  const filePath = Normalize.extractLessonFilePath(normalized);
  if (filePath) {
    addFileLesson(ctx, filePath, normalized);
  } else {
    addGlobalLesson(ctx, normalized);
  }
}

export function addGlobalLesson(ctx: LessonsContext, lesson: string): void {
  const normalized = Normalize.normalizeLessonText(lesson);
  if (!normalized) return;
  
  const key = Normalize.lessonKey(normalized);
  const nearKey = Normalize.lessonNearKey(normalized);
  const existingKeys = ctx.store.global.map(l => Normalize.lessonKey(l));
  const existingNearKeys = ctx.store.global.map(l => Normalize.lessonNearKey(l));
  
  if (!existingKeys.includes(key) && !existingNearKeys.includes(nearKey)) {
    ctx.store.global.push(normalized);
    ctx.dirty = true;
    ctx.repoLessonsDirty = true;
    ctx.newLessonsThisSession++;
  }
}

export function addFileLesson(ctx: LessonsContext, filePath: string, lesson: string): void {
  const normalized = Normalize.normalizeLessonText(lesson);
  if (!normalized) return;
  
  const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
  if (!cleanedPath) return;
  
  if (!ctx.store.files[cleanedPath]) {
    ctx.store.files[cleanedPath] = [];
  }
  
  const key = Normalize.lessonKey(normalized);
  const nearKey = Normalize.lessonNearKey(normalized);
  const existingKeys = ctx.store.files[cleanedPath].map(l => Normalize.lessonKey(l));
  const existingNearKeys = ctx.store.files[cleanedPath].map(l => Normalize.lessonNearKey(l));
  
  if (!existingKeys.includes(key) && !existingNearKeys.includes(nearKey)) {
    ctx.store.files[cleanedPath].push(normalized);
    ctx.dirty = true;
    ctx.repoLessonsDirty = true;
    ctx.newLessonsThisSession++;
  }
}
