/**
 * Issue analysis workflow functions
 * Handles analyzing review comments, reporting dismissed issues, checking for new comments, and final audit
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { ReviewComment } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { LLMClient } from '../llm/client.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { CLIOptions } from '../cli.js';
import { formatNumber } from '../ui/reporter.js';
import { dedupeNewCommentsByQueue } from './utils.js';
import { debug, debugStep, setTokenPhase, formatDuration as formatDur } from '../../../shared/logger.js';

/**
 * Detect audit explanations that say no fix is needed (false positive).
 *
 * WHY: The audit LLM sometimes returns stillExists: true but the explanation
 * says "no change needed", "correct state", "cautionary not prescriptive", etc.
 * Those issues would re-enter the fix loop and spin forever. Filtering them
 * here (treat as passed, mark verified) avoids churn. See audit-run-2026-02-20.md.
 */
function isAuditNoActionNeeded(explanation: string): boolean {
  const lower = explanation.toLowerCase();
  const patterns = [
    /\bno change (is )?needed\b/,
    /\bcorrect state\b/,
    /\bnot prescriptive\b/,
    /\bcautionary,?\s*(not )?prescriptive\b/,
    /\b(addressed|resolved) by (the )?(comment|documentation|code)\b/,
    /\bno additional fix (is )?needed\b/,
    /\b(this is )?the correct (state|behavior)\b/,
    /\bcorrect for (npm )?consumers\b/,
    // Fix is structurally correct but reviewer wanted docs/comments — not a code bug.
    // Guard: "fix is correct" followed by "but"/"however" means partial fix, so exclude.
    /\bfix (is |was )?(correct|valid|sound|appropriate|acceptable)(?!.*\b(but|however|although)\b)/,
    /\bcode (is |was )?(correct|valid|sound|appropriate|acceptable)(?!.*\b(but|however|although)\b)/,
    /\b(only|just) (missing |lacks? )?(documentation|docs|comments?|explanation)\b/,
    /\b(issue|comment) (is |was )?(informational|advisory|optional|stylistic|subjective)\b/,
    // Underlying concern is separate from this PR's scope
    /\bunderlying (issue|concern|problem) (is )?(separate|different|orthogonal|out of scope)\b/,
    // Audit said "still exists" but only because the reviewer's preference wasn't met, not a bug
    /\b(suggestion|recommendation|preference) (was )?not (followed|adopted|implemented)\b/,
    // Prompts.log audit: when target is (PR comment), audit says "file not found or unreadable" — no code to verify, don't re-enter fix loop.
    /\b(?:file|the file) (is )?still not found( or unreadable)?\b/,
    /\bnot found or unreadable\b/,
  ];
  return patterns.some((p) => p.test(lower));
}

/**
 * Analyze issues and report dismissed issues
 */
