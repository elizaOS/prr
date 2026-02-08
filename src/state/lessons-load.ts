/**
 * Lessons loading functions
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { LessonsContext, LessonsStore } from './lessons-context.js';
import { getPrrLessonsPath } from './lessons-paths.js';
import * as Normalize from './lessons-normalize.js';
import * as Parse from './lessons-parse.js';
import * as Prune from './lessons-prune.js';

export async function loadLessons(ctx: LessonsContext): Promise<void> {
  await loadLocalLessons(ctx);
  
  if (ctx.workdir) {
    await loadPrrLessons(ctx);
  }
  
  const globalCount = ctx.store.global.length;
  const fileCount = Object.keys(ctx.store.files).length;
  const fileLessonCount = Object.values(ctx.store.files).reduce((sum, arr) => sum + arr.length, 0);
  
  ctx.initialLessonCount = globalCount + fileLessonCount;
  ctx.newLessonsThisSession = 0;
  
  if (globalCount > 0 || fileLessonCount > 0) {
    console.log(`Loaded lessons: ${globalCount} global, ${fileLessonCount} file-specific (${fileCount} files)`);
  }
}

async function loadLocalLessons(ctx: LessonsContext): Promise<void> {
  if (existsSync(ctx.localStorePath)) {
    try {
      const content = await readFile(ctx.localStorePath, 'utf-8');
      const loaded = JSON.parse(content) as LessonsStore;
      
      if (loaded.owner === ctx.store.owner &&
          loaded.repo === ctx.store.repo &&
          loaded.branch === ctx.store.branch) {
        ctx.store = loaded;
        
        const prunedTransient = Prune.pruneTransientLessons(ctx);
        if (prunedTransient > 0) {
          console.log(`Pruned ${prunedTransient} stale/transient lessons`);
          ctx.dirty = true;
        }
        
        const sanitizedModels = Prune.sanitizeModelNames(ctx);
        if (sanitizedModels > 0) {
          console.log(`Sanitized ${sanitizedModels} lessons (removed model names)`);
        }
        
        const prunedRelative = Prune.pruneRelativeLessons(ctx);
        if (prunedRelative > 0) {
          console.log(`Pruned ${prunedRelative} lessons with relative references`);
        }
      }
    } catch (error) {
      console.warn('Failed to load local lessons file, starting fresh:', error);
    }
  }
}

async function loadPrrLessons(ctx: LessonsContext): Promise<void> {
  if (!ctx.workdir) return;
  
  const prrLessonsPath = getPrrLessonsPath(ctx.workdir);
  if (!existsSync(prrLessonsPath)) return;
  
  try {
    const content = await readFile(prrLessonsPath, 'utf-8');
    const repoLessons = Parse.parseMarkdownLessons(content);
    let merged = 0;
    
    const globalSeen = new Set(ctx.store.global.map(l => Normalize.lessonKey(l)));
    const globalNearSeen = new Set(ctx.store.global.map(l => Normalize.lessonNearKey(l)));
    for (const rawLesson of repoLessons.global) {
      const normalized = Normalize.normalizeLessonText(rawLesson);
      if (!normalized) continue;
      const key = Normalize.lessonKey(normalized);
      const nearKey = Normalize.lessonNearKey(normalized);
      if (globalSeen.has(key) || globalNearSeen.has(nearKey)) continue;
      globalSeen.add(key);
      globalNearSeen.add(nearKey);
      ctx.store.global.push(normalized);
      merged++;
    }
    
    for (const [rawPath, lessons] of Object.entries(repoLessons.files)) {
      const cleanedPath = Normalize.sanitizeFilePathHeader(rawPath);
      if (!cleanedPath) continue;
      if (!ctx.store.files[cleanedPath]) {
        ctx.store.files[cleanedPath] = [];
      }
      const fileSeen = new Set(ctx.store.files[cleanedPath].map(l => Normalize.lessonKey(l)));
      const fileNearSeen = new Set(ctx.store.files[cleanedPath].map(l => Normalize.lessonNearKey(l)));
      for (const rawLesson of lessons) {
        const normalized = Normalize.normalizeLessonText(rawLesson);
        if (!normalized) continue;
        const key = Normalize.lessonKey(normalized);
        const nearKey = Normalize.lessonNearKey(normalized);
        if (fileSeen.has(key) || fileNearSeen.has(nearKey)) continue;
        fileSeen.add(key);
        fileNearSeen.add(nearKey);
        ctx.store.files[cleanedPath].push(normalized);
        merged++;
      }
    }
    
    if (merged > 0) {
      console.log(`Merged ${merged} lessons from .prr/lessons.md`);
    }
  } catch (error) {
    console.warn('Failed to load .prr/lessons.md:', error);
  }
}
