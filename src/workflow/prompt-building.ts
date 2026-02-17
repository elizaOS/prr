/**
 * Fix prompt building and lessons display
 * 
 * Handles:
 * 1. Build fix prompt with lessons and PR context
 * 2. Display detailed summary
 * 3. Show lessons in verbose mode (by scope: global, per-file)
 *
 * WHY `prInfo` threads through here: There are three code paths that build
 * prompts — buildFixPrompt (batch), buildSingleIssuePrompt (single-issue),
 * and an inline template in recovery.ts (emergency). The first two receive
 * PR context via this wiring. The recovery path was intentionally left
 * without prInfo because it's a last-resort fallback where minimal prompt
 * size matters more than context.
 */

import chalk from 'chalk';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { PRInfo } from '../github/types.js';
import { formatLessonForDisplay } from '../state/lessons-normalize.js';
import { buildFixPrompt as buildPrompt, computeEffectiveBatchSize } from '../analyzer/prompt-builder.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug } from '../logger.js';
import { sortByPriority, type PriorityOrder } from '../analyzer/severity.js';

/**
 * Build fix prompt with lessons and display summary
 * 
 * WORKFLOW:
 * 1. Get lessons for affected files
 * 2. Build fix prompt using prompt-builder
 * 3. Display detailed summary
 * 4. In verbose mode, show lessons by scope (global + per-file)
 * 5. Debug log prompt stats
 * 
 * @returns Prompt details and guard flag for empty prompts
 */
export function buildAndDisplayFixPrompt(
  unresolvedIssues: UnresolvedIssue[],
  lessonsContext: LessonsContext,
  verbose: boolean,
  consecutiveZeroFixIterations: number = 0,
  priorityOrder: PriorityOrder = 'important',
  prInfo?: PRInfo,
  diffStat?: string
): {
  prompt: string;
  detailedSummary: string;
  lessonsIncluded: number;
  lessonsBeforeFix: number;
  affectedFiles: string[];
  shouldSkip: boolean;
} {
  // Track the session-new count (monotonically increasing) — NOT getTotalCount,
  // which decreases when fix-attempt lessons are cleaned up after verification.
  // Using getTotalCount caused "newLessons: -7" when cleanup removed more than were added.
  const lessonsBeforeFix = LessonsAPI.Retrieve.getNewLessonsCount(lessonsContext);
  
  // Get lessons for all files being fixed
  const affectedFiles = [...new Set(unresolvedIssues.map(i => i.comment.path))];
  const lessons = LessonsAPI.Retrieve.getLessonsForFiles(lessonsContext, affectedFiles);

  // Adaptive batch sizing: reduce batch when consecutive iterations fail
  const effectiveMax = computeEffectiveBatchSize(consecutiveZeroFixIterations);
  if (effectiveMax < 50 && consecutiveZeroFixIterations > 0) {
    debug('Adaptive batch sizing', { consecutiveZeroFixIterations, effectiveMax });
  }

  // Sort issues by priority before slicing for the prompt.
  // WHY sort here, not in issue-analysis: the same unresolvedIssues array is shared
  // with single-issue focus mode (which randomizes) and no-changes verification.
  // Sorting at the prompt boundary means we pick the best issues for the batch
  // without affecting other consumers.
  const sortedIssues = sortByPriority(unresolvedIssues, priorityOrder);

  // Build per-file lesson map for inline injection alongside each issue.
  // HISTORY: The flat `lessons` array was only shown in a top-level section,
  // 2000+ tokens before the issue it applied to. File-specific lessons like
  // "delete lines 429-506" were ignored because the fixer's attention had
  // moved on. Now we also pass them inline, right next to each issue.
  const perFileLessons = new Map<string, string[]>();
  for (const filePath of affectedFiles) {
    const fileLessons = LessonsAPI.Retrieve.getLessonsForFile(lessonsContext, filePath);
    if (fileLessons.length > 0) {
      perFileLessons.set(filePath, fileLessons);
    }
  }

  const { prompt, detailedSummary, lessonsIncluded } = buildPrompt(
    sortedIssues,
    lessons,
    { maxIssues: effectiveMax, perFileLessons, prInfo, diffStat }
  );

  console.log(chalk.cyan(`\n${detailedSummary}\n`));
  
  // Show triage breakdown if issues have triage data
  // WHY: Operators need to see if we're tackling critical issues or style nits.
  // Only show when priorityOrder is not 'none' and some issues have triage.
  if (priorityOrder !== 'none') {
    const triaged = sortedIssues.slice(0, effectiveMax).filter(i => i.triage);
    if (triaged.length > 0) {
      // Count by importance: 1-2=critical/major, 3=moderate, 4-5=minor/trivial
      const critical = triaged.filter(i => i.triage!.importance <= 2).length;
      const moderate = triaged.filter(i => i.triage!.importance === 3).length;
      const minor = triaged.filter(i => i.triage!.importance >= 4).length;
      
      const orderLabel = priorityOrder === 'important' ? 'critical first'
        : priorityOrder === 'important-asc' ? 'trivial first'
        : priorityOrder === 'easy' ? 'easy first'
        : priorityOrder === 'easy-asc' ? 'hard first'
        : priorityOrder === 'newest' ? 'newest first'
        : 'oldest first';
      
      console.log(chalk.gray(`  Priority: ${critical} critical/major, ${moderate} moderate, ${minor} minor/trivial (sorted: ${orderLabel})\n`));
    }
  }
  
  // In verbose mode, show lessons by scope
  if (verbose && lessons.length > 0) {
    const allLessons = LessonsAPI.Retrieve.getAllLessons(lessonsContext);
    const counts = LessonsAPI.Retrieve.getCounts(lessonsContext);
    const newLabel = counts.newThisSession > 0 ? ` (${counts.newThisSession} new this run)` : '';
    console.log(chalk.yellow(`  Lessons from previous attempts${newLabel}:`));
    
    if (allLessons.global.length > 0) {
      console.log(chalk.gray('    Global:'));
      for (const lesson of allLessons.global.slice(-5)) {
        const display = formatLessonForDisplay(lesson);
        console.log(chalk.gray(`      • ${display.substring(0, 100)}...`));
      }
    }
    
    for (const filePath of affectedFiles) {
      const fileLessons = allLessons.files[filePath];
      if (fileLessons && fileLessons.length > 0) {
        console.log(chalk.gray(`    ${filePath}:`));
        for (const lesson of fileLessons.slice(-3)) {
          const display = formatLessonForDisplay(lesson);
          console.log(chalk.gray(`      • ${display.substring(0, 100)}...`));
        }
      }
    }
    console.log('');
  }
  
  debug('Fix prompt length', prompt.length);
  const newLessonsCount = LessonsAPI.Retrieve.getNewLessonsCount(lessonsContext);
  debug('Lessons in prompt', { total: lessonsIncluded, newThisSession: newLessonsCount });

  // Guard: Don't run fixer with empty prompt
  // WHY: Empty prompt = nothing to fix, fixer will fail or do nothing
  const shouldSkip = prompt.length === 0 || unresolvedIssues.length === 0;
  if (shouldSkip) {
    debug('Empty prompt or no issues - skipping fixer');
    console.log(chalk.green('\n✓ Nothing to fix - all issues resolved'));
  }

  return {
    prompt,
    detailedSummary,
    lessonsIncluded,
    lessonsBeforeFix,
    affectedFiles,
    shouldSkip,
  };
}
