/**
 * Cleanup mode workflow
 * 
 * Handles repository cleanup tasks:
 * - Remove prr section from CLAUDE.md
 * - Remove .pr-resolver-state.json from git tracking
 * - Ensure state file is in .gitignore
 * - Clear lock file
 * - Commit and push cleanup changes
 */

import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import type { GitHubAPI } from '../github/api.js';
import type { PRInfo } from '../github/types.js';
import * as Lock from '../state/lock-functions.js';
import { debug } from '../logger.js';

/**
 * Run cleanup mode to remove prr artifacts from repository
 * 
 * CLEANUP OPERATIONS:
 * 1. Remove prr section from CLAUDE.md (if --clean-claude-md or --clean-all)
 * 2. Remove state file from git tracking (if --clean-state or --clean-all)
 * 3. Add state file to .gitignore
 * 4. Clear lock file (if --clear-lock)
 * 5. Commit and push changes (unless --no-push)
 */
export async function runCleanupMode(
  prUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  config: Config,
  options: CLIOptions,
  github: GitHubAPI,
  getWorkdirInfo: (
    workdirBase: string,
    owner: string,
    repo: string,
    prNumber: number,
    branch: string
  ) => { path: string; exists: boolean },
  ensureWorkdir: (workdir: string) => Promise<void>,
  cloneOrUpdateFn: (
    cloneUrl: string,
    branch: string,
    workdir: string,
    githubToken?: string
  ) => Promise<any>
): Promise<void> {
  const spinner = ora();
  
  console.log(chalk.cyan('━━━ CLEANUP MODE ━━━\n'));
  
  const cleanClaudeMd = options.cleanClaudeMd || options.cleanAll;
  const cleanState = options.cleanState || options.cleanAll;
  
  // Get PR info to know the branch
  spinner.start('Fetching PR information...');
  const prInfo: PRInfo = await github.getPRInfo(owner, repo, prNumber);
  spinner.succeed(`PR branch: ${prInfo.branch}`);
  
  // Set up workdir
  const { path: workdirPath, exists: workdirExists } = getWorkdirInfo(
    config.workdirBase,
    owner,
    repo,
    prNumber,
    prInfo.branch
  );
  const workdir = workdirPath;
  
  if (!workdirExists) {
    await ensureWorkdir(workdir);
    console.log(chalk.gray(`Creating workdir: ${workdir}`));
  }
  
  // Clone/update repository (pass githubToken for private repo access)
  spinner.start('Setting up repository...');
  await cloneOrUpdateFn(prInfo.cloneUrl, prInfo.branch, workdir, config.githubToken);
  spinner.succeed('Repository ready');
  
  const git = simpleGit(workdir);
  let madeChanges = false;
  
  // Clean CLAUDE.md
  if (cleanClaudeMd) {
    const claudeMdPath = join(workdir, 'CLAUDE.md');
    const PRR_SECTION_START = '<!-- PRR_LESSONS_START -->';
    const PRR_SECTION_END = '<!-- PRR_LESSONS_END -->';
    
    if (existsSync(claudeMdPath)) {
      try {
        const content = await readFile(claudeMdPath, 'utf-8');
        const startIdx = content.indexOf(PRR_SECTION_START);
        const endIdx = content.indexOf(PRR_SECTION_END);
        
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          // Remove prr section
          let newContent = content.slice(0, startIdx) + content.slice(endIdx + PRR_SECTION_END.length);
          // Clean up extra newlines
          newContent = newContent.replace(/\n{3,}/g, '\n\n').trim();
          
          if (!newContent || newContent === '# Project Configuration') {
            // File is empty or only has our header - delete it
            const tracked = await git.raw(['ls-files', 'CLAUDE.md']).catch(() => '');
            if (tracked.trim()) {
              await git.raw(['rm', 'CLAUDE.md']);
              console.log(chalk.green('✓ Deleted CLAUDE.md (was only prr content)'));
            } else {
              await unlink(claudeMdPath);
              console.log(chalk.green('✓ Deleted CLAUDE.md (was only prr content, untracked)'));
            }
          } else {
            // File has other content - just remove our section
            await writeFile(claudeMdPath, newContent + '\n', 'utf-8');
            // Check if file is staged for deletion and unstage it first
            const status = await git.status(['CLAUDE.md']).catch(() => null);
            if (status?.deleted?.includes('CLAUDE.md')) {
              await git.reset(['HEAD', 'CLAUDE.md']).catch(() => {});
            }
            await git.add('CLAUDE.md').catch((err) => {
              console.log(chalk.yellow(`  Warning: Could not stage CLAUDE.md: ${err.message}`));
            });
            console.log(chalk.green('✓ Removed prr section from CLAUDE.md'));
          }
          madeChanges = true;
        } else {
          console.log(chalk.gray('  CLAUDE.md exists but has no prr section'));
        }
      } catch (err) {
        console.log(chalk.yellow(`  Could not clean CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`));
      }
    } else {
      console.log(chalk.gray('  CLAUDE.md does not exist'));
    }
  }
  
  // Clean state file
  if (cleanState) {
    const stateFileName = '.pr-resolver-state.json';
    const stateFilePath = join(workdir, stateFileName);
    
    try {
      const tracked = await git.raw(['ls-files', stateFileName]).catch(() => '');
      if (tracked.trim()) {
        await git.raw(['rm', '--cached', stateFileName]);
        console.log(chalk.green(`✓ Removed ${stateFileName} from git tracking`));
        madeChanges = true;
      } else {
        console.log(chalk.gray(`  ${stateFileName} is not tracked in git`));
      }
      
      // Also delete the local file if it exists
      if (existsSync(stateFilePath)) {
        await unlink(stateFilePath);
        console.log(chalk.gray(`  Deleted local ${stateFileName}`));
      }
    } catch (err) {
      console.log(chalk.yellow(`  Could not clean ${stateFileName}: ${err instanceof Error ? err.message : String(err)}`));
    }
    
    // Also ensure it's in .gitignore
    const gitignorePath = join(workdir, '.gitignore');
    try {
      let gitignoreContent = '';
      try {
        gitignoreContent = await readFile(gitignorePath, 'utf-8');
      } catch { /* file doesn't exist */ }
      
      const lines = gitignoreContent.split('\n');
      const isIgnored = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === stateFileName || 
               trimmed === `/${stateFileName}` ||
               trimmed === `**/${stateFileName}`;
      });
      
      if (!isIgnored) {
        const newContent = gitignoreContent.endsWith('\n') || gitignoreContent === ''
          ? `${gitignoreContent}# prr state file (auto-generated)\n${stateFileName}\n`
          : `${gitignoreContent}\n\n# prr state file (auto-generated)\n${stateFileName}\n`;
        
        await writeFile(gitignorePath, newContent, 'utf-8');
        await git.add('.gitignore');
        console.log(chalk.green(`✓ Added ${stateFileName} to .gitignore`));
        madeChanges = true;
      }
    } catch (err) {
      debug('Could not update .gitignore', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  
  // Clear lock file
  if (options.clearLock) {
    const lockConfig = Lock.createLockConfig(workdir, { enabled: true });
    await Lock.clearLock(lockConfig, git);
    console.log(chalk.green('✓ Cleared lock file'));
  }
  
  // Commit and push if changes were made
  if (madeChanges) {
    const status = await git.status();
    if (status.staged.length > 0 || status.deleted.length > 0) {
      console.log(chalk.cyan('\nCommitting cleanup changes...'));
      await git.commit('chore: clean up prr artifacts');
      
      if (!options.noPush) {
        spinner.start('Pushing cleanup commit...');
        await git.push('origin', prInfo.branch);
        spinner.succeed('Pushed cleanup commit');
      } else {
        console.log(chalk.yellow('  Cleanup committed locally (use git push to push)'));
      }
    }
  } else {
    console.log(chalk.gray('\nNo cleanup changes needed'));
  }
  
  console.log(chalk.green('\n✓ Cleanup complete'));
}
