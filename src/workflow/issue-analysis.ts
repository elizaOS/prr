/**
 * Issue analysis and code snippet extraction functions
 */

import type { CLIOptions } from '../cli.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment } from '../github/types.js';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { LLMClient, ModelRecommendationContext } from '../llm/client.js';
import type { Runner } from '../runners/types.js';
import { validateDismissalExplanation } from './utils.js';

/**
 * Get code snippet from file for context
 */
export async function getCodeSnippet(
  workdir: string,
  path: string,
  line: number | null,
  commentBody?: string
): Promise<string> {
  try {
    const { join } = await import('path');
    const { readFile } = await import('fs/promises');
    
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Try to extract line range from comment body (bugbot format)
    let startLine = line;
    let endLine = line;
    
    if (commentBody) {
      const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
      if (locationsMatch) {
        const locationLines = locationsMatch[1].trim().split('\n');
        for (const loc of locationLines) {
          const lineMatch = loc.match(/#L(\d+)(?:-L(\d+))?/);
          if (lineMatch) {
            startLine = parseInt(lineMatch[1], 10);
            endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : startLine + 20;
            break;
          }
        }
      }
    }

    if (startLine === null) {
      // Return first 50 lines if no specific line
      return lines.slice(0, 50).join('\n');
    }

    // Return code from startLine to endLine (with some context)
    const contextBefore = 5;
    const contextAfter = 10;
    const start = Math.max(0, startLine - contextBefore - 1);
    const end = Math.min(lines.length, (endLine || startLine) + contextAfter);
    
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '(file not found or unreadable)';
  }
}

/**
 * Find which review comments still represent unresolved issues
 */
export async function findUnresolvedIssues(
  comments: ReviewComment[],
  totalCount: number,
  stateManager: StateManager,
  lessonsManager: LessonsManager,
  llm: LLMClient,
  runner: Runner,
  options: CLIOptions,
  getCodeSnippetFn: (path: string, line: number | null, commentBody?: string) => Promise<string>,
  getModelsForRunner: (runner: Runner) => string[]
): Promise<{
  unresolved: UnresolvedIssue[];
  recommendedModels?: string[];
  recommendedModelIndex: number;
  modelRecommendationReasoning?: string;
}> {
  const chalk = (await import('chalk')).default;
  const { debug, warn } = await import('../logger.js');
  
  const unresolved: UnresolvedIssue[] = [];
  let alreadyResolved = 0;
  let skippedCache = 0;
  let staleRecheck = 0;

  // Verification expiry: re-check issues verified more than 5 iterations ago
  const VERIFICATION_EXPIRY_ITERATIONS = 5;
  const staleVerifications = stateManager.getStaleVerifications(VERIFICATION_EXPIRY_ITERATIONS);
  
  // First pass: filter out already-verified issues and gather code snippets
  const toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
  }> = [];

  for (const comment of comments) {
    const isStale = staleVerifications.includes(comment.id);
    
    // If --reverify flag is set, ignore the cache and re-check everything
    if (!options.reverify && !isStale && stateManager.isCommentVerifiedFixed(comment.id)) {
      alreadyResolved++;
      continue;
    }
    
    if (options.reverify && stateManager.isCommentVerifiedFixed(comment.id)) {
      skippedCache++;
    }
    
    if (isStale) {
      staleRecheck++;
    }

    const codeSnippet = await getCodeSnippetFn(comment.path, comment.line, comment.body);
    toCheck.push({ comment, codeSnippet });
  }

  if (options.reverify && skippedCache > 0) {
    console.log(chalk.yellow(`  --reverify: Re-checking ${skippedCache} previously cached as "fixed"`));
  } else if (alreadyResolved > 0) {
    console.log(chalk.gray(`  ${alreadyResolved} already verified as fixed (cached)`));
  }
  
  if (staleRecheck > 0) {
    console.log(chalk.yellow(`  ${staleRecheck} stale verifications (>${VERIFICATION_EXPIRY_ITERATIONS} iterations old) - re-checking`));
  }

  if (toCheck.length === 0) {
    return {
      unresolved: [],
      recommendedModelIndex: 0,
    };
  }

  let recommendedModels: string[] | undefined;
  let recommendedModelIndex = 0;
  let modelRecommendationReasoning: string | undefined;

  if (options.noBatch) {
    // Sequential mode - one LLM call per comment
    console.log(chalk.gray(`  Analyzing ${toCheck.length} comments sequentially...`));
    
    for (let i = 0; i < toCheck.length; i++) {
      const { comment, codeSnippet } = toCheck[i];
      console.log(chalk.gray(`    [${i + 1}/${toCheck.length}] ${comment.path}:${comment.line || '?'}`));
      
      const result = await llm.checkIssueExists(
        comment.body,
        comment.path,
        comment.line,
        codeSnippet
      );
      
      if (result.exists) {
        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: result.explanation,
        });
      } else {
        // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
        if (validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
          // Valid explanation - document why it doesn't need fixing
          stateManager.markCommentVerifiedFixed(comment.id);
          stateManager.addDismissedIssue(
            comment.id,
            result.explanation,
            'already-fixed',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          // Invalid/missing explanation - treat as unresolved (potential bug)
          warn(`Cannot dismiss without valid explanation - marking as unresolved`);
          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
          });
        }
      }
    }
  } else {
    // Batch mode - one LLM call for all comments
    console.log(chalk.gray(`  Batch analyzing ${toCheck.length} comments with LLM...`));
    
    const batchInput = toCheck.map((item, index) => {
      const issueId = `issue_${index + 1}`;
      return {
        id: issueId,
        comment: item.comment.body,
        filePath: item.comment.path,
        line: item.comment.line,
        codeSnippet: item.codeSnippet,
      };
    });

    // Build model context for smart model selection (unless --model-rotation is set)
    let modelContext: ModelRecommendationContext | undefined;
    if (!options.modelRotation) {
      const availableModels = getModelsForRunner(runner);
      // Get attempt history for these specific issues
      const commentIds = toCheck.map(item => item.comment.id);
      modelContext = {
        availableModels,
        modelHistory: stateManager.getModelHistorySummary?.() || undefined,
        attemptHistory: stateManager.getAttemptHistoryForIssues(commentIds),
      };
    }

    const batchResult = await llm.batchCheckIssuesExist(
      batchInput, 
      modelContext,
      options.maxContextChars
    );
    const results = batchResult.issues;
    debug('Batch analysis results', { count: results.size });
    
    // Store model recommendation for use in fix loop
    if (batchResult.recommendedModels?.length) {
      recommendedModels = batchResult.recommendedModels;
      recommendedModelIndex = 0;
      modelRecommendationReasoning = batchResult.modelRecommendationReasoning;
      console.log(chalk.cyan(`  📊 Model recommendation: ${recommendedModels.join(', ')}`));
      if (modelRecommendationReasoning) {
        console.log(chalk.gray(`     (${modelRecommendationReasoning})`));
      }
    }

    // Process results
    for (let i = 0; i < toCheck.length; i++) {
      const { comment, codeSnippet } = toCheck[i];
      const issueId = batchInput[i].id.toLowerCase();
      const result = results.get(issueId);

      if (!result) {
        // If LLM didn't return a result for this, assume it still exists
        warn(`No result for comment ${issueId}, assuming unresolved`);
        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: 'Unable to determine status',
        });
        continue;
      }

      if (result.exists) {
        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: result.explanation,
        });
      } else {
        // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
        if (validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
          // Valid explanation - document why it doesn't need fixing
          stateManager.markCommentVerifiedFixed(comment.id);
          stateManager.addDismissedIssue(
            comment.id,
            result.explanation,
            'already-fixed',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          // Invalid/missing explanation - treat as unresolved (potential bug)
          warn(`Cannot dismiss without valid explanation - marking as unresolved`);
          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
          });
        }
      }
    }
  }

  await stateManager.save();
  await lessonsManager.save();
  
  return {
    unresolved,
    recommendedModels,
    recommendedModelIndex,
    modelRecommendationReasoning,
  };
}
