/**
 * Git conflict resolution for lock files
 */
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import type { SimpleGit } from 'simple-git';
import { isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from './git-clone-index.js';
import type { Config } from '../config.js';
import { setTokenPhase, debug } from '../logger.js';


export async function handleLockFileConflicts(
  git: SimpleGit,
  lockFiles: string[],
  workdir: string,
  config: Config
): Promise<void> {
  if (!workdir || !config?.workdirBase) {
    console.log(chalk.yellow('    ⚠ Skipping lock file handling: workdir not initialized'));
    return;
  }
  
  console.log(chalk.cyan('\n  Handling lock files...'));
  const { spawn } = await import('child_process');
  const fs = await import('fs');
  const path = await import('path');
  
  // Validate workdir using realpath to prevent symlink attacks
  // WHY: A malicious repo could create symlinks pointing outside the workdir
  let resolvedWorkdir: string;
  try {
    resolvedWorkdir = fs.realpathSync(workdir);
    const resolvedBase = fs.realpathSync(config.workdirBase);
    const relativeWorkdir = path.relative(resolvedBase, resolvedWorkdir);
    if (relativeWorkdir.startsWith('..') || path.isAbsolute(relativeWorkdir)) {
      throw new Error(`Workdir ${resolvedWorkdir} is outside base ${resolvedBase}`);
    }
  } catch (e) {
    console.log(chalk.red(`    ✗ Workdir validation failed: ${e}`));
    return;
  }
  
  // Whitelist of allowed package manager commands (command -> args)
  const ALLOWED_COMMANDS: Record<string, string[]> = {
    'bun install': ['bun', 'install'],
    'npm install': ['npm', 'install'],
    'yarn install': ['yarn', 'install'],
    'pnpm install': ['pnpm', 'install'],
    'cargo generate-lockfile': ['cargo', 'generate-lockfile'],
    'bundle install': ['bundle', 'install'],
    'poetry lock': ['poetry', 'lock'],
    'composer install': ['composer', 'install'],
  };
  
  // Minimal environment whitelist for package managers
  const ENV_WHITELIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 
                         'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT',
                         'NPM_TOKEN', 'YARN_ENABLE_IMMUTABLE_INSTALLS'];
  const safeEnv: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    if (process.env[key]) {
      safeEnv[key] = process.env[key]!;
    }
  }
  if (safeEnv.PATH) {
    const pathEntries = safeEnv.PATH.split(path.delimiter).filter(Boolean);
    const safePathEntries = pathEntries.filter((entry) => {
      if (!path.isAbsolute(entry)) {
        return false;
      }
      try {
        const resolvedEntry = fs.realpathSync(entry);
        return !(resolvedEntry === resolvedWorkdir || resolvedEntry.startsWith(resolvedWorkdir + path.sep));
      } catch {
        return false;
      }
    });
    safeEnv.PATH = safePathEntries.length > 0
      ? safePathEntries.join(path.delimiter)
      : '/usr/bin:/bin';
  }
  safeEnv.npm_config_ignore_scripts = 'true';
  safeEnv.YARN_ENABLE_SCRIPTS = '0';
  safeEnv.BUN_INSTALL_DISABLE_POSTINSTALL = '1';
  safeEnv.PNPM_DISABLE_SCRIPTS = 'true';
  
  // Group lock files by their regenerate command
  const regenerateCommands = new Set<string>();
  
  for (const lockFile of lockFiles) {
    const info = getLockFileInfo(lockFile);
    if (info) {
      if (!ALLOWED_COMMANDS[info.regenerateCmd]) {
        console.log(chalk.yellow(`    ⚠ Skipping ${lockFile}: command not allowed (${info.regenerateCmd})`));
        continue;
      }
      // Delete the lock file
      const fullPath = path.join(resolvedWorkdir, lockFile);
      // Verify the file path is still within workdir after join
      const resolvedFullPath = path.resolve(fullPath);
      const relativePath = path.relative(resolvedWorkdir, resolvedFullPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        console.log(chalk.yellow(`    ⚠ Skipping ${lockFile}: path traversal detected`));
        continue;
      }
      try {
        const realPath = fs.realpathSync(resolvedFullPath);
        const relativeRealPath = path.relative(resolvedWorkdir, realPath);
        if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath)) {
          console.log(chalk.yellow(`    ⚠ Skipping ${lockFile}: resolved outside workdir`));
          continue;
        }
        fs.unlinkSync(realPath);
        console.log(chalk.green(`    ✓ Deleted ${lockFile}`));
        regenerateCommands.add(info.regenerateCmd);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ Could not delete ${lockFile}: ${e}`));
      }
    }
  }
  
  // Run regenerate commands using spawn with validated args
  // Security: Only execute whitelisted commands with spawn (no shell)
  for (const cmd of regenerateCommands) {
    const cmdArgs = ALLOWED_COMMANDS[cmd];
    if (!cmdArgs) {
      console.log(chalk.yellow(`    ⚠ Skipping unknown command: ${cmd}`));
      continue;
    }
    
    const [executable, ...args] = cmdArgs;
    
    // Security: Verify executable is a simple name (no path components)
    // This ensures we use the system PATH lookup, not a potentially malicious local file
    if (executable.includes('/') || executable.includes('\\')) {
      console.log(chalk.yellow(`    ⚠ Skipping command with path in executable: ${executable}`));
      continue;
    }
    
    console.log(chalk.cyan(`    Running: ${cmd}`));
    
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(executable, args, {
          cwd: resolvedWorkdir,
          stdio: 'inherit',
          env: safeEnv,
          shell: false, // Never use shell - prevents shell injection
        });
        
        // Security: 60 second timeout prevents resource exhaustion
        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
          // Give process 5s to terminate gracefully, then SIGKILL
          setTimeout(() => proc.kill('SIGKILL'), 5000);
          reject(new Error('Timeout exceeded (60s)'));
        }, 60000);
        
        proc.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Exit code ${code}`));
          }
        });
        
        proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      console.log(chalk.green(`    ✓ ${cmd} completed`));
    } catch (e) {
      console.log(chalk.yellow(`    ⚠ ${cmd} failed: ${e}, continuing...`));
    }
  }
  
  // Stage the regenerated lock files
  for (const lockFile of lockFiles) {
    try {
      await git.add(lockFile);
    } catch {
      // File might not exist if regenerate failed, ignore
    }
  }
}

