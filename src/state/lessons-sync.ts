/**
 * Sync lessons to various target files
 */
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { LessonsContext, LessonsSyncTarget } from './lessons-context.js';
import { SYNC_TARGETS, PRR_SECTION_START, PRR_SECTION_END } from './lessons-paths.js';
import * as Format from './lessons-format.js';

export async function syncToTargets(ctx: LessonsContext): Promise<string[]> {
  if (!ctx.workdir) return [];
  
  const compactedMarkdown = Format.toCompactedMarkdown(ctx);
  const prrSection = `${PRR_SECTION_START}\n${compactedMarkdown}\n${PRR_SECTION_END}`;
  const syncedTo: string[] = [];
  
  for (const target of ctx.syncTargets) {
    const config = SYNC_TARGETS[target];
    const filePath = config.path(ctx.workdir);
    const existedBefore = ctx.originalSyncTargetState.get(target);
    
    try {
      if (!existsSync(filePath) && !existedBefore) {
        continue;
      }
      
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      
      let finalContent: string;
      
      if (existsSync(filePath)) {
        const existingContent = await readFile(filePath, 'utf-8');
        const startIdx = existingContent.indexOf(PRR_SECTION_START);
        const endIdx = existingContent.indexOf(PRR_SECTION_END);
        
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          finalContent =
            existingContent.slice(0, startIdx) +
            prrSection +
            existingContent.slice(endIdx + PRR_SECTION_END.length);
        } else {
          finalContent = existingContent.trimEnd() + '\n\n' + prrSection + '\n';
        }
      } else if (existedBefore) {
        finalContent = (config.createHeader || '') + prrSection + '\n';
      } else {
        continue;
      }
      
      await writeFile(filePath, finalContent, 'utf-8');
      syncedTo.push(config.description);
    } catch (error) {
      console.warn(`Failed to sync lessons to ${config.description}:`, error);
    }
  }
  
  return syncedTo;
}

export async function cleanupSyncTargets(ctx: LessonsContext): Promise<void> {
  if (!ctx.workdir) return;
  
  for (const target of ctx.syncTargets) {
    const existed = ctx.originalSyncTargetState.get(target);
    if (existed === false) {
      const config = SYNC_TARGETS[target];
      const filePath = config.path(ctx.workdir);
      if (existsSync(filePath)) {
        try {
          await unlink(filePath);
          console.log(`Cleaned up ${config.description} (created by prr, no new lessons)`);
        } catch (error) {
          console.warn(`Failed to cleanup ${config.description}:`, error);
        }
      }
    }
  }
}
