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
import { getIssuePrimaryPath, type UnresolvedIssue } from '../analyzer/types.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { StateContext } from '../state/state-context.js';
import { getState } from '../state/state-context.js';
import type { PRInfo } from '../github/types.js';
import type { ReviewComment } from '../github/types.js';
import { formatLessonForDisplay } from '../state/lessons-normalize.js';
import { buildFixPrompt as buildPrompt, computeEffectiveBatchSize } from '../analyzer/prompt-builder.js';
import { OPENCODE_MAX_ISSUES_PER_PROMPT, MAX_FIX_PROMPT_CHARS, FIRST_ATTEMPT_MAX_PROMPT_CHARS, MIN_ISSUES_PER_PROMPT, MAX_ISSUES_PER_FIX_PROMPT } from '../../../shared/constants.js';
import { getMaxFixPromptCharsForModel } from '../llm/model-context-limits.js';
import { summarizeBotRiskByFile } from './bot-risk.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug } from '../../../shared/logger.js';
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
  modelContext?: { provider: 'elizacloud' | 'anthropic' | 'openai'; model: string },
  /** When provided, used to resolve test file paths so TARGET FILE(S) point to the path that exists (e.g. __tests__/integration vs colocated). */
  pathExists?: (path: string) => boolean,
  /** When true, use a conservative cap (80k) to avoid gateway timeout on first attempt (audit: 94k timed out). */
  firstFixAttempt?: boolean,
  /** When provided, last apply error is injected into prompt and cleared for included issues (output.log audit). */
  stateContext?: StateContext,
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
  const affectedFiles = [...new Set(unresolvedIssues.map((i) => getIssuePrimaryPath(i)))];
  // Build per-issue lessons first so unrelated same-file failures do not contaminate other issues.
  const perIssueLessons = new Map<string, string[]>();
  const perFileLessons = new Map<string, string[]>();
  for (const issue of unresolvedIssues) {
    const primaryPath = getIssuePrimaryPath(issue);
    const issueLessons = LessonsAPI.Retrieve.getLessonsForIssue(
      lessonsContext,
      primaryPath,
      issue.comment.body,
      issue.allowedPaths
    );
    if (issueLessons.length > 0) {
      perIssueLessons.set(issue.comment.id, issueLessons);
      if (!perFileLessons.has(primaryPath)) perFileLessons.set(primaryPath, []);
      const merged = [...(perFileLessons.get(primaryPath) ?? []), ...issueLessons];
      perFileLessons.set(primaryPath, [...new Set(merged)]);
    }
  }
  // Prefer file-specific lessons; cap global and filter by path relevance (prompts.log audit: cross-domain lessons bloat prompt).
  const globalOnly = LessonsAPI.Retrieve.getLessonsForFiles(lessonsContext, []);
  // Drop generic retry advice that doesn't help the fixer (prompts.log audit L2: "try another model" etc. add noise).
  const isGenericRetry = (lesson: string): boolean =>
    /\b(?:try\s+another\s+model|try\s+a\s+different\s+model|try\s+another\s+strategy)\b/i.test(lesson) ||
    /\b(?:fixer\s+made\s+no\s+edits\s+and\s+gave\s+no\s+explanation)\b/i.test(lesson);
  const globalFiltered = globalOnly.filter((l) => !isGenericRetry(l));
  const roots = new Set(affectedFiles.map((f) => f.split('/')[0]));
  const pathRelevant = (lesson: string): boolean => {
    const m = /(?:TARGET FILE\(S\)|file\(s\)|edit|in|path|disallowed)\s*[:\s]*([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_/.()-]+)/i.exec(lesson);
    const firstSeg = m ? m[1].split('/')[0] : null;
    if (!firstSeg) return true;
    return roots.has(firstSeg);
  };
  const pathRelevantGlobal = globalFiltered.filter(pathRelevant);
  const fileOnlyListRaw = [...perIssueLessons.values()].flat();
  const fileOnlyList = fileOnlyListRaw.filter(pathRelevant);
  const maxGlobal = unresolvedIssues.length <= 2 ? 1 : 3;
  const maxTotalLessons = 15;
  const lessons = [...fileOnlyList, ...pathRelevantGlobal.slice(-maxGlobal)].slice(-maxTotalLessons);

  // Adaptive batch sizing: reduce batch when consecutive iterations fail
  let effectiveMax = computeEffectiveBatchSize(consecutiveZeroFixIterations);
  if (runnerName === 'opencode') {
    effectiveMax = Math.min(effectiveMax, OPENCODE_MAX_ISSUES_PER_PROMPT);
    debug('OpenCode batch cap', { effectiveMax, runner: runnerName });
  }
  effectiveMax = Math.min(effectiveMax, MAX_ISSUES_PER_FIX_PROMPT);
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

  let effectiveCap =
    maxPromptChars ??
    (modelContext ? getMaxFixPromptCharsForModel(modelContext.provider, modelContext.model) : undefined) ??
    MAX_FIX_PROMPT_CHARS;
  if (firstFixAttempt && effectiveCap > FIRST_ATTEMPT_MAX_PROMPT_CHARS) {
    effectiveCap = FIRST_ATTEMPT_MAX_PROMPT_CHARS;
    debug('First fix attempt: using conservative prompt cap to avoid timeout', { cap: effectiveCap });
  }

  // Cap prompt size: reduce batch until under limit so file injection doesn't push total over gateway limit.
  // WHY proportional: Halving (50→25→12→6) wasted iterations when prompt was only slightly over cap.
  // nextMax = floor(currentMax * cap / promptLength) converges in 1–2 steps; we also enforce at least -1 issue.
  let prompt: string;
  let detailedSummary: string;
  let lessonsIncluded: number;
  let currentMax = effectiveMax;
  const issuesInPrompt = (n: number) => sortedIssues.slice(0, n);
  const getFirstLastApplyError = (issues: UnresolvedIssue[]): string | undefined => {
    if (!stateContext?.state?.lastApplyErrorByCommentId) return undefined;
    const map = stateContext.state.lastApplyErrorByCommentId;
    for (const i of issues) {
      const err = map[i.comment.id];
      if (err) return err;
    }
    return undefined;
  };
  while (true) {
    const batchIssues = issuesInPrompt(currentMax);
    const lastApplyError = stateContext ? getFirstLastApplyError(batchIssues) : undefined;
    const result = buildPrompt(
      sortedIssues,
      lessons,
      { maxIssues: currentMax, perFileLessons, perIssueLessons, prInfo, diffStat, botRiskByFile, pathExists, lastApplyError, consecutiveNoChanges: consecutiveZeroFixIterations }
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

  // Clear last apply errors for issues we included so we don't show stale error next time.
  if (stateContext?.state?.lastApplyErrorByCommentId && currentMax > 0) {
    const includedIds = issuesInPrompt(currentMax).map((i) => i.comment.id);
    for (const id of includedIds) {
      if (stateContext.state.lastApplyErrorByCommentId[id] !== undefined) {
        delete stateContext.state.lastApplyErrorByCommentId[id];
      }
    }
  }

  if (detailedSummary.length > 0 && unresolvedIssues.length > 0) {
    console.log(chalk.cyan(`\n${detailedSummary}\n`));
  }
  
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
  if (prompt.length === 0 && unresolvedIssues.length > 0) {
    debug('Fix prompt empty because all issues in queue are already verified');
  }
  const newLessonsCount = LessonsAPI.Retrieve.getNewLessonsCount(lessonsContext);
  debug('Lessons in prompt', { total: lessonsIncluded, newThisSession: newLessonsCount });

  // Guard: Don't run fixer with empty prompt
  // WHY: Empty prompt = nothing to fix, fixer will fail or do nothing.
  // When unresolvedIssues.length === 0 the caller (execute-fix-iteration) prints the accurate
  // "All N in queue already verified — skipping fixer" so we don't duplicate with a generic line.
  const shouldSkip = prompt.length === 0 || unresolvedIssues.length === 0;
  if (shouldSkip && unresolvedIssues.length > 0) {
    debug('Skipping fixer: all issues in queue already verified (prompt empty)');
    console.log(chalk.green('\n✓ Nothing to fix - all issues resolved'));
  } else if (shouldSkip) {
    debug('Skipping fixer: 0 issues in queue');
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
