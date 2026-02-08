/**
 * Git conflict resolution using LLM
 */
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import type { SimpleGit } from 'simple-git';
import { isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from './git-clone-index.js';
import type { LLMClient } from '../llm/client.js';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import type { Runner } from '../runners/types.js';
import type { Config } from '../config.js';
import { setTokenPhase, debug } from '../logger.js';
import { MAX_CONFLICT_RESOLUTION_FILE_SIZE } from '../constants.js';
import { buildConflictResolutionPrompt } from './git-conflict-prompts.js';
import { handleLockFileConflicts } from './git-conflict-lockfiles.js';
import { resolveConflictsChunked, tryHeuristicResolution } from './git-conflict-chunked.js';


export async function resolveConflictsWithLLM(
  git: SimpleGit,
  conflictedFiles: string[],
  mergingBranch: string,
  workdir: string,
  config: Config,
  llm: LLMClient,
  runner: Runner | undefined,
  getCurrentModel: () => string | undefined
): Promise<{ success: boolean; remainingConflicts: string[] }> {
  if (!workdir) {
    return { success: false, remainingConflicts: conflictedFiles };
  }
  
  // If runner not available yet (e.g., during setup phase), skip runner-based resolution
  // and go straight to LLM API resolution
  const skipRunnerAttempt = !runner;
  
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
  if (codeFiles.length > 0 && !skipRunnerAttempt) {
    // Build prompt for conflict resolution (only non-lock files)
    const conflictPrompt = buildConflictResolutionPrompt(codeFiles, mergingBranch);
    
    // Run the cursor/opencode tool to resolve conflicts
    console.log(chalk.cyan(`\n  Attempt 1: Using ${runner!.name} to resolve conflicts...`));
    const runResult = await runner!.run(workdir, conflictPrompt, { model: getCurrentModel() });
    
    if (!runResult.success) {
      console.log(chalk.yellow(`  ${runner!.name} failed, will try direct API...`));
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
  } else if (codeFiles.length > 0 && skipRunnerAttempt) {
    console.log(chalk.blue(`\n  Skipping runner attempt (not available yet), using direct LLM API...`));
  }
  
  // Check if conflicts remain after first attempt
  // Check both git status AND actual file contents for conflict markers
  let statusAfter = await git.status();
  let gitConflicts = statusAfter.conflicted || [];
  let markerConflicts = await findFilesWithConflictMarkers(workdir, codeFiles);
  let remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
  
  if (remainingConflicts.length === 0 && codeFiles.length > 0 && runner) {
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
        const fileSize = Math.round(conflictedContent.length / 1024);
        
        // Try heuristic resolution first (fast, no LLM needed)
        let result = tryHeuristicResolution(conflictFile, conflictedContent);
        
        if (result.resolved) {
          console.log(chalk.blue(`    → Using heuristic strategy for ${conflictFile}`));
        } else {
          // Use appropriate strategy based on file size
          if (conflictedContent.length > MAX_FILE_SIZE) {
            console.log(chalk.blue(`    → Using chunked strategy (${fileSize}KB file)`));
            result = await resolveConflictsChunked(
              llm,
              conflictFile,
              conflictedContent,
              mergingBranch
            );
          } else {
            // Standard resolution for small files
            result = await llm.resolveConflict(
              conflictFile,
              conflictedContent,
              mergingBranch
            );
          }
        }
        
        if (result.resolved) {
          // Write the resolved content
          fs.writeFileSync(fullPath, result.content, 'utf-8');
          console.log(chalk.green(`    ✓ ${conflictFile}: ${result.explanation}`));
          
          // Stage the file
          await git.add(conflictFile);
        } else {
          console.log(chalk.red(`    ✗ ${conflictFile}: ${result.explanation}`));
          
          // Provide helpful manual resolution instructions
          console.log(chalk.gray(`      To resolve manually:`));
          console.log(chalk.gray(`        1. Open: ${fullPath}`));
          console.log(chalk.gray(`        2. Search for: <<<<<<<`));
          console.log(chalk.gray(`        3. Merge changes and remove conflict markers`));
          console.log(chalk.gray(`        4. Save and run: git add ${conflictFile}`));
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
 * @param lessonsContext - Lessons manager to check if files existed before
 */
