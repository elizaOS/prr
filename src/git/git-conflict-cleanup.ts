/**
 * Cleanup created sync target files
 */
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import type { SimpleGit } from 'simple-git';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug } from '../logger.js';


export async function cleanupCreatedSyncTargets(
  git: SimpleGit,
  workdir: string,
  lessonsContext: LessonsContext | null
): Promise<void> {
  if (!lessonsContext || !workdir) return;

  // Check if CLAUDE.md was created by us (didn't exist before)
  const claudeMdExisted = LessonsAPI.Detect.didSyncTargetExist(lessonsContext, 'claude-md');
  if (!claudeMdExisted) {
    const claudeMdPath = join(workdir, 'CLAUDE.md');
    
    try {
      // Check if CLAUDE.md is tracked in git
      const tracked = await git.raw(['ls-files', 'CLAUDE.md']).catch(() => '');
      if (tracked.trim()) {
        // Remove from git tracking
        await git.raw(['rm', '--cached', 'CLAUDE.md']);
        console.log(chalk.gray('  Removed CLAUDE.md from git (created by prr, not in original PR)'));
      }
      
      // Delete the file if it exists
      if (existsSync(claudeMdPath)) {
        await unlink(claudeMdPath);
        debug('Deleted CLAUDE.md created by prr');
      }
    } catch (err) {
      debug('Could not clean up CLAUDE.md', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Same for CONVENTIONS.md
  const conventionsMdExisted = LessonsAPI.Detect.didSyncTargetExist(lessonsContext, 'conventions-md');
  if (!conventionsMdExisted) {
    const conventionsMdPath = join(workdir, 'CONVENTIONS.md');
    
    try {
      const tracked = await git.raw(['ls-files', 'CONVENTIONS.md']).catch(() => '');
      if (tracked.trim()) {
        await git.raw(['rm', '--cached', 'CONVENTIONS.md']);
        console.log(chalk.gray('  Removed CONVENTIONS.md from git (created by prr, not in original PR)'));
      }
      
      if (existsSync(conventionsMdPath)) {
        await unlink(conventionsMdPath);
        debug('Deleted CONVENTIONS.md created by prr');
      }
    } catch (err) {
      debug('Could not clean up CONVENTIONS.md', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
