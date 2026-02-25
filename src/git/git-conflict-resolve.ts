/**
 * Git conflict resolution using LLM.
 *
 * WHY LLM for conflicts: Merge conflicts are semantic — "ours" vs "theirs" plus
 * context. Heuristics work for lockfiles and package.json; for source code,
 * an LLM can merge intent and produce a coherent resolution. We validate
 * output (JSON validity, size regression) to catch truncation or corruption.
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
import {
  MAX_CONFLICT_RESOLUTION_FILE_SIZE,
  MIN_CONFLICT_RESOLUTION_SIZE_RATIO,
  MIN_LINES_FOR_SIZE_REGRESSION_CHECK,
} from '../constants.js';
import { buildConflictResolutionPrompt } from './git-conflict-prompts.js';
import { handleLockFileConflicts } from './git-conflict-lockfiles.js';
import {
  resolveConflictsChunked,
  tryHeuristicResolution,
  extractConflictSides,
  extractConflictChunks,
  isGeneratedSchemaFile,
  hasAsymmetricConflict,
  resolveAsymmetricConflict,
} from './git-conflict-chunked.js';


/**
 * Validate that resolved content is sane before writing to disk.
 * 
 * WHY: LLMs sometimes catastrophically corrupt files during conflict resolution.
 * Real example: a 23K-line Drizzle migration snapshot was reduced to 250 lines
 * with broken JSON, then committed and pushed. These checks catch such failures.
 * 
 * Checks performed:
 * 1. JSON validation for .json files (catches structural corruption)
 * 2. Size regression detection (catches catastrophic truncation)
 */
