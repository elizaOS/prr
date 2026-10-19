/**
 * Bail-out when fix loop hits stalemate (no progress cycles).
 * Extracted from resolver-proc.ts (structural refactor).
 */
import chalk from 'chalk';
import type { CLIOptions } from '../cli.js';
import type { ReviewComment } from '../github/types.js';
import { getIssuePrimaryPath, type UnresolvedIssue } from '../analyzer/types.js';
import type { Runner } from '../../../shared/runners/types.js';
import type { LLMClient } from '../llm/client.js';
import type { StateContext } from '../state/state-context.js';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import * as State from '../state/state-core.js';
import * as Performance from '../state/state-performance.js';
import * as Reporter from '../ui/reporter.js';
import * as Bailout from '../state/state-bailout.js';
import * as Verification from '../state/state-verification.js';
import { formatNumber } from '../../../shared/logger.js';
import { addDismissalComments } from './dismissal-comments.js';

/**
 * Execute bail-out procedure when stalemate is detected.
 * Returns updated context with bail-out state.
 */
export async function executeBailOut(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  runners: Runner[],
  options: CLIOptions,
  _getModelsForRunner: (runner: Runner) => string[],
  workdir: string,
  llm: LLMClient
): Promise<{
  bailedOut: boolean;
  exitReason: string;
  exitDetails: string;
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: ReviewComment[];
}> {
  const exitReason = 'bail_out';
  const cyclesCompleted = Bailout.getNoProgressCycles(stateContext);
  const exitDetails = `Stalemate after ${formatNumber(cyclesCompleted)} cycles with no progress - ${formatNumber(unresolvedIssues.length)} issue(s) remain`;

  const toolsExhausted = runners.map(r => r.name);

  const issuesFixed = comments.filter(c =>
    Verification.isVerified(stateContext, c.id)
  ).length;

  const remainingIssues = unresolvedIssues.map(issue => {
    const firstLine = issue.comment.body.split('\n')[0];
    return {
      commentId: issue.comment.id,
      filePath: getIssuePrimaryPath(issue),
      line: issue.comment.line,
      summary: firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine,
    };
  });

  Bailout.recordBailOut(
    stateContext,
    'no-progress-cycles',
    cyclesCompleted,
    remainingIssues,
    issuesFixed,
    toolsExhausted
  );

  await State.saveState(stateContext);

  console.log(chalk.red('\n' + '═'.repeat(60)));
  console.log(chalk.red.bold('  BAIL-OUT: Stalemate Detected'));
  console.log(chalk.red('═'.repeat(60)));

  console.log(chalk.yellow(`\n  Reason: ${formatNumber(cyclesCompleted)} complete cycle(s) with zero verified fixes`));
  console.log(chalk.gray(`  Max allowed: ${formatNumber(options.maxStaleCycles)} (--max-stale-cycles)`));

  console.log(chalk.cyan('\n  Progress Summary:'));
  const fixedThisSession = stateContext.verifiedThisSession?.size ?? 0;
  const sessionNote = fixedThisSession > 0 ? ` (${formatNumber(fixedThisSession)} this session)` : '';
  console.log(chalk.green(`    ✓ Fixed: ${formatNumber(issuesFixed)} issues${sessionNote}`));
  console.log(chalk.red(`    ✗ Remaining: ${formatNumber(unresolvedIssues.length)} issues`));
  const totalLessons = LessonsAPI.Retrieve.getTotalCount(lessonsContext);
  const newLessons = LessonsAPI.Retrieve.getNewLessonsCount(lessonsContext);
  const lessonInfo = newLessons > 0
    ? `${formatNumber(totalLessons)} total (${formatNumber(newLessons)} new this run)`
    : `${formatNumber(totalLessons)} (from previous runs)`;
  console.log(chalk.gray(`    📚 Lessons: ${lessonInfo}`));

  console.log(chalk.cyan('\n  Tools Exhausted:'));
  const perfData = Performance.getModelPerformance(stateContext);
  const toolModelCounts = new Map<string, number>();
  for (const key of Object.keys(perfData)) {
    const tool = key.includes('/') ? key.split('/')[0] : key;
    toolModelCounts.set(tool, (toolModelCounts.get(tool) || 0) + 1);
  }
  for (const tool of toolsExhausted) {
    const actualModels = toolModelCounts.get(tool) || 0;
    if (actualModels > 0) {
      console.log(chalk.gray(`    • ${tool}: ${formatNumber(actualModels)} model${actualModels > 1 ? 's' : ''} tried`));
    } else {
      console.log(chalk.gray(`    • ${tool}: listed but not used`));
    }
  }

  if (unresolvedIssues.length > 0) {
    console.log(chalk.cyan('\n  Remaining Issues (need human attention):'));
    for (const issue of unresolvedIssues.slice(0, 5)) {
      console.log(chalk.yellow(`    • ${getIssuePrimaryPath(issue)}:${issue.comment.line || '?'}`));
      const cleanPreview = Reporter.sanitizeCommentForDisplay(issue.comment.body).split('\n')[0];
      const truncated = cleanPreview.length > 80 ? `${cleanPreview.substring(0, 80)}...` : cleanPreview;
      console.log(chalk.gray(`      "${truncated}"`));
    }
    if (unresolvedIssues.length > 5) {
      console.log(chalk.gray(`    ... and ${formatNumber(unresolvedIssues.length - 5)} more`));
    }
  }

  console.log(chalk.red('\n' + '═'.repeat(60)));
  console.log(chalk.gray('\n  Next steps:'));
  console.log(chalk.gray('    1. Review the lessons learned in .pr-resolver-state.json'));
  console.log(chalk.gray('    2. Check if remaining issues have conflicting requirements'));
  console.log(chalk.gray('    3. Consider increasing --max-stale-cycles if issues seem solvable'));
  console.log(chalk.gray('    4. Manually fix remaining issues or dismiss with comments'));
  console.log('');

  try {
    const remainingForComments = unresolvedIssues.map(issue => ({
      commentId: issue.comment.id,
      reason: `Automated fix attempted ${cyclesCompleted} cycle(s) but could not resolve. Tools tried: ${toolsExhausted.join(', ')}. Resolve by fix, conversation, or other means.`,
      dismissedAt: new Date().toISOString(),
      dismissedAtIteration: 0,
      category: 'remaining' as const,
      filePath: getIssuePrimaryPath(issue),
      line: issue.comment.line,
      commentBody: issue.comment.body,
    }));
    if (remainingForComments.length > 0) {
      console.log(chalk.gray('\n  Adding remaining-issue comments to code...'));
      const { added } = await addDismissalComments(remainingForComments, workdir, llm);
      if (added > 0) {
        console.log(chalk.gray(`    Added ${added} comment${added === 1 ? '' : 's'}`));
      }
    }
  } catch (error) {
    console.log(chalk.gray(`\n  Could not add remaining comments: ${String(error)}`));
  }

  return {
    bailedOut: true,
    exitReason,
    exitDetails,
    finalUnresolvedIssues: [...unresolvedIssues],
    finalComments: [...comments],
  };
}
