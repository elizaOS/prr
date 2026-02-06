/**
 * Git conflict resolution and cleanup operations.
 * Extracted from PRResolver to reduce file size and improve modularity.
 */
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import type { SimpleGit } from 'simple-git';
import { isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from './clone.js';
import type { LLMClient } from '../llm/client.js';
import type { LessonsManager } from '../state/lessons.js';
import type { Runner } from '../runners/types.js';
import type { Config } from '../config.js';
import { setTokenPhase, debug } from '../logger.js';
import { MAX_CONFLICT_RESOLUTION_FILE_SIZE } from '../constants.js';

/**
 * Build a prompt for resolving merge conflicts
 */
export function buildConflictResolutionPrompt(conflictedFiles: string[], baseBranch: string): string {
  const fileList = conflictedFiles.map(f => `- ${f}`).join('\n');
  
  return `MERGE CONFLICT RESOLUTION

The following files have merge conflicts that need to be resolved:

${fileList}

These conflicts occurred while merging '${baseBranch}' into the current branch.

INSTRUCTIONS:
1. Open each conflicted file
2. Look for conflict markers: <<<<<<<, =======, >>>>>>>
3. For each conflict:
   - Understand what both sides are trying to do
   - Choose the correct resolution that preserves the intent of both changes
   - Remove all conflict markers
4. Ensure the code compiles/runs correctly after resolution
5. Save all files

IMPORTANT:
- Do NOT just pick one side blindly
- Merge the changes intelligently, combining both when possible
- Pay special attention to imports, function signatures, and data structures
- For lock files (bun.lock, package-lock.json, yarn.lock), regenerate them by running the package manager install command
- For configuration files, ensure all necessary entries from both sides are preserved

After resolving, the files should have NO conflict markers remaining.`;
}

/**
 * Handle lock file conflicts by deleting and regenerating them.
 * 
 * WHY DELETE/REGENERATE: Lock files (bun.lock, package-lock.json, yarn.lock, etc.)
 * are auto-generated from manifests (package.json). Attempting to merge them is:
 * 1. Error-prone: LLMs don't understand the lock file format semantics
 * 2. Unnecessary: Fresh generation from manifest is deterministic and correct
 * 3. Safe: The manifest has already been merged, so regeneration gives correct result
 * 
 * WHY WHITELIST COMMANDS: Security. We're executing package managers with user-controlled
 * paths. Only known-safe commands are allowed to prevent arbitrary code execution.
 * 
 * WHY SPAWN WITHOUT SHELL: Prevents shell injection attacks. By using spawn() with
 * an args array instead of shell: true, special characters in paths can't be
 * interpreted as shell commands.
 * 
 * WHY DISABLE SCRIPTS: Package managers can run arbitrary scripts during install
 * (postinstall, preinstall, etc.). These scripts come from dependencies and could
 * be malicious. Disabling them makes lock file regeneration safe.
 * 
 * WHY TIMEOUT: Prevents resource exhaustion. A hung package manager should not
 * block prr indefinitely. 60 seconds is generous for a lock file regeneration.
 */
export async function handleLockFileConflicts(
  git: SimpleGit,
  lockFiles: string[],
  workdir: string,
  config: Config
): Promise<void> {
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
export async function resolveConflictsWithLLM(
  git: SimpleGit,
  conflictedFiles: string[],
  mergingBranch: string,
  workdir: string,
  config: Config,
  llm: LLMClient,
  runner: Runner,
  getCurrentModel: () => string | undefined
): Promise<{ success: boolean; remainingConflicts: string[] }> {
  // Separate lock files from regular files
  const lockFiles = conflictedFiles.filter(f => isLockFile(f));
  const codeFiles = conflictedFiles.filter(f => !isLockFile(f));
  
  console.log(chalk.cyan(`  Conflicted files (${conflictedFiles.length}):`));
  for (const file of conflictedFiles) {
    const isLock = isLockFile(file);
    console.log(chalk.cyan(`    - ${file}${isLock ? chalk.gray(' (lock file - will regenerate)') : ''}`));
  }
  
  // Handle lock files first - delete and regenerate
  if (lockFiles.length > 0) {
    await handleLockFileConflicts(git, lockFiles, workdir, config);
  }
  
  // Handle code files with LLM tools
  if (codeFiles.length > 0) {
    // Build prompt for conflict resolution (only non-lock files)
    const conflictPrompt = buildConflictResolutionPrompt(codeFiles, mergingBranch);
    
    // Run the cursor/opencode tool to resolve conflicts
    console.log(chalk.cyan(`\n  Attempt 1: Using ${runner.name} to resolve conflicts...`));
    const runResult = await runner.run(workdir, conflictPrompt, { model: getCurrentModel() });
    
    if (!runResult.success) {
      console.log(chalk.yellow(`  ${runner.name} failed, will try direct API...`));
    } else {
      // Stage all code files that cursor may have resolved
      console.log(chalk.cyan('  Staging resolved files...'));
      for (const file of codeFiles) {
        try {
          await git.add(file);
        } catch {
          // File might still have conflicts, ignore
        }
      }
    }
  }
  
  // Check if conflicts remain after first attempt
  // Check both git status AND actual file contents for conflict markers
  let statusAfter = await git.status();
  let gitConflicts = statusAfter.conflicted || [];
  let markerConflicts = await findFilesWithConflictMarkers(workdir, codeFiles);
  let remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
  
  if (remainingConflicts.length === 0 && codeFiles.length > 0) {
    console.log(chalk.green(`  ✓ ${runner.name} resolved all conflicts`));
  } else if (markerConflicts.length > 0) {
    console.log(chalk.yellow(`  Files still have conflict markers: ${markerConflicts.join(', ')}`));
  }
  
  // If conflicts remain, try direct LLM API as fallback
  if (remainingConflicts.length > 0) {
    setTokenPhase('Resolve conflicts');
    console.log(chalk.cyan(`\n  Attempt 2: Using direct ${config.llmProvider} API to resolve ${remainingConflicts.length} remaining conflicts...`));
    
    const fs = await import('fs');
    const MAX_FILE_SIZE = MAX_CONFLICT_RESOLUTION_FILE_SIZE;
    
    // Pre-check file sizes to warn about large files
    const largeFiles: string[] = [];
    for (const file of remainingConflicts) {
      if (isLockFile(file)) continue;
      const fullPath = join(workdir, file);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.size > MAX_FILE_SIZE) {
          largeFiles.push(`${file} (${Math.round(stats.size / 1024)}KB)`);
        }
      } catch {
        // Ignore stat errors
      }
    }
    
    if (largeFiles.length > 0) {
      console.log(chalk.yellow('  ⚠ Large files detected (will need manual resolution):'));
      for (const file of largeFiles) {
        console.log(chalk.yellow(`    - ${file}`));
      }
    }
    
    for (const conflictFile of remainingConflicts) {
      // Skip lock files in case they slipped through
      if (isLockFile(conflictFile)) continue;
      
      const fullPath = join(workdir, conflictFile);
      
      try {
        // Read the conflicted file
        const conflictedContent = fs.readFileSync(fullPath, 'utf-8');
        
        // Check if it actually has conflict markers
        if (!conflictedContent.includes('<<<<<<<')) {
          console.log(chalk.gray(`    - ${conflictFile}: no conflict markers found`));
          continue;
        }
        
        console.log(chalk.cyan(`    Resolving: ${conflictFile}`));
        
        // Ask LLM to resolve
        const result = await llm.resolveConflict(
          conflictFile,
          conflictedContent,
          mergingBranch
        );
        
        if (result.resolved) {
          // Write the resolved content
          fs.writeFileSync(fullPath, result.content, 'utf-8');
          console.log(chalk.green(`    ✓ ${conflictFile}: ${result.explanation}`));
          
          // Stage the file
          await git.add(conflictFile);
        } else {
          console.log(chalk.red(`    ✗ ${conflictFile}: ${result.explanation}`));
          
          // Provide helpful manual resolution instructions for large files
          if (result.explanation.includes('too large')) {
            const fileSize = Math.round(conflictedContent.length / 1024);
            console.log(chalk.yellow(`      File is ${fileSize}KB - too large for automatic resolution`));
            console.log(chalk.gray(`      To resolve manually:`));
            console.log(chalk.gray(`        1. Open: ${fullPath}`));
            console.log(chalk.gray(`        2. Search for: <<<<<<<`));
            console.log(chalk.gray(`        3. Merge changes and remove conflict markers`));
            console.log(chalk.gray(`        4. Save and run: git add ${conflictFile}`));
          }
        }
      } catch (e) {
        console.log(chalk.red(`    ✗ ${conflictFile}: Error - ${e}`));
      }
    }
    
    // Check again - both git status and file contents
    statusAfter = await git.status();
    gitConflicts = statusAfter.conflicted || [];
    markerConflicts = await findFilesWithConflictMarkers(workdir, codeFiles);
    remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
  }
  
  return {
    success: remainingConflicts.length === 0,
    remainingConflicts
  };
}

/**
 * Clean up sync target files (CLAUDE.md, CONVENTIONS.md) that were created by prr.
 * 
 * WHY: If these files didn't exist in the original PR, we should remove them after
 * processing to avoid polluting the PR with prr-specific files.
 * 
 * @param git - SimpleGit instance
 * @param workdir - Working directory path
 * @param lessonsManager - Lessons manager to check if files existed before
 */
export async function cleanupCreatedSyncTargets(
  git: SimpleGit,
  workdir: string,
  lessonsManager: LessonsManager | null
): Promise<void> {
  if (!lessonsManager) return;

  // Check if CLAUDE.md was created by us (didn't exist before)
  const claudeMdExisted = lessonsManager.didSyncTargetExist('claude-md');
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
  const conventionsMdExisted = lessonsManager.didSyncTargetExist('conventions-md');
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