export function analyzeAndReportIssues(
  comments: ReviewComment[],
  unresolvedIssues: UnresolvedIssue[],
  stateContext: StateContext,
  analyzeTime: number
): void {
  const resolvedCount = comments.length - unresolvedIssues.length;
  console.log(chalk.green(`✓ ${formatNumber(resolvedCount)}/${formatNumber(comments.length)} already resolved (${formatDuration(analyzeTime)})`));

  // Report dismissed issues (issues that don't need fixing). When analysis was reused (analyzeTime 0), skip full breakdown to avoid noise on push iteration 2+ (prompts.log audit L4).
  const dismissedIssues = Dismissed.getDismissedIssues(stateContext);
  if (dismissedIssues.length > 0) {
    const reusedAnalysis = analyzeTime === 0;
    if (reusedAnalysis) {
      console.log(chalk.gray(`\n  Issues dismissed: ${formatNumber(dismissedIssues.length)} total (cached)`));
    } else {
      // Collapse legacy 'exhausted' into 'remaining' for display (we no longer create exhausted).
      const byCategory = dismissedIssues.reduce((acc, issue) => {
        const key = issue.category === 'exhausted' ? 'remaining' : issue.category;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log(chalk.gray(`\n  Issues dismissed (no fix needed): ${formatNumber(dismissedIssues.length)} total`));
      for (const [category, count] of Object.entries(byCategory)) {
        console.log(chalk.gray(`    • ${category}: ${formatNumber(count)}`));
      }

      if (dismissedIssues.length <= 3) {
        console.log(chalk.gray('\n  Dismissal reasons:'));
        for (const issue of dismissedIssues) {
          console.log(chalk.gray(`    • ${issue.filePath}:${issue.line || '?'} [${issue.category}]`));
          console.log(chalk.gray(`      ${issue.reason ?? 'No reason recorded'}`));
        }
      }
    }
  }

  // Prominent queue summary — these are the issues entering the fix loop.
  // WHY: This is the single most important log line for understanding what
  // the system is about to work on. Without it, you have to piece together
  // the queue from scattered debug lines. Show to-fix vs already-verified so
  // "No issues to fix" / "all already verified" is not contradictory (output.log audit).
  // When all are already verified, show one line only to avoid noisy re-display on push iteration 2+.
  if (unresolvedIssues.length > 0) {
    const toFixCount = unresolvedIssues.filter((i) => !Verification.isVerified(stateContext, i.comment.id)).length;
    const verifiedInQueue = unresolvedIssues.length - toFixCount;
    const queueSubtitle =
      verifiedInQueue > 0
        ? toFixCount === 0
          ? ` (all ${formatNumber(verifiedInQueue)} already verified — will skip fixer)`
          : ` (${formatNumber(toFixCount)} to fix, ${formatNumber(verifiedInQueue)} already verified)`
        : '';
    console.log('');
    console.log(chalk.yellowBright(`┌─ QUEUE: ${formatNumber(unresolvedIssues.length)} issue(s) entering fix loop${queueSubtitle} ─┐`));

    if (toFixCount > 0) {
      // Group by file for readability (skip full box when all verified — output.log audit)
      const byFile = new Map<string, typeof unresolvedIssues>();
      for (const issue of unresolvedIssues) {
        const path = issue.comment.path;
        if (!byFile.has(path)) byFile.set(path, []);
        byFile.get(path)!.push(issue);
      }

      for (const [filePath, issues] of byFile) {
        console.log(chalk.yellowBright(`│  ${filePath}`));
        for (const issue of issues) {
          const line = issue.comment.line ? `:${issue.comment.line}` : '';
          const author = issue.comment.author ? ` (${issue.comment.author})` : '';
          const preview = issue.comment.body.split('\n')[0];
          const truncated = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;
          const triageLabel = issue.triage
            ? ` [I${issue.triage.importance}/D${issue.triage.ease}]`
            : '';
          console.log(chalk.yellowBright(`│    + ${filePath}${line}${triageLabel}${author}`));
          console.log(chalk.gray(`│      "${truncated}"`));
        }
      }
      console.log(chalk.yellowBright(`└${'─'.repeat(42)}┘`));
    } else {
      console.log(chalk.yellowBright(`└${'─'.repeat(42)}┘`));
    }
  } else {
    console.log(chalk.green('\n✓ All issues resolved — nothing to fix'));
  }

  debug('Unresolved issues', unresolvedIssues.map(i => ({
    id: i.comment.id,
    path: i.comment.path,
    line: i.comment.line,
    explanation: i.explanation,
  })));
}

/**
 * Check for new comments added during fix cycle
 * Returns the updated unresolvedIssues array if new comments found
 */
export async function checkForNewComments(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  existingComments: ReviewComment[],
  unresolvedIssues: UnresolvedIssue[],
  spinner: Ora,
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>
): Promise<{
  hasNewComments: boolean;
  updatedComments: ReviewComment[];
  updatedUnresolvedIssues: UnresolvedIssue[];
}> {
  // Before declaring victory, check for new comments added while we were fixing
  // WHY: Humans or bots may add new review comments during our fix cycle
  debugStep('CHECK FOR NEW COMMENTS');
  spinner.start('Checking for new review comments...');
  
  const freshComments = await github.getReviewComments(owner, repo, prNumber);
  const existingIds = new Set(existingComments.map(c => c.id));
  const newCommentsRaw = freshComments.filter(c => !existingIds.has(c.id));
  // M3: Deduplicate against current queue (same path + similar body).
  const newComments = dedupeNewCommentsByQueue(newCommentsRaw, unresolvedIssues);
  if (newComments.length < newCommentsRaw.length) {
    debug('M3: filtered duplicate new comments by queue', { before: newCommentsRaw.length, after: newComments.length });
  }
  if (newComments.length > 0) {
    spinner.warn(`Found ${formatNumber(newComments.length)} new comment(s) added during fix cycle`);
    console.log(chalk.yellow('\n⚠ New review comments found:'));
    for (const comment of newComments) {
      console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'} (by ${comment.author})`));
      const preview = comment.body.split('\n')[0];
      const truncated = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;
      console.log(chalk.gray(`    "${truncated}"`));
    }
    
    // Add new comments to our list
    const updatedComments = [...existingComments, ...newComments];
    
    // Check which new comments need fixing — fetch snippets concurrently
    const updatedUnresolvedIssues = [...unresolvedIssues];
    const newSnippets = await Promise.all(
      newComments.map(c => getCodeSnippet(c.path, c.line, c.body))
    );
    for (let i = 0; i < newComments.length; i++) {
      updatedUnresolvedIssues.push({
        comment: newComments[i],
        codeSnippet: newSnippets[i],
        stillExists: true,
        explanation: 'New comment added during fix cycle',
        triage: { importance: 3, ease: 3 },
      });
    }
    
    console.log(chalk.yellowBright(`\n┌─ QUEUE: +${formatNumber(newComments.length)} new issue(s) added mid-cycle ─┐`));
    for (const comment of newComments) {
      const line = comment.line ? `:${comment.line}` : '';
      console.log(chalk.yellowBright(`│  + ${comment.path}${line} (${comment.author})`));
    }
    console.log(chalk.yellowBright(`│  Total in queue: ${formatNumber(updatedUnresolvedIssues.length)}`));
    console.log(chalk.yellowBright(`└${'─'.repeat(45)}┘\n`));
    
    return {
      hasNewComments: true,
      updatedComments,
      updatedUnresolvedIssues,
    };
  } else {
    spinner.succeed('No new comments');
    return {
      hasNewComments: false,
      updatedComments: existingComments,
      updatedUnresolvedIssues: unresolvedIssues,
    };
  }
}

/**
 * Run final audit on all issues to catch false positives
 * Returns issues that failed the audit
 */
export async function runFinalAudit(
  llm: LLMClient,
  stateContext: StateContext,
  comments: ReviewComment[],
  options: CLIOptions,
  spinner: Ora,
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>,
  /** When set, use full file content instead of snippets so the audit has complete context. */
  getFullFile?: (path: string) => Promise<string>
): Promise<{
  failedAudit: Array<{ comment: ReviewComment; explanation: string }>;
  auditPassed: boolean;
}> {
  // Before declaring victory, run a final audit to catch false positives
  debugStep('FINAL AUDIT');
  setTokenPhase('Final audit');
  
  // Review: Verification cache is intentionally NOT cleared before audit.
  // Pass/fail results are applied per-comment below (markVerified calls).
  // If audit fails for some comments, the caller unmarks those so the next
  // iteration re-verifies; clearing everything would lose valid verifications.
  debug('Starting final audit (verification cache not cleared - results are additive)');
  
  spinner.start('Running final audit on all issues...');
  
  // Gather all comments with their current code. Use full file when provided so the audit
  // sees complete context and avoids false "UNFIXED" due to truncated snippets.
  const auditSnippets = getFullFile
    ? await Promise.all(comments.map(c => getFullFile(c.path)))
    : await Promise.all(comments.map(c => getCodeSnippet(c.path, c.line, c.body)));
  const { sanitizeCommentForPrompt } = await import('../analyzer/prompt-builder.js');
  const allIssuesForAudit = comments.map((comment, i) => ({
    id: comment.id,
    comment: sanitizeCommentForPrompt(comment.body),
    filePath: comment.path,
    line: comment.line,
    codeSnippet: auditSnippets[i],
  }));
  
  const auditResults = await llm.finalAudit(allIssuesForAudit, options.maxContextChars);
  // L1: Respect verified-fixed verdict — don't let final audit override earlier verification (e.g. stronger model).
  const alreadyVerifiedIds = new Set(Verification.getVerifiedComments(stateContext));
  // Find issues that failed the audit - mark passing ones as verified
  const failedAudit: Array<{ comment: ReviewComment; explanation: string }> = [];
  let filteredNoAction = 0;
  for (const comment of comments) {
    const result = auditResults.get(comment.id);
    if (result) {
      if (result.stillExists) {
        if (alreadyVerifiedIds.has(comment.id)) {
          debug('L1: final audit said UNFIXED but comment was already verified — trusting verification', { commentId: comment.id, path: comment.path });
          Verification.markVerified(stateContext, comment.id);
          continue;
        }
        if (isAuditNoActionNeeded(result.explanation)) {
          filteredNoAction++;
          debug('Audit false positive (no action needed) - treating as passed', {
            path: comment.path,
            line: comment.line,
            excerpt: result.explanation.slice(0, 80),
          });
          Verification.markVerified(stateContext, comment.id);
        } else {
          failedAudit.push({ comment, explanation: result.explanation });
        }
      } else {
        // Audit confirmed this is fixed - add to cache
        Verification.markVerified(stateContext, comment.id);
      }
    } else {
      // No result from audit - treat as needing review (fail-safe)
      failedAudit.push({ comment, explanation: 'Audit did not return a result for this issue' });
    }
  }
  if (filteredNoAction > 0) {
    debug('Audit filtered no-action-needed', { count: filteredNoAction });
  }
  
  // Deduplicate by (path, line) so we don't re-enter the fix loop with the same issue twice
  const seenKey = new Set<string>();
  const dedupedFailedAudit = failedAudit.filter(({ comment }) => {
    const key = `${comment.path}:${comment.line ?? '?'}`;
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  });
  if (dedupedFailedAudit.length < failedAudit.length) {
    debug('Final audit deduped failed issues', { before: failedAudit.length, after: dedupedFailedAudit.length });
  }

  if (dedupedFailedAudit.length > 0) {
    spinner.fail(`Final audit found ${formatNumber(dedupedFailedAudit.length)} issue(s) not properly fixed`);
    console.log(chalk.yellow('\n⚠ Issues that need more work:'));
    for (const { comment, explanation } of dedupedFailedAudit) {
      console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'}`));
      console.log(chalk.gray(`    ${explanation}`));
    }
    await State.saveState(stateContext);
    
    return { 
      failedAudit: dedupedFailedAudit,
      auditPassed: false,
    };
  } else {
    // Final audit passed - all issues verified fixed
    spinner.succeed('Final audit passed - all issues verified fixed!');
    console.log(chalk.green('\n✓ All issues have been resolved and verified!'));
    
    // Report summary of dismissed issues
    const dismissedIssues = Dismissed.getDismissedIssues(stateContext);
    if (dismissedIssues.length > 0) {
      console.log(chalk.cyan(`\n📋 Dismissed Issues Summary (${formatNumber(dismissedIssues.length)} total)`));
      console.log(chalk.gray('These issues were determined not to need fixing:\n'));

      // Collapse legacy 'exhausted' into 'remaining' for display.
      const byCategory = dismissedIssues.reduce((acc, issue) => {
        const key = issue.category === 'exhausted' ? 'remaining' : issue.category;
        if (!acc[key]) acc[key] = [];
        acc[key].push(issue);
        return acc;
      }, {} as Record<string, typeof dismissedIssues>);

      for (const [category, issues] of Object.entries(byCategory)) {
        console.log(chalk.cyan(`  ${category.toUpperCase()} (${formatNumber(issues.length)})`));
        for (const issue of issues) {
          console.log(chalk.gray(`    • ${issue.filePath}:${issue.line || '?'}`));
          console.log(chalk.gray(`      Reason: ${issue.reason ?? 'No reason recorded'}`));
          if (issue.commentBody.length <= 80) {
            console.log(chalk.gray(`      Comment: ${issue.commentBody}`));
          } else {
            console.log(chalk.gray(`      Comment: ${issue.commentBody.substring(0, 77)}...`));
          }
        }
        console.log('');
      }

      console.log(chalk.yellow('💡 Tip: These dismissal reasons can help improve issue generation to reduce false positives.'));
    }
    
    return {
      failedAudit: [],
      auditPassed: true,
    };
  }
}

// Helper function for formatting duration
function formatDuration(ms: number): string {
  return formatDur(ms);
}
