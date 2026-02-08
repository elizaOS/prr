/**
 * Fix prompt building and lessons display
 * 
 * Handles:
 * 1. Build fix prompt with lessons
 * 2. Display detailed summary
 * 3. Show lessons in verbose mode (by scope: global, per-file)
 */

import chalk from 'chalk';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { LessonsManager } from '../state/lessons.js';
import { formatLessonForDisplay } from '../state/lessons.js';
import { buildFixPrompt as buildPrompt } from '../analyzer/prompt-builder.js';

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
  lessonsManager: LessonsManager,
  verbose: boolean
): {
  prompt: string;
  detailedSummary: string;
  lessonsIncluded: number;
  lessonsBeforeFix: number;
  affectedFiles: string[];
  shouldSkip: boolean;
} {
  const { debug } = require('../logger.js');
  
  const lessonsBeforeFix = lessonsManager.getTotalCount();
  
  // Get lessons for all files being fixed
  const affectedFiles = [...new Set(unresolvedIssues.map(i => i.comment.path))];
  const lessons = lessonsManager.getLessonsForFiles(affectedFiles);
  const { prompt, detailedSummary, lessonsIncluded } = buildPrompt(
    unresolvedIssues,
    lessons
  );

  console.log(chalk.cyan(`\n${detailedSummary}\n`));
  
  // In verbose mode, show lessons by scope
  if (verbose && lessons.length > 0) {
    const allLessons = lessonsManager.getAllLessons();
    const counts = lessonsManager.getCounts();
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
  const newLessonsCount = lessonsManager.getNewLessonsCount();
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
