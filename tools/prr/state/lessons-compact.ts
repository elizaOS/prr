/**
 * Lessons compaction
 */
import type { LessonsContext } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';

export function compact(ctx: LessonsContext, maxPerFile: number = 10, maxGlobal: number = 20): number {
  let removed = 0;
  
  const globalBefore = ctx.store.global.length;
  ctx.store.global = ctx.store.global.slice(-maxGlobal);
  removed += globalBefore - ctx.store.global.length;
  
  for (const filePath in ctx.store.files) {
    const before = ctx.store.files[filePath].length;
    ctx.store.files[filePath] = ctx.store.files[filePath].slice(-maxPerFile);
    removed += before - ctx.store.files[filePath].length;
    
    if (ctx.store.files[filePath].length === 0) {
      delete ctx.store.files[filePath];
    }
  }
  
  if (removed > 0) {
    ctx.dirty = true;
    ctx.repoLessonsDirty = true;
  }
  
  return removed;
}