/**
 * Resolve merge conflicts using LLM tools.
 * 
 * WHY THIS EXISTS: Merge conflicts block the entire fix loop. Previously, prr would
 * bail out when conflicts were detected, requiring manual intervention. This method
 * enables automatic conflict resolution using the same LLM infrastructure we use
 * for fixing review comments.
 * 
 * WHY UNIFIED: This method is called from multiple places:
 * - Initial remote conflict detection (previous interrupted merge)
 * - Pull conflicts (diverged branches)
 * - Stash pop conflicts (interrupted run with local changes)
 * - PR merge conflicts (base branch out of sync)
 * Centralizing the logic ensures consistent behavior and reduces code duplication.
 * 
 * Two-stage resolution:
 * 1. Lock files: Delete and regenerate via package manager
 *    WHY: LLMs cannot correctly merge lock files - they're machine-generated
 *    and must be regenerated from the manifest (package.json, etc.)
 * 
 * 2. Code files: Use runner tool (Cursor/Aider/etc), then fallback to direct LLM API
 *    WHY TWO ATTEMPTS: Fixer tools are good at agentic changes but sometimes
 *    miss conflict markers or make partial fixes. Direct LLM API gives precise
 *    control for targeted resolution of remaining conflicts.
 * 
 * WHY CHECK BOTH GIT STATUS AND FILE CONTENTS: Git might mark a file as resolved
 * (no longer in `status.conflicted`) but the file might still contain conflict
 * markers (<<<<<<<) if the tool staged it without fully resolving. We check both
 * to catch false positives.
 * 
 * @param git - SimpleGit instance
 * @param conflictedFiles - Array of files with conflicts
 * @param mergingBranch - Name of the branch being merged (for prompt context)
 * @param workdir - Working directory path
 * @param config - Configuration object
 * @param llm - LLM client for conflict resolution
 * @param runner - Runner tool for conflict resolution
 * @param getCurrentModel - Function to get the current model name
 * @returns Object with success flag and any remaining conflicts
 */
