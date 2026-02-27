/**
 * Fix loop utility functions
 * Handles iteration tracking, issue filtering, new bot reviews, and remote sync
 */

import chalk from 'chalk';
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
import { checkRemoteAhead } from '../git/git-conflicts.js';
import { pullLatest } from '../git/git-pull.js';
import { debug, formatNumber } from '../logger.js';

// Note: All imports must be at module top level - do not use dynamic imports inside functions

/**
 * Process new bot reviews and add them to the workflow
 * 
 * Checks for new reviews from the bot and integrates them into the current
 * fix iteration. New comments are added to tracking sets and turned into
 * unresolved issues for processing.
 * 
 * WHY: Allows working on existing issues while waiting for bot reviews,
 * then seamlessly incorporating new feedback without restarting.
 * 
 * @param github - GitHub API client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param prNumber - Pull request number
 * @param existingCommentIds - Set of already-tracked comment IDs (mutated)
 * @param comments - Array of all comments (mutated)
 * @param unresolvedIssues - Array of unresolved issues (mutated)
 * @param checkForNewBotReviews - Function to check for new reviews
 * @param getCodeSnippet - Function to fetch code snippets
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
  // Check for new bot reviews if expected time has passed
  // WHY: Work on existing issues while waiting for bot reviews, then pull in new ones
  const newReviewResult = await checkForNewBotReviews(owner, repo, prNumber, existingCommentIds);
  if (newReviewResult) {
    console.log(chalk.cyan(`\n📬 ${newReviewResult.message}`));
    
    // Add new comments to tracking — fetch all snippets concurrently
    const newComments = newReviewResult.newComments;
    for (const comment of newComments) {
      existingCommentIds.add(comment.id);
      comments.push(comment);
      console.log(chalk.yellow(`  • ${comment.path}:${comment.line || '?'} (by ${comment.author})`));
    }
    const newSnippets = await Promise.all(
      newComments.map((c: { path: string; line: number | null; body: string }) =>
        getCodeSnippet(c.path, c.line, c.body)
      )
    );
    for (let i = 0; i < newComments.length; i++) {
      unresolvedIssues.push({
        comment: newComments[i],
        codeSnippet: newSnippets[i],
        stillExists: true,
        explanation: 'New comment from bot review',
        triage: { importance: 3, ease: 3 },
      });
    }
    
    console.log(chalk.cyan(`   Added ${formatNumber(newReviewResult.newComments.length)} new issue(s) to workflow\n`));
  }
}

/**
 * Filter out issues that were verified during this session
 * 
 * Removes issues from the unresolvedIssues array that have been marked as
 * verified in the current session (by single-issue mode or direct LLM).
 * 
 * IMPORTANT: Uses verifiedThisSession set instead of isCommentVerifiedFixed
 * to avoid removing stale verifications that findUnresolvedIssues kept for
 * re-checking.
 * 
 * @param unresolvedIssues - Array of unresolved issues (mutated in-place)
 * @param verifiedThisSession - Set of comment IDs verified in this session
 */
