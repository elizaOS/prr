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
import type { ReviewComment } from '../github/types.js';
import { formatLessonForDisplay } from '../state/lessons-normalize.js';
import { buildFixPrompt as buildPrompt, computeEffectiveBatchSize } from '../analyzer/prompt-builder.js';
import { OPENCODE_MAX_ISSUES_PER_PROMPT, MAX_FIX_PROMPT_CHARS, MIN_ISSUES_PER_PROMPT } from '../constants.js';
import { getMaxFixPromptCharsForModel } from '../llm/model-context-limits.js';
import { summarizeBotRiskByFile } from './bot-risk.js';
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
  diffStat?: string,
  /** When provided, used to compute bot risk by file (hot files get a note in the prompt). */
  comments?: ReviewComment[],
  /** When 'opencode', batch size is capped to reduce timeouts on large prompts. */
  runnerName?: string,
  /** When set, use this cap instead of MAX_FIX_PROMPT_CHARS (e.g. per-model for ElizaCloud). */
  maxPromptChars?: number,
  /** Provider + model for per-model cap when maxPromptChars not set (e.g. runner.provider + getCurrentModel()). */
  modelContext?: { provider: 'elizacloud' | 'anthropic' | 'openai'; model: string }
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
  // Build per-file map first so we can prefer file-specific lessons and cap global
  const perFileLessons = new Map<string, string[]>();
  for (const filePath of affectedFiles) {
    const fileLessons = LessonsAPI.Retrieve.getLessonsForFile(lessonsContext, filePath);
    if (fileLessons.length > 0) {
      perFileLessons.set(filePath, fileLessons);
    }
  }
  // Prefer file-specific lessons; cap global to 3 to reduce noise (audit: same 5 global repeated every prompt)
  const globalOnly = LessonsAPI.Retrieve.getLessonsForFiles(lessonsContext, []);
  const fileOnlyList = affectedFiles.flatMap(f => perFileLessons.get(f) ?? []);
  const maxTotalLessons = 15;
  const lessons = [...fileOnlyList, ...globalOnly.slice(-3)].slice(-maxTotalLessons);

  // Adaptive batch sizing: reduce batch when consecutive iterations fail
  let effectiveMax = computeEffectiveBatchSize(consecutiveZeroFixIterations);
  if (runnerName === 'opencode') {
    effectiveMax = Math.min(effectiveMax, OPENCODE_MAX_ISSUES_PER_PROMPT);
    debug('OpenCode batch cap', { effectiveMax, runner: runnerName });
  }
  if (effectiveMax < 50 && consecutiveZeroFixIterations > 0) {
    debug('Adaptive batch sizing', { consecutiveZeroFixIterations, effectiveMax });
  }

  // Sort issues by priority before slicing for the prompt.
  // WHY sort here, not in issue-analysis: the same unresolvedIssues array is shared
  // with single-issue focus mode (which randomizes) and no-changes verification.
  // Sorting at the prompt boundary means we pick the best issues for the batch
  // without affecting other consumers.
  const sortedIssues = sortByPriority(unresolvedIssues, priorityOrder);

  // perFileLessons already built above for lessons ordering; used for inline injection per issue
  const botRiskByFile = comments && comments.length > 0
    ? summarizeBotRiskByFile(comments, affectedFiles)
    : undefined;

  const effectiveCap =
    maxPromptChars ??
    (modelContext ? getMaxFixPromptCharsForModel(modelContext.provider, modelContext.model) : undefined) ??
    MAX_FIX_PROMPT_CHARS;

  // Cap prompt size: reduce batch until under limit so file injection doesn't push total over gateway limit.
  // WHY proportional: Halving (50→25→12→6) wasted iterations when prompt was only slightly over cap.
  // nextMax = floor(currentMax * cap / promptLength) converges in 1–2 steps; we also enforce at least -1 issue.
  let prompt: string;
  let detailedSummary: string;
  let lessonsIncluded: number;
  let currentMax = effectiveMax;
  while (true) {
    const result = buildPrompt(
      sortedIssues,
      lessons,
      { maxIssues: currentMax, perFileLessons, prInfo, diffStat, botRiskByFile }
    );
    if (result.prompt.length <= effectiveCap || currentMax <= MIN_ISSUES_PER_PROMPT) {
      prompt = result.prompt;
      detailedSummary = result.detailedSummary;
      lessonsIncluded = result.lessonsIncluded;
      if (currentMax < effectiveMax) {
        debug('Fix prompt capped by size', { effectiveMax, usedMax: currentMax, promptLength: result.prompt.length, cap: effectiveCap });
      }
      break;
    }
    const nextMax = Math.max(
      MIN_ISSUES_PER_PROMPT,
      Math.floor(currentMax * effectiveCap / result.prompt.length)
    );
    currentMax = Math.max(1, Math.min(nextMax, currentMax - 1)); // ensure we actually reduce but never go below 1
    debug('Fix prompt over cap, reducing batch', { nextMax: currentMax, promptLength: result.prompt.length, cap: effectiveCap });
  }

  console.log(chalk.cyan(`\n${detailedSummary}\n`));
  
  // Show triage breakdown if issues have triage data
  // WHY: Operators need to see if we're tackling critical issues or style nits.
  // Only show when priorityOrder is not 'none' and some issues have triage.
  if (priorityOrder !== 'none') {
    const triaged = sortedIssues.slice(0, currentMax).filter(i => i.triage);
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