function validateResolvedContent(
  filePath: string,
  originalConflictedContent: string,
  resolvedContent: string
): { valid: boolean; reason?: string } {
  // JSON validation: if the file is JSON, ensure the resolution is valid JSON
  if (filePath.endsWith('.json')) {
    try {
      JSON.parse(resolvedContent);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { valid: false, reason: `Invalid JSON after resolution: ${message}` };
    }
  }

  // Size regression: compare resolved content to the larger side of conflicts.
  // The resolved file should not be drastically smaller than the larger conflict side.
  const chunks = extractConflictChunks(originalConflictedContent);
  if (chunks.length > 0) {
    // Find the total size of the larger side across all conflicts
    let totalLargerSideLines = 0;
    for (const chunk of chunks) {
      const { ours, theirs } = extractConflictSides(chunk.conflictLines);
      totalLargerSideLines += Math.max(ours.length, theirs.length);
    }

    // Also count non-conflicted lines (these should be preserved verbatim)
    const originalLines = originalConflictedContent.split('\n');
    const conflictLineSet = new Set<number>();
    for (const chunk of chunks) {
      for (let i = chunk.startLine; i <= chunk.endLine; i++) {
        conflictLineSet.add(i);
      }
    }
    const nonConflictedLineCount = originalLines.length - conflictLineSet.size;
    const expectedMinLines = nonConflictedLineCount + Math.floor(totalLargerSideLines * MIN_CONFLICT_RESOLUTION_SIZE_RATIO);
    const resolvedLineCount = resolvedContent.split('\n').length;

    if (totalLargerSideLines >= MIN_LINES_FOR_SIZE_REGRESSION_CHECK && resolvedLineCount < expectedMinLines) {
      return {
        valid: false,
        reason: `Catastrophic size regression: resolved has ${resolvedLineCount} lines, ` +
          `expected at least ${expectedMinLines} (${nonConflictedLineCount} non-conflicted + ` +
          `${MIN_CONFLICT_RESOLUTION_SIZE_RATIO * 100}% of ${totalLargerSideLines} conflict lines)`
      };
    }
  }

  return { valid: true };
}

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
  
  // Handle delete conflicts (e.g. "deleted by them", "deleted by us")
  // WHY: These have NO conflict markers - one side deleted the file, the other modified it.
  // The standard resolution code only handles files with <<<<<<< markers, so delete
  // conflicts fall through and get reported as unresolvable.
  const deleteConflicts = await detectDeleteConflicts(git, codeFiles, workdir);
  if (deleteConflicts.length > 0) {
    for (const dc of deleteConflicts) {
      await resolveDeleteConflict(git, dc, workdir);
      // Remove from codeFiles so we don't try to resolve again
      const idx = codeFiles.indexOf(dc.file);
      if (idx !== -1) codeFiles.splice(idx, 1);
    }
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
        } else if (
          isGeneratedSchemaFile(conflictFile) &&
          hasAsymmetricConflict(conflictedContent)
        ) {
          // Asymmetric conflict in a generated file: one side is dramatically
          // larger than the other. Use the large side as base, then check the
          // small side for any unique content worth merging.
          // WHY: Standard chunked strategy sends 600KB+ to the LLM and risks
          // catastrophic truncation. This keeps the large side intact and only
          // sends the small side for analysis.
          console.log(chalk.blue(`    → Using asymmetric merge for generated file (${fileSize}KB)`));
          result = await resolveAsymmetricConflict(
            llm,
            conflictFile,
            conflictedContent,
            mergingBranch
          );
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
          // Validate resolved content before writing
          // WHY: Catches corrupted resolutions (invalid JSON, catastrophic truncation)
          // before they get committed and pushed. Better to bail to manual resolution
          // than to push garbage.
          const validation = validateResolvedContent(conflictFile, conflictedContent, result.content);
          if (!validation.valid) {
            debug('Resolution rejected by validation', { file: conflictFile, reason: validation.reason });
            result = {
              resolved: false,
              content: conflictedContent,
              explanation: `Resolution rejected: ${validation.reason}`,
            };
          }
        }
        
        if (result.resolved) {
          // Write the validated resolved content
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
 * Conflict type for delete/modify conflicts
 */
interface DeleteConflict {
  file: string;
  type: 'deleted-by-them' | 'deleted-by-us' | 'both-deleted';
}

/**
 * Detect delete/modify conflicts from git status.
 * 
 * WHY: When one side deletes a file and the other modifies it, git reports a conflict
 * but there are NO conflict markers in the file. These show up as:
 *   - UD (us=modified, them=deleted) → "deleted by them"
 *   - DU (us=deleted, them=modified) → "deleted by us"  
 *   - DD (both deleted) → rare but possible
 * 
 * We detect these by parsing `git status --porcelain` which shows two-char status codes.
 */
async function detectDeleteConflicts(
  git: SimpleGit,
  conflictedFiles: string[],
  workdir: string
): Promise<DeleteConflict[]> {
  const results: DeleteConflict[] = [];
  
  try {
    // git status --porcelain shows XY format where X=index, Y=worktree
    // For conflicts: UU=both modified, UD=deleted by them, DU=deleted by us, DD=both deleted
    const raw = await git.raw(['status', '--porcelain']);
    const lines = raw.split('\n').filter(Boolean);
    
    for (const line of lines) {
      const statusCode = line.substring(0, 2);
      const filePath = line.substring(3).trim();
      // Handle renamed files (format: "R  old -> new")
      const actualPath = filePath.includes(' -> ') ? filePath.split(' -> ')[1] : filePath;
      
      if (!conflictedFiles.includes(actualPath)) continue;
      
      if (statusCode === 'UD') {
        results.push({ file: actualPath, type: 'deleted-by-them' });
      } else if (statusCode === 'DU') {
        results.push({ file: actualPath, type: 'deleted-by-us' });
      } else if (statusCode === 'DD') {
        results.push({ file: actualPath, type: 'both-deleted' });
      }
    }
  } catch (e) {
    debug('Failed to detect delete conflicts', { error: e });
  }
  
  return results;
}

/**
 * Resolve a delete/modify conflict.
 * 
 * Strategy:
 * - "deleted by them" → Accept the deletion. The base/target branch decided the file
 *   should go. Our modifications don't matter if the file shouldn't exist.
 * - "deleted by us" → Accept the deletion. We deleted it intentionally.
 * - "both deleted" → Accept the deletion (both sides agree).
 * 
 * For all cases: `git rm <file>` to accept deletion and mark resolved.
 */
async function resolveDeleteConflict(
  git: SimpleGit,
  conflict: DeleteConflict,
  workdir: string
): Promise<void> {
  const { file, type } = conflict;
  
  try {
    switch (type) {
      case 'deleted-by-them':
        console.log(chalk.cyan(`    - ${file}: deleted by target branch, accepting deletion`));
        break;
      case 'deleted-by-us':
        console.log(chalk.cyan(`    - ${file}: deleted by our branch, accepting deletion`));
        break;
      case 'both-deleted':
        console.log(chalk.cyan(`    - ${file}: deleted by both branches`));
        break;
    }
    
    // Accept the deletion: remove the file and mark conflict as resolved
    await git.rm(file).catch(async () => {
      // git rm may fail if file is already gone from worktree
      // Fall back to staging the deletion manually
      try {
        const { existsSync: fileExists, unlinkSync } = await import('fs');
        const fullPath = join(workdir, file);
        if (fileExists(fullPath)) {
          unlinkSync(fullPath);
        }
        await git.add(file).catch(() => {});
      } catch {
        // Last resort: just mark resolved
        await git.raw(['add', '-u', file]).catch(() => {});
      }
    });
    
    console.log(chalk.green(`    ✓ ${file}: delete conflict resolved`));
  } catch (e) {
    console.log(chalk.red(`    ✗ ${file}: failed to resolve delete conflict: ${e}`));
  }
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
