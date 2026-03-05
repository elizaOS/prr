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
import { existsSync, readFileSync } from 'fs';
import type { SimpleGit } from 'simple-git';
import { isLockFile, getLockFileInfo, findFilesWithConflictMarkers } from '../../../shared/git/git-clone-index.js';
import type { LLMClient } from '../llm/client.js';
import type { LessonsSyncTarget } from '../state/lessons-context.js';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import type { Runner } from '../../../shared/runners/types.js';
import type { Config } from '../../../shared/config.js';
import { setTokenPhase, debug } from '../../../shared/logger.js';
import {
  MAX_CONFLICT_RESOLUTION_FILE_SIZE,
  CONFLICT_USE_CHUNKED_FIRST_CHARS,
  MIN_CONFLICT_RESOLUTION_SIZE_RATIO,
  MIN_LINES_FOR_SIZE_REGRESSION_CHECK,
  DEFAULT_ELIZACLOUD_MODEL,
} from '../../../shared/constants.js';
import { buildConflictResolutionPrompt, buildConflictResolutionPromptWithContent } from './git-conflict-prompts.js';
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
import { getMaxFixPromptCharsForModel } from '../../../shared/llm/model-context-limits.js';

/**
 * Documentation and generated documentation files that should use deterministic
 * conflict resolution (keep ours) instead of LLM resolution.
 * 
 * WHY: These files are frequently modified by both sides (PRR adds changelog
 * entries, remote adds entries). LLM resolution of large markdown files:
 *   1. Often exceeds model context (68KB CHANGELOG → 504 timeout on small models)
 *   2. Hallucinates content when it can't see the full file
 *   3. Is expensive and slow for files that can be resolved deterministically
 * 
 * Strategy: keep "ours" side (HEAD in rebase = the local accumulated work).
 * If the remote added important entries, they'll appear in the base after
 * rebase completes — they're not lost, just not duplicated into ours.
 */
const DETERMINISTIC_MERGE_FILES = new Set([
  'CHANGELOG.md',
  'CHANGES.md',
  'HISTORY.md',
  'RELEASES.md',
]);

const DETERMINISTIC_MERGE_PATTERNS = [
  /^docs\//i,
  /^\.github\//i,
  /^CONTRIBUTING/i,
  /^CODE_OF_CONDUCT/i,
  /^SECURITY/i,
  /^AUTHORS/i,
  /^CREDITS/i,
];

function shouldUseDeterministicMerge(filePath: string): boolean {
  const basename = filePath.split('/').pop() || filePath;
  if (DETERMINISTIC_MERGE_FILES.has(basename)) return true;
  return DETERMINISTIC_MERGE_PATTERNS.some(p => p.test(filePath));
}

/**
 * Resolve a conflict by keeping ours (HEAD) side for all conflict regions.
 * Non-conflicted lines are preserved verbatim.
 */