export function filterVerifiedIssues(
  unresolvedIssues: UnresolvedIssue[],
  verifiedThisSession: Set<string>
): void {
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
 * 
 * Performs a sanity check when unresolvedIssues is empty: verifies that all
 * comments are actually marked as verified. If there's a mismatch (bug), it
 * re-populates unresolvedIssues from unverified comments.
 * 
 * WHY: Catch bugs in the filtering/verification logic that could cause the
 * loop to exit prematurely while issues remain unfixed.
 * 
 * @param unresolvedIssues - Array of unresolved issues
 * @param comments - All review comments
 * @param stateContext - State context for verification checks
 * @param getCodeSnippet - Function to fetch code snippets
 * @returns Exit signal if all truly resolved, or continue signal if issues remain
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
  // Check for empty issues at start of each iteration
  // WHY: After verification/filtering, unresolvedIssues can be 0
  if (unresolvedIssues.length === 0) {
    // Sanity check: verify that all comments are either verified OR dismissed.
    // WHY both: Dismissed issues (stale, file-unchanged, exhausted) are intentionally
    // NOT marked as verified — they don't need fixing. The old check only looked at
    // isVerified(), treating dismissed-but-not-verified comments as "bugs" and
    // re-adding them as unresolved, causing wasted fix iterations.
    const actuallyVerified = comments.filter(c => 
      Verification.isVerified(stateContext, c.id)
    ).length;
    const actuallyDismissed = comments.filter(c =>
      !Verification.isVerified(stateContext, c.id) && Dismissed.isCommentDismissed(stateContext, c.id)
    ).length;
    const actuallyUnaccounted = comments.length - actuallyVerified - actuallyDismissed;
    
    if (actuallyUnaccounted > 0) {
      // Genuine bug: comments that are neither verified nor dismissed
      console.log(chalk.red(`\n⚠ BUG DETECTED: unresolvedIssues is empty but ${actuallyUnaccounted} comments are neither verified nor dismissed`));
      debug('Mismatch detected', {
        unresolvedIssuesLength: unresolvedIssues.length,
        actuallyVerified,
        actuallyDismissed,
        actuallyUnaccounted,
        totalComments: comments.length,
        verifiedIds: comments.filter(c => Verification.isVerified(stateContext, c.id)).map(c => c.id),
        dismissedIds: comments.filter(c => Dismissed.isCommentDismissed(stateContext, c.id)).map(c => c.id),
      });
      
      // Re-populate unresolvedIssues from scratch — only add comments that are
      // neither verified nor dismissed (truly unaccounted for)
      const unaccounted = comments.filter(
        c => !Verification.isVerified(stateContext, c.id) && !Dismissed.isCommentDismissed(stateContext, c.id)
      );
      const snippets = await Promise.all(
        unaccounted.map(c => getCodeSnippet(c.path, c.line, c.body))
      );
      unresolvedIssues.splice(0, unresolvedIssues.length);
      for (let i = 0; i < unaccounted.length; i++) {
        unresolvedIssues.push({
          comment: unaccounted[i],
          codeSnippet: snippets[i],
          stillExists: true,
          explanation: 'Re-added after bug detection',
          triage: { importance: 3, ease: 3 },
        });
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
      console.log(chalk.yellow(`→ Continuing with ${formatNumber(unresolvedIssues.length)} issues`));
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
 * 
 * Checks if the remote has new commits and pulls them if found. After pulling:
 * - Invalidates all cached verifications (code changed)
 * - Refreshes code snippets for all unresolved issues
 * - Updates PR head SHA
 * 
 * WHY: Detect external pushes early so we don't waste cycles on stale code.
 * Auto-merge if no conflicts; bail out if conflicts detected.
 * 
 * @param git - SimpleGit instance
 * @param branch - Branch name to check
 * @param unresolvedIssues - Array of issues (snippets will be refreshed)
 * @param stateContext - State context
 * @param github - GitHub API client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param prNumber - Pull request number
 * @param getCodeSnippet - Function to fetch code snippets
 * @returns Exit signal if conflicts detected, continue signal with new SHA otherwise
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
  // Check for new commits pushed to the PR (every iteration)
  // WHY: Detect external pushes early so we don't waste cycles on stale code
  let remoteStatus: { behind: number };
  try {
    remoteStatus = await checkRemoteAhead(git, branch);
  } catch (err) {
    debug('Failed to check remote status', { error: err, branch });
    console.log(chalk.yellow('  Could not check remote — continuing with current code'));
    return { shouldBreak: false };
  }
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
      
      // Re-fetch code snippets for unresolved issues concurrently
      // WHY parallel: Each snippet is an independent file read; code at those
      // lines may have changed after the pull.
      console.log(chalk.gray(`  Refreshing code snippets for ${formatNumber(unresolvedIssues.length)} issues...`));
      const refreshedSnippets = await Promise.all(
        unresolvedIssues.map(issue =>
          getCodeSnippet(issue.comment.path, issue.comment.line, issue.comment.body)
        )
      );
      for (let i = 0; i < unresolvedIssues.length; i++) {
        unresolvedIssues[i].codeSnippet = refreshedSnippets[i];
      }
      
      // Update PR info with new head SHA
      try {
        const updatedPR = await github.getPRInfo(owner, repo, prNumber);
        const newHeadSha = updatedPR.headSha;
        debug('Updated PR head SHA', { newSha: newHeadSha });
        
        return {
          shouldBreak: false,
          updatedHeadSha: newHeadSha,
        };
      } catch (err) {
        debug('Failed to fetch updated PR info after pull', { error: err, prNumber });
        console.log(chalk.yellow('  Could not refresh PR head SHA — continuing with current state'));
        return { shouldBreak: false };
      }
    }
  }
  
  return { shouldBreak: false };
}

/** Result of getCodeSnippet when file is missing (issue-analysis and solvability use this). */
const SNIPPET_UNREADABLE = '(file not found or unreadable)';

/**
 * Re-fetch code snippets for issues that have verifierContradiction set.
 * Audit 3.1(a): When the verifier said "still exists", the fixer retry should see the same
 * file state as the verifier; stale snippets cause fixer/verifier disagreement.
 *
 * @param unresolvedIssues - Issues to refresh (mutated in place)
 * @param getCodeSnippet - Fetcher (path, line, body) → snippet
 * @returns Number of issues whose codeSnippet was updated
 */
export async function refreshSnippetsForVerifierContradiction(
  unresolvedIssues: UnresolvedIssue[],
  getCodeSnippet: (path: string, line: number | null, body?: string) => Promise<string>
): Promise<number> {
  const withContradiction = unresolvedIssues.filter((i) => i.verifierContradiction);
  if (withContradiction.length === 0) return 0;
  let refreshed = 0;
  await Promise.all(
    withContradiction.map(async (issue) => {
      const fresh = await getCodeSnippet(
        issue.comment.path,
        issue.comment.line ?? null,
        issue.comment.body
      );
      if (fresh !== SNIPPET_UNREADABLE) {
        issue.codeSnippet = fresh;
        refreshed++;
      }
    })
  );
  return refreshed;
}

/**
 * Re-fetch code snippets for all issues whose file was modified by the fixer.
 *
 * WHY: After the fixer edits a file, the in-memory codeSnippet for other issues
 * in that file is stale. If the fixer partially applied a fix (e.g. fixed one issue
 * but left another), the next iteration's prompt will show old code, causing the
 * fixer to re-apply an already-applied change or miss context that shifted line numbers.
 *
 * @param unresolvedIssues - Issues to potentially refresh (mutated in place)
 * @param changedFiles - Set of file paths modified by the fixer this iteration
 * @param getCodeSnippet - Fetcher (path, line, body) → snippet
 * @returns Number of issues whose codeSnippet was updated
 */
export async function refreshSnippetsForChangedFiles(
  unresolvedIssues: UnresolvedIssue[],
  changedFiles: string[],
  getCodeSnippet: (path: string, line: number | null, body?: string) => Promise<string>
): Promise<number> {
  const changedSet = new Set(changedFiles);
  const toRefresh = unresolvedIssues.filter((i) => changedSet.has(i.comment.path));
  if (toRefresh.length === 0) return 0;
  let refreshed = 0;
  await Promise.all(
    toRefresh.map(async (issue) => {
      const fresh = await getCodeSnippet(
        issue.comment.path,
        issue.comment.line ?? null,
        issue.comment.body
      );
      if (fresh !== SNIPPET_UNREADABLE) {
        issue.codeSnippet = fresh;
        refreshed++;
      }
    })
  );
  return refreshed;
}
