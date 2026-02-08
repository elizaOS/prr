/**
 * Lessons pruning functions
 */
import { existsSync } from 'fs';
import { join } from 'path';
import type { LessonsContext } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';

const TRANSIENT_PATTERNS = [
  /connection refused/i,
  /ECONNREFUSED/i,
  /timed out/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /network error/i,
  /socket hang up/i,
  /ENOTFOUND/i,
  /getaddrinfo/i,
  /certificate/i,
  /SSL/i,
  /TLS/i,
  /rate limit/i,
  /429 Too Many Requests/i,
  /503 Service Unavailable/i,
  /502 Bad Gateway/i,
  /authentication failed/i,
  /invalid API key/i,
  /unauthorized/i,
  /permission denied/i,
  /EACCES/i,
  /spawn .* ENOENT/i,
  /command not found/i,
];

export function pruneTransientLessons(ctx: LessonsContext): number {
  let removed = 0;
  
  const isTransient = (lesson: string): boolean => {
    return TRANSIENT_PATTERNS.some(pattern => pattern.test(lesson));
  };
  
  ctx.store.global = ctx.store.global.filter(l => {
    if (isTransient(l)) {
      removed++;
      return false;
    }
    return true;
  });
  
  for (const filePath in ctx.store.files) {
    const before = ctx.store.files[filePath].length;
    ctx.store.files[filePath] = ctx.store.files[filePath].filter(l => !isTransient(l));
    removed += before - ctx.store.files[filePath].length;
    
    if (ctx.store.files[filePath].length === 0) {
      delete ctx.store.files[filePath];
    }
  }
  
  return removed;
}

export function sanitizeModelNames(ctx: LessonsContext): number {
  let sanitized = 0;
  
  const stripModelNames = (lesson: string): string => {
    return lesson.replace(/\b(?:claude-4-sonnet|gpt-4o|gemini-[^\s]+|o1-[^\s]+|deepseek-[^\s]+)\b/gi, '');
  };
  
  ctx.store.global = ctx.store.global.map(l => {
    const cleaned = stripModelNames(l);
    if (cleaned !== l) sanitized++;
    return cleaned;
  });
  
  for (const filePath in ctx.store.files) {
    ctx.store.files[filePath] = ctx.store.files[filePath].map(l => {
      const cleaned = stripModelNames(l);
      if (cleaned !== l) sanitized++;
      return cleaned;
    });
  }
  
  return sanitized;
}

export function pruneRelativeLessons(ctx: LessonsContext): number {
  let removed = 0;
  
  const hasRelativeRef = (lesson: string): boolean => {
    return /\b(?:Issue|Task|Bug|Fix)\s+\d+\b/i.test(lesson) ||
           /\bthe\s+(?:above|below|previous|next)\s+/i.test(lesson);
  };
  
  ctx.store.global = ctx.store.global.filter(l => {
    if (hasRelativeRef(l)) {
      removed++;
      return false;
    }
    return true;
  });
  
  for (const filePath in ctx.store.files) {
    const before = ctx.store.files[filePath].length;
    ctx.store.files[filePath] = ctx.store.files[filePath].filter(l => !hasRelativeRef(l));
    removed += before - ctx.store.files[filePath].length;
    
    if (ctx.store.files[filePath].length === 0) {
      delete ctx.store.files[filePath];
    }
  }
  
  return removed;
}

export function pruneDeletedFiles(ctx: LessonsContext, workdir: string): number {
  let removed = 0;
  
  for (const filePath in ctx.store.files) {
    const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
    const pathWithoutLine = cleanedPath.replace(/:\d+$/, '');
    const fullPath = join(workdir, pathWithoutLine);
    
    if (!existsSync(fullPath)) {
      const count = ctx.store.files[filePath].length;
      delete ctx.store.files[filePath];
      removed += count;
    }
  }
  
  if (removed > 0) {
    ctx.dirty = true;
    ctx.repoLessonsDirty = true;
  }
  
  return removed;
}