function resolveKeepOurs(content: string): { resolved: boolean; content: string; explanation: string } {
  const lines = content.split('\n');
  const result: string[] = [];
  let inConflict = false;
  let inTheirs = false;

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inTheirs = false;
      continue;
    }
    if (line.startsWith('=======') && inConflict) {
      inTheirs = true;
      continue;
    }
    if (line.startsWith('>>>>>>>') && inConflict) {
      inConflict = false;
      inTheirs = false;
      continue;
    }
    if (inConflict && inTheirs) continue;
    result.push(line);
  }

  return {
    resolved: true,
    content: result.join('\n'),
    explanation: 'Kept ours (documentation file — deterministic merge)',
  };
}


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
      const resolved = await resolveDeleteConflict(git, dc, workdir);
      if (resolved) {
        // Remove from codeFiles so we don't try to resolve again
        const idx = codeFiles.indexOf(dc.file);
        if (idx !== -1) codeFiles.splice(idx, 1);
      }
    }
  }
  
  // Compute model context limit for conflict resolution prompts.
  // The LLM client uses its default model (e.g., qwen-3-14b on ElizaCloud);
  // we need to respect that model's context window.
  const llmProvider = (llm as any).provider as 'elizacloud' | 'anthropic' | 'openai' | undefined;
  const llmModel = (llm as any).model as string | undefined;
  const modelMaxChars = (llmProvider && llmModel)
    ? getMaxFixPromptCharsForModel(llmProvider, llmModel)
    : MAX_CONFLICT_RESOLUTION_FILE_SIZE;
  
  // Threshold above which batch conflict prompt is likely to timeout (90s is too short for 60KB+).
  const BATCH_CONFLICT_PROMPT_MAX_CHARS = 40_000;

  // Handle code files with LLM tools
  if (codeFiles.length > 0 && runner) {
    const activeRunner = runner;
    const isNonAgentic = activeRunner.name === 'llm-api';
    let skipBatch = false;
    if (isNonAgentic) {
      let estimatedPromptLength = 0;
      for (const file of codeFiles) {
        try {
          const content = readFileSync(join(workdir, file), 'utf-8');
          estimatedPromptLength += content.length + 500;
        } catch {
          estimatedPromptLength += 1000;
        }
      }
      if (estimatedPromptLength > BATCH_CONFLICT_PROMPT_MAX_CHARS) {
        console.log(chalk.cyan(`\n  Batch prompt too large (${Math.round(estimatedPromptLength / 1024)} KB), skipping runner — using per-file resolution.`));
        skipBatch = true;
      }
    }
    if (!skipBatch) {
      const conflictPrompt = isNonAgentic
        ? buildConflictResolutionPromptWithContent(codeFiles, mergingBranch, workdir, modelMaxChars)
        : buildConflictResolutionPrompt(codeFiles, mergingBranch);

      if (isNonAgentic && conflictPrompt.length > BATCH_CONFLICT_PROMPT_MAX_CHARS) {
        console.log(chalk.cyan(`\n  Batch prompt built but too large (${Math.round(conflictPrompt.length / 1024)} KB), skipping runner — using per-file resolution.`));
      } else {
        console.log(chalk.cyan(`\n  Attempt 1: Using ${activeRunner.name} to resolve conflicts...`));
        const runResult = await activeRunner.run(workdir, conflictPrompt, { model: getCurrentModel() });

        if (!runResult.success) {
          console.log(chalk.yellow(`  ${activeRunner.name} failed, will try direct API...`));
        } else {
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
    const activeRunner = runner;
    console.log(chalk.green(`  ✓ ${activeRunner.name} resolved all conflicts`));
  } else if (markerConflicts.length > 0) {
    console.log(chalk.yellow(`  Files still have conflict markers: ${markerConflicts.join(', ')}`));
  }
  
  // If conflicts remain, try direct LLM API as fallback.
  // WHY conflictModel: Use same model as attempt 1 (e.g. claude-sonnet-4-5) instead of the
  // LLM client default (e.g. qwen-3-14b) which may be overloaded and 504'ing.
  if (remainingConflicts.length > 0) {
    setTokenPhase('Resolve conflicts');
    // WHY fallback chain: getCurrentModel() can return undefined during setup phase
    // (rotation state not fully initialized). Without a fallback the LLM client uses
    // its default (qwen-3-14b on ElizaCloud) which is weaker and more prone to 504s.
    // DEFAULT_ELIZACLOUD_MODEL (claude-sonnet-4-5) matches what the runner used in Attempt 1.
    const rotationModel = getCurrentModel() ?? undefined;
    const conflictModel = rotationModel
      ?? (llmProvider === 'elizacloud' ? DEFAULT_ELIZACLOUD_MODEL : undefined);
    const effectiveModel = conflictModel ?? llmModel;
    const effectiveMaxChars = (llmProvider && effectiveModel)
      ? getMaxFixPromptCharsForModel(llmProvider, effectiveModel)
      : modelMaxChars;
    debug('Attempt 2 model selection', { rotationModel, conflictModel, effectiveModel, llmClientDefault: llmModel });
    console.log(chalk.cyan(`\n  Attempt 2: Using direct ${config.llmProvider} API${conflictModel ? ` (${conflictModel})` : ''} to resolve ${remainingConflicts.length} remaining conflicts...`));
    
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
    
    const CONFLICT_HEARTBEAT_INTERVAL_MS = 30_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    const startHeartbeat = (): void => {
      stopHeartbeat();
      const start = Date.now();
      heartbeatTimer = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        console.log(chalk.gray(`  Still resolving... (${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s)`));
      }, CONFLICT_HEARTBEAT_INTERVAL_MS);
    };

    function is504OrTimeout(e: unknown): boolean {
      const msg = e instanceof Error ? e.message : String(e);
      return /504|timeout|gateway|deployment.*error|error occurred with your deployment/i.test(msg);
    }

    for (const conflictFile of remainingConflicts) {
      // Skip lock files in case they slipped through
      if (isLockFile(conflictFile)) continue;

      const fullPath = join(workdir, conflictFile);

      try {
        const conflictedContent = fs.readFileSync(fullPath, 'utf-8');

        if (!conflictedContent.includes('<<<<<<<')) {
          console.log(chalk.gray(`    - ${conflictFile}: no conflict markers found`));
          continue;
        }

        console.log(chalk.cyan(`    Resolving: ${conflictFile}`));
        const fileSize = Math.round(conflictedContent.length / 1024);

        let result = tryHeuristicResolution(conflictFile, conflictedContent);

        if (result.resolved) {
          console.log(chalk.blue(`    → Using heuristic strategy for ${conflictFile}`));
        } else if (shouldUseDeterministicMerge(conflictFile)) {
          console.log(chalk.blue(`    → Using deterministic merge (keep ours) for ${conflictFile}`));
          result = resolveKeepOurs(conflictedContent);
        } else if (conflictedContent.length > effectiveMaxChars) {
          console.log(chalk.yellow(`    → Skipping LLM resolution: file (${fileSize}KB) exceeds model context (${Math.round(effectiveMaxChars / 1024)}KB chars for ${effectiveModel || 'unknown'})`));
          result = {
            resolved: false,
            content: conflictedContent,
            explanation: `File too large for model context (${fileSize}KB > ${Math.round(effectiveMaxChars / 1024)}KB)`,
          };
        } else if (
          isGeneratedSchemaFile(conflictFile) &&
          hasAsymmetricConflict(conflictedContent)
        ) {
          console.log(chalk.blue(`    → Using asymmetric merge for generated file (${fileSize}KB)`));
          startHeartbeat();
          try {
            result = await resolveAsymmetricConflict(
              llm,
              conflictFile,
              conflictedContent,
              mergingBranch,
              conflictModel
            );
          } finally {
            stopHeartbeat();
          }
        } else if (conflictedContent.length > CONFLICT_USE_CHUNKED_FIRST_CHARS) {
          console.log(chalk.blue(`    → Using chunked strategy (${fileSize}KB file)`));
          startHeartbeat();
          try {
            result = await resolveConflictsChunked(
              llm,
              conflictFile,
              conflictedContent,
              mergingBranch,
              conflictModel
            );
          } finally {
            stopHeartbeat();
          }
        } else {
          startHeartbeat();
          try {
            result = await llm.resolveConflict(
              conflictFile,
              conflictedContent,
              mergingBranch,
              conflictModel ? { model: conflictModel } : undefined
            );
          } catch (e) {
            if (is504OrTimeout(e)) {
              console.log(chalk.blue(`    → Retrying with chunked strategy after 504/timeout`));
              result = await resolveConflictsChunked(
                llm,
                conflictFile,
                conflictedContent,
                mergingBranch,
                conflictModel
              );
            } else {
              const msg = e instanceof Error ? e.message : String(e);
              result = { resolved: false, content: conflictedContent, explanation: msg };
            }
          } finally {
            stopHeartbeat();
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
      } finally {
        stopHeartbeat();
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
    // Use NUL-delimited porcelain to safely handle spaces/quotes
    const raw = await git.raw(['status', '--porcelain=v1', '-z']);
    const entries = raw.split('\0').filter(Boolean);
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      // Entry format: XY file
      const statusCode = entry.slice(0, 2);
      let actualPath = entry.slice(3);
      if ((statusCode[0] === 'R' || statusCode[0] === 'C') && i + 1 < entries.length) {
        actualPath = entries[++i];
      }
    
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
 * 
 * Trade-off (deleted-by-them): We always accept their deletion. This can discard
 * local changes and may lose important work. This is a deliberate automated-policy
 * choice. Alternatives: make it configurable, create a backup before removal, or
 * surface a warning. We log a warning at runtime so users are informed.
 */
async function resolveDeleteConflict(
  git: SimpleGit,
  conflict: DeleteConflict,
  workdir: string
): Promise<boolean> {
  const { file, type } = conflict;
  
  try {
    switch (type) {
      case 'deleted-by-them':
        console.log(chalk.yellow(`    ⚠ ${file}: deleted by target branch — accepting deletion (local changes may be lost)`));
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
    return true;
  } catch (e) {
    console.log(chalk.red(`    ✗ ${file}: failed to resolve delete conflict: ${e}`));
    return false;
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
 * // Review: cleans up generated files only if they were not part of the original PR submission
 * @param lessonsContext - Lessons manager to check if files existed before
 */
export async function cleanupSyncTargetFiles(
  git: SimpleGit,
  workdir: string,
  lessonsContext: LessonsContext
): Promise<void> {
  const targets = ['CLAUDE.md', 'CONVENTIONS.md'];
  const targetMap: Record<string, LessonsSyncTarget> = {
    'CLAUDE.md': 'claude-md',
    'CONVENTIONS.md': 'conventions-md',
  };
  for (const file of targets) {
    try {
      const target = targetMap[file];
      const existedBefore = target ? (lessonsContext.originalSyncTargetState.get(target) ?? false) : false;
      if (existedBefore) continue;
      const fullPath = join(workdir, file);
      if (!existsSync(fullPath)) continue;
      const fs = await import('fs');
      fs.unlinkSync(fullPath);
      // Only log removal when rm or add actually succeeded. WHY: avoid claiming success when both failed.
      let removed = false;
      try {
        await git.rm(file);
        removed = true;
      } catch {
        try {
          await git.add(file);
          removed = true;
        } catch {
          // Both failed; suppress success log and let outer catch handle
        }
      }
      if (removed) {
        console.log(chalk.gray(`  Removed sync target created by prr: ${file}`));
      }
    } catch (e) {
      debug('Failed to clean up sync target', { file, error: e });
    }
  }
}
