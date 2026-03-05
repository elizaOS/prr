/**
 * Cleanup created sync target files (CLAUDE.md, AGENTS.md, CONVENTIONS.md).
 * Only removes files that did not exist at session start (originalSyncTargetState).
 * WHY: Repo-owned files (e.g. project CLAUDE.md) must not be deleted; we only
 * clean up files prr created when syncing lessons so the PR isn't polluted.
 */
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import type { SimpleGit } from 'simple-git';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug } from '../../../shared/logger.js';


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
      // Check file's git status
      const status = await git.status(['CLAUDE.md']).catch(() => null);

      if (status?.deleted?.includes('CLAUDE.md')) {
        // File is staged for deletion - just unstage it and we're done
        await git.reset(['HEAD', 'CLAUDE.md']).catch(() => {});
        console.log(chalk.gray('  Unstaged CLAUDE.md deletion (file was already marked for deletion)'));
      } else {
        // Check if CLAUDE.md is tracked in git
        const tracked = await git.raw(['ls-files', 'CLAUDE.md']).catch(() => '');
        if (tracked.trim()) {
          // Remove from git tracking
          await git.raw(['rm', '--cached', 'CLAUDE.md']).catch((err) => {
            debug('Could not git rm CLAUDE.md', { error: err instanceof Error ? err.message : String(err) });
          });
          console.log(chalk.gray('  Removed CLAUDE.md from git (created by prr, not in original PR)'));
        }
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

  // Same for AGENTS.md (created when codex is active tool)
  const agentsMdExisted = LessonsAPI.Detect.didSyncTargetExist(lessonsContext, 'agents-md');
  if (!agentsMdExisted) {
    const agentsMdPath = join(workdir, 'AGENTS.md');

    try {
      const status = await git.status(['AGENTS.md']).catch(() => null);

      if (status?.deleted?.includes('AGENTS.md')) {
        await git.reset(['HEAD', 'AGENTS.md']).catch(() => {});
        console.log(chalk.gray('  Unstaged AGENTS.md deletion'));
      } else {
        const tracked = await git.raw(['ls-files', 'AGENTS.md']).catch(() => '');
        if (tracked.trim()) {
          await git.raw(['rm', '--cached', 'AGENTS.md']).catch((err) => {
            debug('Could not git rm AGENTS.md', { error: err instanceof Error ? err.message : String(err) });
          });
          console.log(chalk.gray('  Removed AGENTS.md from git (created by prr, not in original PR)'));
        }
      }

      if (existsSync(agentsMdPath)) {
        await unlink(agentsMdPath);
        debug('Deleted AGENTS.md created by prr');
      }
    } catch (err) {
      debug('Could not clean up AGENTS.md', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Same for CONVENTIONS.md
  const conventionsMdExisted = LessonsAPI.Detect.didSyncTargetExist(lessonsContext, 'conventions-md');
  if (!conventionsMdExisted) {
    const conventionsMdPath = join(workdir, 'CONVENTIONS.md');

    try {
      // Check file's git status
      const status = await git.status(['CONVENTIONS.md']).catch(() => null);

      if (status?.deleted?.includes('CONVENTIONS.md')) {
        // File is staged for deletion - just unstage it and we're done
        await git.reset(['HEAD', 'CONVENTIONS.md']).catch(() => {});
        console.log(chalk.gray('  Unstaged CONVENTIONS.md deletion (file was already marked for deletion)'));
      } else {
        const tracked = await git.raw(['ls-files', 'CONVENTIONS.md']).catch(() => '');
        if (tracked.trim()) {
          await git.raw(['rm', '--cached', 'CONVENTIONS.md']).catch((err) => {
            debug('Could not git rm CONVENTIONS.md', { error: err instanceof Error ? err.message : String(err) });
          });
          console.log(chalk.gray('  Removed CONVENTIONS.md from git (created by prr, not in original PR)'));
        }
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
