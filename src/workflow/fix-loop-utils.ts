/**
 * Fix loop utility functions
 * Handles iteration tracking, issue filtering, new bot reviews, and remote sync
 */

import type { ReviewComment } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { SimpleGit } from 'simple-git';
import type { PRInfo } from '../github/types.js';

/**
 * Process new bot reviews and add them to the workflow
 */
export async function processNewBotReviews(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  existingCommentIds: Set<string>,
  comments: ReviewComment[],
  unresolvedIssues: UnresolvedIssue[],
  checkForNewBotReviews: (owner: string, repo: string, prNumber: number, existingIds: Set<string>) => Promise<any>,
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>
): Promise<void> {
  const chalk = (await import('chalk')).default;
  
  // Check for new bot reviews if expected time has passed
  // WHY: Work on existing issues while waiting for bot reviews, then pull in new ones
  const newReviewResult = await checkForNewBotReviews(owner, repo, prNumber, existingCommentIds);
  if (newReviewResult) {
    console.log(chalk.cyan(`\n📬 ${newReviewResult.message}`));
    
    // Add new comments to tracking
    for (const comment of newReviewResult.newComments) {
      existingCommentIds.add(comment.id);
      comments.push(comment);
      
      console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'} (by ${comment.author})`));
      
      // Analyze if this new comment needs fixing
      const codeSnippet = await getCodeSnippet(comment.path, comment.line, comment.body);
      // Quick check - assume new comments need attention unless obviously resolved
      unresolvedIssues.push({
        comment,
        codeSnippet,
        stillExists: true,
        explanation: 'New comment from bot review',
      });
    }
    
    console.log(chalk.cyan(`   Added ${newReviewResult.newComments.length} new issue(s) to workflow\n`));
  }
}

/**
 * Filter out issues that were verified during this session
 */
export function filterVerifiedIssues(
  unresolvedIssues: UnresolvedIssue[],
  verifiedThisSession: Set<string>
): void {
  const { debug } = await import('../logger.js');
  
  // Filter out issues that were verified during THIS session (by single-issue mode, etc.)
  // WHY: trySingleIssueFix marks items as verified but 'continue' skips normal filtering
  // IMPORTANT: Don't use isCommentVerifiedFixed here - it would remove stale items
  // that findUnresolvedIssues intentionally kept for re-checking
  if (verifiedThisSession.size > 0) {
    const beforeCount = unresolvedIssues.length;
    const toRemove = unresolvedIssues.filter(i => verifiedThisSession.has(i.comment.id));
    if (toRemove.length > 0) {
      debug('Filtering issues verified this session', {
        before: beforeCount,
        removing: toRemove.map(i => i.comment.id),
      });
      unresolvedIssues.splice(
        0,
        unresolvedIssues.length,
        ...unresolvedIssues.filter(i => !verifiedThisSession.has(i.comment.id))
      );
      debug('After filtering', { remaining: unresolvedIssues.length });
    }
  }
}

/**
 * Check for empty issues and detect potential bugs
 * Returns exit info if all issues are resolved
 */
