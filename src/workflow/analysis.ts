/**
 * Issue analysis workflow functions
 * Handles analyzing review comments, reporting dismissed issues, checking for new comments, and final audit
 */

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

/**
 * Analyze issues and report dismissed issues
 */
export function analyzeAndReportIssues(
  comments: ReviewComment[],
  unresolvedIssues: UnresolvedIssue[],
  stateContext: StateContext,
  analyzeTime: number
): void {
  const chalk = require('chalk');
  const { formatNumber } = require('../ui/reporter.js');
  const { debug } = require('../logger.js');
  
  const resolvedCount = comments.length - unresolvedIssues.length;
  console.log(chalk.green(`✓ ${formatNumber(resolvedCount)}/${formatNumber(comments.length)} already resolved (${formatDuration(analyzeTime)})`));
  if (unresolvedIssues.length > 0) {
    console.log(chalk.yellow(`→ ${formatNumber(unresolvedIssues.length)} issues remaining to fix`));
  }

  // Report dismissed issues (issues that don't need fixing)
  const dismissedIssues = Dismissed.getDismissedIssues(stateContext);
  if (dismissedIssues.length > 0) {
    const byCategory = dismissedIssues.reduce((acc, issue) => {
      acc[issue.category] = (acc[issue.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log(chalk.gray(`\n  Issues dismissed (no fix needed): ${formatNumber(dismissedIssues.length)} total`));
    for (const [category, count] of Object.entries(byCategory)) {
      console.log(chalk.gray(`    • ${category}: ${formatNumber(count)}`));
    }

    // Show details for a few dismissed issues
    if (dismissedIssues.length <= 3) {
      console.log(chalk.gray('\n  Dismissal reasons:'));
      for (const issue of dismissedIssues) {
        console.log(chalk.gray(`    • ${issue.filePath}:${issue.line || '?'} [${issue.category}]`));
        console.log(chalk.gray(`      ${issue.reason}`));
      }
    }
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
  const chalk = require('chalk');
  const { debugStep } = require('../logger.js');
  const { formatNumber } = require('../ui/reporter.js');
  
  // Before declaring victory, check for new comments added while we were fixing
  // WHY: Humans or bots may add new review comments during our fix cycle
  debugStep('CHECK FOR NEW COMMENTS');
  spinner.start('Checking for new review comments...');
  
  const freshComments = await github.getReviewComments(owner, repo, prNumber);
  const existingIds = new Set(existingComments.map(c => c.id));
  const newComments = freshComments.filter(c => !existingIds.has(c.id));
  
  if (newComments.length > 0) {
    spinner.warn(`Found ${formatNumber(newComments.length)} new comment(s) added during fix cycle`);
    console.log(chalk.yellow('\n⚠ New review comments found:'));
    for (const comment of newComments) {
      console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'} (by ${comment.author})`));
      console.log(chalk.gray(`    "${comment.body.split('\n')[0].substring(0, 60)}..."`));
    }
    
    // Add new comments to our list
    const updatedComments = [...existingComments, ...newComments];
    
    // Check which new comments need fixing
    const updatedUnresolvedIssues = [...unresolvedIssues];
    for (const comment of newComments) {
      const codeSnippet = await getCodeSnippet(comment.path, comment.line, comment.body);
      updatedUnresolvedIssues.push({
        comment,
        codeSnippet,
        stillExists: true,
        explanation: 'New comment added during fix cycle',
      });
    }
    
    console.log(chalk.cyan(`\n→ Re-entering fix loop with ${formatNumber(updatedUnresolvedIssues.length)} new issues\n`));
    
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
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>
): Promise<{
  failedAudit: Array<{ comment: ReviewComment; explanation: string }>;
  auditPassed: boolean;
}> {
  const chalk = require('chalk');
  const { debugStep, debug } = require('../logger.js');
  const { setTokenPhase } = require('../logger.js');
  const { formatNumber } = require('../ui/reporter.js');
  
  // Before declaring victory, run a final audit to catch false positives
  debugStep('FINAL AUDIT');
  setTokenPhase('Final audit');
  
  // Clear verification cache so audit results are authoritative
  // This prevents stale "verified fixed" entries from persisting
  ;
  debug('Cleared verification cache before final audit');
  
  spinner.start('Running final audit on all issues...');
  
  // Gather all comments with their current code
  const allIssuesForAudit: Array<{
    id: string;
    comment: string;
    filePath: string;
    line: number | null;
    codeSnippet: string;
  }> = [];
  
  for (const comment of comments) {
    const codeSnippet = await getCodeSnippet(comment.path, comment.line, comment.body);
    allIssuesForAudit.push({
      id: comment.id,
      comment: comment.body,
      filePath: comment.path,
      line: comment.line,
      codeSnippet,
    });
  }
  
  const auditResults = await llm.finalAudit(allIssuesForAudit, options.maxContextChars);
  
  // Find issues that failed the audit - mark passing ones as verified
  const failedAudit: Array<{ comment: ReviewComment; explanation: string }> = [];
  for (const comment of comments) {
    const result = auditResults.get(comment.id);
    if (result) {
      if (result.stillExists) {
        failedAudit.push({ comment, explanation: result.explanation });
      } else {
        // Audit confirmed this is fixed - add to cache
        Verification.markVerified(stateContext, comment.id);
      }
    } else {
      // No result from audit - treat as needing review (fail-safe)
      failedAudit.push({ comment, explanation: 'Audit did not return a result for this issue' });
    }
  }
  
  if (failedAudit.length > 0) {
    spinner.fail(`Final audit found ${formatNumber(failedAudit.length)} issue(s) not properly fixed`);
    console.log(chalk.yellow('\n⚠ Issues that need more work:'));
    for (const { comment, explanation } of failedAudit) {
      console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'}`));
      console.log(chalk.gray(`    ${explanation}`));
    }
    await State.saveState(stateContext);
    
    return { 
      failedAudit,
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

      const byCategory = dismissedIssues.reduce((acc, issue) => {
        if (!acc[issue.category]) {
          acc[issue.category] = [];
        }
        acc[issue.category].push(issue);
        return acc;
      }, {} as Record<string, typeof dismissedIssues>);

      for (const [category, issues] of Object.entries(byCategory)) {
        console.log(chalk.cyan(`  ${category.toUpperCase()} (${formatNumber(issues.length)})`));
        for (const issue of issues) {
          console.log(chalk.gray(`    • ${issue.filePath}:${issue.line || '?'}`));
          console.log(chalk.gray(`      Reason: ${issue.reason}`));
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
  const { formatDuration: format } = require('../ui/reporter.js');
  return format(ms);
}
