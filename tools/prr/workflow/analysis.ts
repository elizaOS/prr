/**
 * Issue analysis workflow functions
 * Handles analyzing review comments, reporting dismissed issues, checking for new comments, and final audit
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { ReviewComment } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { GitHubAPI } from '../github/api.js';
import { type LLMClient, snippetShowsUuidCommentAlignedWithVersionRange } from '../llm/client.js';
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
import { assessSolvability } from './helpers/solvability.js';

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
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>,
  stateContext: StateContext,
  workdir: string
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
    const updatedComments = [...existingComments];
    const updatedUnresolvedIssues = [...unresolvedIssues];

    const solvableComments: ReviewComment[] = [];
    const resolvedPaths = new Map<string, string>();
    for (const comment of newComments) {
      const solvability = assessSolvability(workdir, comment, stateContext);
      if (!solvability.solvable) {
        Dismissed.dismissIssue(
          stateContext,
          comment.id,
          solvability.reason ?? 'Not solvable',
          solvability.dismissCategory ?? 'not-an-issue',
          comment.path,
          comment.line,
          comment.body,
          solvability.remediationHint
        );
        debug('New comment dismissed by solvability', { commentId: comment.id, path: comment.path, reason: solvability.reason });
        continue;
      }
      if (solvability.resolvedPath) {
        resolvedPaths.set(comment.id, solvability.resolvedPath);
      }
      solvableComments.push(comment);
      updatedComments.push(comment);
    }

    if (solvableComments.length === 0) {
      console.log(chalk.gray('  All new comments were dismissed as non-actionable or unsolvable.'));
      return {
        hasNewComments: false,
        updatedComments,
        updatedUnresolvedIssues,
      };
    }

    // Check which new comments need fixing — fetch snippets concurrently
    const newSnippets = await Promise.all(
      solvableComments.map(c => getCodeSnippet(resolvedPaths.get(c.id) ?? c.path, c.line, c.body))
    );
    for (let i = 0; i < solvableComments.length; i++) {
      const comment = solvableComments[i];
        updatedUnresolvedIssues.push({
          comment,
          codeSnippet: newSnippets[i],
          stillExists: true,
          explanation: 'New comment added during fix cycle',
          triage: { importance: 3, ease: 3 },
          resolvedPath: resolvedPaths.get(comment.id),
        });
        // Pill #4: Log warning for late-cycle comments (not just debug)
        console.warn(
          chalk.yellow(
            `  ⚠ Late-cycle comment detected: ${comment.path}:${comment.line || '?'} — added during fix cycle, will be processed in next run`,
          ),
        );
        debug('Late-cycle comment added to queue', {
          commentId: comment.id,
          path: comment.path,
          line: comment.line,
          author: comment.author,
        });
    }
    
    console.log(chalk.yellowBright(`\n┌─ QUEUE: +${formatNumber(solvableComments.length)} new issue(s) added mid-cycle ─┐`));
    for (const comment of solvableComments) {
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
  getFullFile?: (path: string) => Promise<string>,
  /** Pill cycle 2 #4: When set, validate Rule 6 (file deleted) by checking git ls-tree before accepting FIXED verdict. */
  workdir?: string
): Promise<{
  failedAudit: Array<{ comment: ReviewComment; explanation: string }>;
  auditPassed: boolean;
}> {
  // Before declaring victory, run a final audit to catch false positives
  debugStep('FINAL AUDIT');
  setTokenPhase('Final audit');
  
  // Review: Verification cache is intentionally NOT cleared before audit.
  // Pass/fail results are applied per-comment below (markVerified calls).
  // If audit fails for some comments, we unmark those once at the end of this
  // function so the next iteration re-verifies; clearing everything would lose valid verifications.
  debug('Starting final audit (verification cache not cleared - results are additive)');

  // Pill-output #11: runtime overlap check (load() also repairs; this surfaces bugs in-session)
  const verifiedSet = new Set(Verification.getVerifiedComments(stateContext));
  const dismissedIds = Dismissed.getDismissedIssues(stateContext).map((d) => d.commentId);
  const overlapIds = dismissedIds.filter((id) => verifiedSet.has(id));
  if (overlapIds.length > 0) {
    debug('Invariant: comment ID(s) in both verified and dismissed — should be empty after load/markVerified', {
      count: overlapIds.length,
      sample: overlapIds.slice(0, 8),
    });
    console.warn(
      chalk.yellow(
        `  ⚠ ${formatNumber(overlapIds.length)} comment ID(s) appear in both verified and dismissed — state may be inconsistent; see debug log`,
      ),
    );
  }

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
  
  const auditResults = await llm.finalAudit(allIssuesForAudit, options.maxContextChars, 'final-audit');
  // L1: Respect verified-fixed verdict — don't let final audit override earlier verification (e.g. stronger model).
  const alreadyVerifiedIds = new Set(Verification.getVerifiedComments(stateContext));
  if (!stateContext.auditOverridesThisRun) stateContext.auditOverridesThisRun = [];
  // Find issues that failed the audit - mark passing ones as verified
  const failedAudit: Array<{ comment: ReviewComment; explanation: string }> = [];
  let filteredNoAction = 0;
  for (const comment of comments) {
    const result = auditResults.get(comment.id);
    if (result) {
      if (result.stillExists) {
        if (alreadyVerifiedIds.has(comment.id)) {
          // Pill cycle 2 #3: When audit overrides ALREADY_FIXED, require specific code-level contradiction
          // Check if fixer marked this as ALREADY_FIXED multiple times
          const alreadyFixedCount = stateContext.state?.consecutiveAlreadyFixedAnyByCommentId?.[comment.id] ?? 0;
          const codeSnippet = auditSnippets[comments.indexOf(comment)] ?? '';

          // Cycle 64 M2: If inline verify already passed this session and the snippet shows UUID
          // regex + version-range comment alignment, don't let a flaky final audit re-open the issue
          // (defense in depth alongside client-side post-parse demotion).
          if (
            stateContext.verifiedThisSession?.has(comment.id) &&
            snippetShowsUuidCommentAlignedWithVersionRange(codeSnippet)
          ) {
            debug(
              'Final audit tie-break: UUID/comment alignment in snippet + verified this session — keeping verified',
              { commentId: comment.id, path: comment.path },
            );
            console.warn(
              chalk.yellow(
                `  ⚠ Final audit said UNFIXED for ${comment.path}:${comment.line ?? '?'} but code shows UUID/comment alignment — keeping verified (verified this session).`,
              ),
            );
            continue;
          }

          // Require code contradiction: audit must cite specific line numbers + pattern still present
          const hasCodeContradiction = /(?:line|lines)\s+\d+.*(?:still|contains|has)\s+(?:incorrect|wrong|the\s+bug|missing)/i.test(result.explanation);
          const mentionsPattern = /(?:still|contains|has)\s+["']?[a-z0-9-]+["']?/i.test(result.explanation);
          
          if (alreadyFixedCount >= 2 && !hasCodeContradiction && !mentionsPattern) {
            // Fixer said ALREADY_FIXED multiple times, audit says UNFIXED but lacks code evidence — keep ALREADY_FIXED
            debug('Final audit UNFIXED lacks code contradiction for multi-ALREADY_FIXED issue — keeping ALREADY_FIXED', {
              commentId: comment.id,
              path: comment.path,
              alreadyFixedCount,
              auditExplanation: result.explanation?.slice(0, 200),
            });
            console.warn(
              chalk.yellow(
                `  ⚠ Final audit said UNFIXED for ${comment.path}:${comment.line ?? '?'} but lacks code-level contradiction (fixer said ALREADY_FIXED ${alreadyFixedCount}×) — keeping verified.`
              )
            );
            // Don't unmark — keep as verified
            continue;
          }
          
          // Pill #2: safe over sorry — when final audit says UNFIXED, do not trust prior verification; re-queue.
          debug('L1: final audit said UNFIXED for previously verified comment — unmarking and re-queuing (safe over sorry)', {
            commentId: comment.id,
            path: comment.path,
            auditExplanation: result.explanation?.slice(0, 300) ?? '(none)',
          });
          stateContext.auditOverridesThisRun.push({
            commentId: comment.id,
            path: comment.path,
            line: comment.line,
            explanation: result.explanation?.slice(0, 200),
          });
          console.warn(
            chalk.yellow(`  ⚠ Final audit said UNFIXED for ${comment.path}:${comment.line ?? '?'} — re-queuing (was verified earlier; safe over sorry).`)
          );
          failedAudit.push({ comment, explanation: result.explanation ?? 'Audit said UNFIXED' });
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
        // Pill cycle 2 #4: Validate Rule 6 (file deleted) — check git ls-tree before accepting FIXED verdict
        const isRule6Fixed = /(?:file deleted|file no longer exists|thread outdated)/i.test(result.explanation);
        if (isRule6Fixed && workdir && comment.path && comment.path !== '(PR comment)') {
          try {
            const { execFileSync } = await import('child_process');
            const { join } = await import('path');
            // Check if file exists in git tree (not just workdir — file may not be checked out)
            const gitPath = comment.path.replace(/\\/g, '/');
            try {
              execFileSync('git', ['ls-tree', '--name-only', 'HEAD', gitPath], { cwd: workdir, encoding: 'utf8', stdio: 'pipe' });
              // File exists in git — Rule 6 doesn't apply, demote to UNFIXED
              debug('Rule 6 validation failed: file exists in git tree', {
                commentId: comment.id,
                path: comment.path,
                explanation: result.explanation,
              });
              failedAudit.push({
                comment,
                explanation: `File exists in git tree — Rule 6 (file deleted) does not apply. ${result.explanation}`,
              });
              continue;
            } catch {
              // File not in git tree — Rule 6 applies, accept FIXED
              debug('Rule 6 validation passed: file not in git tree', {
                commentId: comment.id,
                path: comment.path,
              });
            }
          } catch {
            // Git check failed — fall through to accept FIXED (conservative)
            debug('Rule 6 validation skipped: git check failed', { commentId: comment.id, path: comment.path });
          }
        }
        Verification.markVerified(stateContext, comment.id);
      }
    } else {
      // No result from audit - treat as needing review (fail-safe)
      failedAudit.push({ comment, explanation: 'Audit did not return a result for this issue' });
    }
  }

  // Single unmark pass for all failed-audit comments (WHY: main-loop-setup used to unmark too → duplicate logs).
  for (const { comment } of failedAudit) {
    Verification.unmarkVerified(stateContext, comment.id);
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