export async function checkEmptyIssues(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  stateContext: StateContext,
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  const chalk = (await import('chalk')).default;
  const { debug } = await import('../logger.js');
  
  // Check for empty issues at start of each iteration
  // WHY: After verification/filtering, unresolvedIssues can be 0
  if (unresolvedIssues.length === 0) {
    // Sanity check: verify that all comments are actually marked as verified
    const actuallyVerified = comments.filter(c => 
      Verification.isVerified(stateContext, c.id)
    ).length;
    const actuallyUnverified = comments.length - actuallyVerified;
    
    if (actuallyUnverified > 0) {
      // BUG: We think we're done but there are unverified comments!
      console.log(chalk.red(`\n⚠ BUG DETECTED: unresolvedIssues is empty but ${actuallyUnverified} comments are not verified`));
      debug('Mismatch detected', {
        unresolvedIssuesLength: unresolvedIssues.length,
        actuallyVerified,
        actuallyUnverified,
        totalComments: comments.length,
        verifiedIds: comments.filter(c => Verification.isVerified(stateContext, c.id)).map(c => c.id),
      });
      
      // Re-populate unresolvedIssues from scratch
      unresolvedIssues.splice(0, unresolvedIssues.length);
      for (const comment of comments) {
        if (!Verification.isVerified(stateContext, comment.id)) {
          const codeSnippet = await getCodeSnippet(comment.path, comment.line, comment.body);
          unresolvedIssues.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'Re-added after bug detection',
          });
        }
      }
      debug('Re-populated unresolvedIssues', { count: unresolvedIssues.length });
      
      if (unresolvedIssues.length === 0) {
        // Now it's actually empty (all verified)
        debug('All comments now verified - breaking');
        console.log(chalk.green('\n✓ All issues resolved'));
        return {
          shouldBreak: true,
          exitReason: 'all_fixed',
          exitDetails: 'All issues fixed and verified',
        };
      }
      // Continue with the re-populated list
      console.log(chalk.yellow(`→ Continuing with ${unresolvedIssues.length} issues`));
    } else {
      debug('No issues to fix at start of iteration - breaking');
      console.log(chalk.green('\n✓ All issues resolved'));
      return {
        shouldBreak: true,
        exitReason: 'all_fixed',
        exitDetails: 'All issues fixed and verified',
      };
    }
  }
  
  return { shouldBreak: false };
}

/**
 * Check and pull new remote commits
 * Returns whether to continue or break
 */
export async function checkAndPullRemoteCommits(
  git: SimpleGit,
  branch: string,
  unresolvedIssues: UnresolvedIssue[],
  stateContext: StateContext,
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  getCodeSnippet: (path: string, line: number | null, body: string) => Promise<string>
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
  updatedHeadSha?: string;
}> {
  import chalk from 'chalk';
import { debug } from '../logger.js';
import { checkRemoteAhead } from '../git/git-conflicts.js';
import { pullLatest } from '../git/git-pull.js';
  
  // Check for new commits pushed to the PR (every iteration)
  // WHY: Detect external pushes early so we don't waste cycles on stale code
  const remoteStatus = await checkRemoteAhead(git, branch);
  if (remoteStatus.behind > 0) {
    console.log(chalk.yellow(`\n⚠ Remote has ${remoteStatus.behind} new commit(s) - pulling...`));
    
    const pullResult = await pullLatest(git, branch);
    if (!pullResult.success) {
      console.log(chalk.red(`  Failed to pull: ${pullResult.error}`));
      if (pullResult.error?.includes('conflict')) {
        // Conflicts need manual resolution - bail out
        console.log(chalk.red('  Conflicts detected. Please resolve manually and restart.'));
        return {
          shouldBreak: true,
          exitReason: 'error',
          exitDetails: 'Pull conflicts require manual resolution',
        };
      }
      // Other pull errors - continue but warn
      console.log(chalk.yellow('  Continuing with potentially stale code...'));
    } else {
      console.log(chalk.green(`  ✓ Pulled ${remoteStatus.behind} commit(s)`));
      
      // Invalidate verification cache - code has changed
      // WHY: Previous "fixed" status may no longer be valid
      const previouslyVerified = Verification.getVerifiedComments(stateContext).length;
      if (previouslyVerified > 0) {
        console.log(chalk.yellow(`  Invalidating ${previouslyVerified} cached verifications (code changed)`));
        Verification.clearAllVerifications(stateContext);
      }
      
      // Re-fetch code snippets for unresolved issues
      // WHY: Code at those lines may have changed
      console.log(chalk.gray(`  Refreshing code snippets for ${unresolvedIssues.length} issues...`));
      for (const issue of unresolvedIssues) {
        issue.codeSnippet = await getCodeSnippet(
          issue.comment.path,
          issue.comment.line,
          issue.comment.body
        );
      }
      
      // Update PR info with new head SHA
      const updatedPR = await github.getPRInfo(owner, repo, prNumber);
      const newHeadSha = updatedPR.headSha;
      debug('Updated PR head SHA', { newSha: newHeadSha });
      
      return {
        shouldBreak: false,
        updatedHeadSha: newHeadSha,
      };
    }
  }
  
  return { shouldBreak: false };
}
