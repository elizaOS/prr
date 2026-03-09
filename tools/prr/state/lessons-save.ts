/**
 * Lessons saving functions
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { LessonsContext } from './lessons-context.js';
import { getPrrLessonsPath } from './lessons-paths.js';
import * as Format from './lessons-format.js';
import * as Compact from './lessons-compact.js';

export async function save(ctx: LessonsContext): Promise<void> {
  if (!ctx.dirty) return;
  
  // Compact lessons before saving to prevent unbounded growth.
  // 10 per file, 20 global — keeps the most recent (most relevant) entries.
  Compact.compact(ctx);
  
  ctx.store.lastUpdated = new Date().toISOString();
  const dir = dirname(ctx.localStorePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  
  await writeFile(ctx.localStorePath, JSON.stringify(ctx.store, null, 2), 'utf-8');
  ctx.dirty = false;
}

export async function saveToRepo(ctx: LessonsContext): Promise<boolean> {
  if (!ctx.workdir) return false;
  if (!ctx.repoLessonsDirty) return false;
  
  const prrLessonsPath = getPrrLessonsPath(ctx.workdir);
  const markdown = Format.toMarkdown(ctx);
  
  const dir = dirname(prrLessonsPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  
  await writeFile(prrLessonsPath, markdown, 'utf-8');
  ctx.repoLessonsDirty = false;
  
  return true;
}
