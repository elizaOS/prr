/**
 * Procedural implementation of PR resolution logic.
 * Extracted from PRResolver class to reduce file size and improve testability.
 * 
 * This file serves as a facade, re-exporting functions from specialized workflow modules.
 */

import type { CLIOptions } from './cli.js';
import type { ReviewComment, PRInfo, BotResponseTiming, PRStatus } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from './runners/types.js';
import type { GitHubAPI } from './github/api.js';
import type { LLMClient } from './llm/client.js';
import type { StateContext } from './state/state-context.js';
import type { LessonsContext } from './state/lessons-context.js';
import * as LessonsAPI from './state/lessons-index.js';
import * as Reporter from './ui/reporter.js';

// ============================================================================
// RE-EXPORTS FROM WORKFLOW MODULES
// ============================================================================

// Utilities
export {
  type ResolverContext,
  createResolverContext,
  ringBell,
  parseNoChangesExplanation,
  sanitizeOutputForLog,
  validateDismissalExplanation,
  sleep,
  buildSingleIssuePrompt,
  calculateExpectedBotResponseTime,
  shouldCheckForNewComments,
} from './workflow/utils.js';

// Initialization
export {
  ensureStateFileIgnored,
  initializeManagers,
  restoreRunnerState,
} from './workflow/initialization.js';

// Issue analysis
export {
  getCodeSnippet,
  findUnresolvedIssues,
} from './workflow/issue-analysis.js';

// Startup workflows
export {
  displayPRStatus,
  analyzeBotTimingAndDisplay,
  checkCodeRabbitStatus,
  setupWorkdirAndManagers,
} from './workflow/startup.js';

// Repository workflows
export {
  restoreRunnerRotationState,
  cloneOrUpdateRepository,
  recoverVerificationState,
  checkAndSyncWithRemote,
} from './workflow/repository.js';

// Base branch merge workflows
export {
  checkAndMergeBaseBranch,
} from './workflow/base-merge.js';

// No comments workflows
export {
  handleNoComments,
} from './workflow/no-comments.js';

// Analysis workflows
export {
  analyzeAndReportIssues,
  checkForNewComments,
  runFinalAudit,
} from './workflow/analysis.js';

// Commit workflows
export {
  commitAndPushChanges,
} from './workflow/commit.js';

// Fix loop utilities
export {
  processNewBotReviews,
  filterVerifiedIssues,
  checkEmptyIssues,
  checkAndPullRemoteCommits,
} from './workflow/fix-loop-utils.js';

// Fixer error handling
export {
  handleFixerError,
} from './workflow/fixer-errors.js';

// Fix verification
export {
  verifyFixes,
} from './workflow/fix-verification.js';

// Iteration cleanup
export {
  handleIterationCleanup,
} from './workflow/iteration-cleanup.js';

// Recovery helpers
export {
  trySingleIssueFix,
  tryDirectLLMFix,
} from './workflow/helpers/recovery.js';

// Fix loop rotation
export {
  handleRotationStrategy,
} from './workflow/fix-loop-rotation.js';

// No-changes verification
export {
  handleNoChangesWithVerification,
} from './workflow/no-changes-verification.js';

// Run initialization
export {
  initializeRun,
} from './workflow/run-initialization.js';

// Run setup phase
export {
  executeSetupPhase,
} from './workflow/run-setup-phase.js';

// Push iteration loop
export {
  executePushIteration,
} from './workflow/push-iteration-loop.js';

// Graceful shutdown
export {
  executeGracefulShutdown,
} from './workflow/graceful-shutdown.js';

// Run orchestrator
export {
  executeRun,
  type RunState,
  type RunCallbacks,
} from './workflow/run-orchestrator.js';

// Main loop setup
export {
  processCommentsAndPrepareFixLoop,
} from './workflow/main-loop-setup.js';

// Fix loop initialization
export {
  initializeFixLoop,
  type FixLoopState,
} from './workflow/fix-loop-initialization.js';

// Fix iteration pre-checks
export {
  executePreIterationChecks,
} from './workflow/fix-iteration-pre-checks.js';

// Execute fix iteration
export {
  executeFixIteration,
} from './workflow/execute-fix-iteration.js';

// Post-verification handling
export {
  handlePostVerification,
} from './workflow/post-verification-handling.js';

// Prompt building
export {
  buildAndDisplayFixPrompt,
} from './workflow/prompt-building.js';

// Commit and push within fix loop
export {
  handleCommitAndPush,
} from './workflow/commit-and-push-loop.js';

// Final cleanup and reporting
export {
  executeFinalCleanup,
  executeErrorCleanup,
} from './workflow/final-cleanup.js';

// Cleanup mode
export {
  runCleanupMode,
} from './workflow/cleanup-mode.js';

// Import for internal use in remaining functions
import {
  sleep,
  shouldCheckForNewComments,
} from './workflow/utils.js';

// ============================================================================
// CONSTANTS
// ============================================================================

// Constants consolidated to src/constants.ts (canonical source of truth)

// ============================================================================
// REMAINING WORKFLOW FUNCTIONS (not yet modularized)
// ============================================================================

/**
 * Calculate smart wait time based on bot timing data and PR status
 */
export async function calculateSmartWaitTime(
  botTimings: BotResponseTiming[],
  pollInterval: number,
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<{ waitSeconds: number; reason: string }> {
  const defaultWait = pollInterval;
  
  // Check PR status to see what's pending
  let prStatus: PRStatus | undefined;
  try {
    prStatus = await github.getPRStatus(owner, repo, prNumber, headSha);
  } catch (err) {
    // Ignore errors fetching status
  }
  
  // If bots are actively reviewing (eyes reaction or in-progress), wait longer
  const activelyReviewing = (prStatus?.activelyReviewingBots?.length ?? 0) > 0 || 
                             (prStatus?.botsWithEyesReaction?.length ?? 0) > 0;
  
  // If checks are running, factor that in too
  const checksRunning = (prStatus?.inProgressChecks?.length ?? 0) > 0 ||
                        (prStatus?.pendingChecks?.length ?? 0) > 0;
  
  // Use bot timing data if available
  if (botTimings.length > 0) {
    const { formatDuration } = await import('./logger.js');
    
    // Use max observed + 20% buffer for safety
    const maxObserved = Math.max(...botTimings.map(t => t.maxResponseMs));
    const avgObserved = Math.round(
      botTimings.reduce((sum, t) => sum + t.avgResponseMs, 0) / botTimings.length
    );
    
    // If actively reviewing, use max + buffer
    // Otherwise use average + smaller buffer
    let waitMs: number;
    let reason: string;
    
    if (activelyReviewing) {
      waitMs = Math.ceil(maxObserved * 1.2);  // Max + 20% buffer
      reason = `bot actively reviewing (max observed: ${formatDuration(maxObserved)})`;
    } else if (checksRunning) {
      waitMs = Math.ceil((avgObserved + maxObserved) / 2);  // Midpoint of avg and max
      reason = `CI checks running (avg: ${formatDuration(avgObserved)})`;
    } else {
      waitMs = Math.ceil(avgObserved * 1.1);  // Avg + 10% buffer
      reason = `based on avg response time (${formatDuration(avgObserved)})`;
    }
    
    // Clamp to reasonable bounds (min 30s, max 5 min)
    const minWaitMs = 30 * 1000;
    const maxWaitMs = 5 * 60 * 1000;
    waitMs = Math.max(minWaitMs, Math.min(maxWaitMs, waitMs));
    
    return { waitSeconds: Math.ceil(waitMs / 1000), reason };
  }
  
  // No timing data - use status-based heuristics
  if (activelyReviewing) {
    return { waitSeconds: Math.max(defaultWait, 90), reason: 'bot actively reviewing (no timing data)' };
  }
  
  if (checksRunning) {
    return { waitSeconds: Math.max(defaultWait, 60), reason: 'CI checks running (no timing data)' };
  }
  
  // Default: use configured poll interval
  return { waitSeconds: defaultWait, reason: 'default poll interval (no timing data)' };
}

/**
 * Wait for bot reviews after push with smart timing and progress feedback
 */
export async function waitForBotReviews(
  botTimings: BotResponseTiming[],
  pollInterval: number,
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<void> {
  const chalk = (await import('chalk')).default;
  
  const { waitSeconds, reason } = await calculateSmartWaitTime(
    botTimings,
    pollInterval,
    github,
    owner,
    repo,
    prNumber,
    headSha
  );
  
  console.log(chalk.gray(`\nWaiting ${waitSeconds}s for re-review (${reason})...`));
  
  // Show countdown with periodic status checks
  const checkInterval = 15;  // Check every 15 seconds
  let remaining = waitSeconds;
  let elapsedSinceLastCheck = 0;
  
  while (remaining > 0) {
    const sleepTime = Math.min(remaining, checkInterval);
    await sleep(sleepTime * 1000);
    remaining -= sleepTime;
    elapsedSinceLastCheck += sleepTime;
    
    if (remaining > 0 && elapsedSinceLastCheck >= 30) {
      elapsedSinceLastCheck = 0;
      // Every ~30s, check if bot has responded early
      try {
        const status = await github.getPRStatus(owner, repo, prNumber, headSha);
        const stillActive = (status.activelyReviewingBots?.length ?? 0) > 0 ||
                            (status.botsWithEyesReaction?.length ?? 0) > 0;
        
        if (!stillActive && status.ciState !== 'pending') {
          console.log(chalk.green('  Bot reviews appear complete, proceeding...'));
          return;
        } else {
          console.log(chalk.gray(`  Still waiting... (${remaining}s remaining)`));
        }
      } catch {
        // Ignore status check errors during wait
      }
    }
  }
}

/**
 * Execute bail-out procedure when stalemate is detected
 * Returns updated context with bail-out state
 */
export async function executeBailOut(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  runners: Runner[],
  options: CLIOptions,
  getModelsForRunner: (runner: Runner) => string[],
  workdir: string,
  llm: LLMClient
): Promise<{
  bailedOut: boolean;
  exitReason: string;
  exitDetails: string;
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: ReviewComment[];
}> {
  const chalk = (await import('chalk')).default;
  const Bailout = await import('./state/state-bailout.js');
  const Verification = await import('./state/state-verification.js');
  const State = await import('./state/state-core.js');
  
  const exitReason = 'bail_out';
  const cyclesCompleted = Bailout.getNoProgressCycles(stateContext);
  const exitDetails = `Stalemate after ${cyclesCompleted} cycles with no progress - ${unresolvedIssues.length} issue(s) remain`;
  
  const toolsExhausted = runners.map(r => r.name);
  
  // Count what was fixed vs what remains
  const issuesFixed = comments.filter(c => 
    Verification.isVerified(stateContext, c.id)
  ).length;
  
  // Build remaining issues summary
  const remainingIssues = unresolvedIssues.map(issue => ({
    commentId: issue.comment.id,
    filePath: issue.comment.path,
    line: issue.comment.line,
    summary: issue.comment.body.split('\n')[0].substring(0, 100),
  }));
  
  // Record bail-out in state
  Bailout.recordBailOut(
    stateContext,
    'no-progress-cycles',
    cyclesCompleted,
    remainingIssues,
    issuesFixed,
    toolsExhausted
  );
  
  await State.saveState(stateContext);
  
  // Print bail-out summary
  console.log(chalk.red('\n' + '═'.repeat(60)));
  console.log(chalk.red.bold('  BAIL-OUT: Stalemate Detected'));
  console.log(chalk.red('═'.repeat(60)));
  
  console.log(chalk.yellow(`\n  Reason: ${cyclesCompleted} complete cycle(s) with zero verified fixes`));
  console.log(chalk.gray(`  Max allowed: ${options.maxStaleCycles} (--max-stale-cycles)`));
  
  console.log(chalk.cyan('\n  Progress Summary:'));
  console.log(chalk.green(`    ✓ Fixed: ${issuesFixed} issues`));
  console.log(chalk.red(`    ✗ Remaining: ${unresolvedIssues.length} issues`));
  const totalLessons = LessonsAPI.Retrieve.getTotalCount(lessonsContext);
  const newLessons = LessonsAPI.Retrieve.getNewLessonsCount(lessonsContext);
  const lessonInfo = newLessons > 0 
    ? `${totalLessons} total (${newLessons} new this run)` 
    : `${totalLessons} (from previous runs)`;
  console.log(chalk.gray(`    📚 Lessons: ${lessonInfo}`));
  
  console.log(chalk.cyan('\n  Tools Exhausted:'));
  for (const tool of toolsExhausted) {
    const runner = runners.find(r => r.name === tool);
    if (runner) {
      const models = getModelsForRunner(runner);
      console.log(chalk.gray(`    • ${tool}: ${models.length} models tried`));
    } else {
      console.log(chalk.gray(`    • ${tool}: exhausted`));
    }
  }
  
  if (unresolvedIssues.length > 0) {
    console.log(chalk.cyan('\n  Remaining Issues (need human attention):'));
    for (const issue of unresolvedIssues.slice(0, 5)) {
      console.log(chalk.yellow(`    • ${issue.comment.path}:${issue.comment.line || '?'}`));
      const cleanPreview = Reporter.sanitizeCommentForDisplay(issue.comment.body).split('\n')[0];
      const truncated = cleanPreview.length > 80 ? `${cleanPreview.substring(0, 80)}...` : cleanPreview;
      console.log(chalk.gray(`      "${truncated}"`));
    }
    if (unresolvedIssues.length > 5) {
      console.log(chalk.gray(`    ... and ${unresolvedIssues.length - 5} more`));
    }
  }
  
  console.log(chalk.red('\n' + '═'.repeat(60)));
  console.log(chalk.gray('\n  Next steps:'));
  console.log(chalk.gray('    1. Review the lessons learned in .pr-resolver-state.json'));
  console.log(chalk.gray('    2. Check if remaining issues have conflicting requirements'));
  console.log(chalk.gray('    3. Consider increasing --max-stale-cycles if issues seem solvable'));
  console.log(chalk.gray('    4. Manually fix remaining issues or dismiss with comments'));
  console.log('');
  
  // Add "exhausted" comments for remaining unresolved issues
  // WHY: These issues couldn't be fixed automatically. Adding inline comments
  // documents this for review bots and humans on the next review pass.
  try {
    const { addDismissalComments } = await import('./workflow/dismissal-comments.js');
    
    // Build synthetic DismissedIssue objects for the exhausted issues
    const exhaustedIssues = unresolvedIssues.map(issue => ({
      commentId: issue.comment.id,
      reason: `Automated fix attempted ${cyclesCompleted} cycle(s) but could not resolve. Tools tried: ${toolsExhausted.join(', ')}. May need manual attention.`,
      dismissedAt: new Date().toISOString(),
      dismissedAtIteration: 0, // Doesn't matter for exhausted issues
      category: 'exhausted' as const,
      filePath: issue.comment.path,
      line: issue.comment.line,
      commentBody: issue.comment.body,
    }));
    
    if (exhaustedIssues.length > 0) {
      console.log(chalk.gray('\n  Adding exhausted comments to code...'));
      const { added } = await addDismissalComments(exhaustedIssues, workdir, llm);
      if (added > 0) {
        console.log(chalk.gray(`    Added ${added} exhausted comment${added === 1 ? '' : 's'}`));
      }
    }
  } catch (error) {
    // Non-fatal: exhausted comments are nice-to-have
    console.log(chalk.gray(`\n  Could not add exhausted comments: ${String(error)}`));
  }
  
  return {
    bailedOut: true,
    exitReason,
    exitDetails,
    finalUnresolvedIssues: [...unresolvedIssues],
    finalComments: [...comments],
  };
}

/**
 * Check for new bot reviews that arrived while working
 * Returns new comments and updated timing state
 */
export async function checkForNewBotReviews(
  expectedBotResponseTime: Date | null,
  botTimings: BotResponseTiming[],
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  existingCommentIds: Set<string>
): Promise<{
  newComments: ReviewComment[] | null;
  message: string | null;
  lastCommentFetchTime: Date | null;
  updatedExpectedBotResponseTime: Date | null;
}> {
  const { debug } = await import('./logger.js');
  
  if (!shouldCheckForNewComments(expectedBotResponseTime)) {
    return {
      newComments: null,
      message: null,
      lastCommentFetchTime: null,
      updatedExpectedBotResponseTime: expectedBotResponseTime,
    };
  }
  
  debug('Checking for new bot reviews (expected time reached)');
  
  try {
    const freshComments = await github.getReviewComments(owner, repo, prNumber);
    const newComments = freshComments.filter(c => !existingCommentIds.has(c.id));
    
    const now = new Date();
    
    if (newComments.length > 0) {
      // Calculate next expected response time (in case more reviews coming)
      let nextExpectedTime: Date | null = null;
      if (botTimings.length > 0) {
        const maxResponseMs = Math.max(...botTimings.map(t => t.maxResponseMs));
        nextExpectedTime = new Date(Date.now() + maxResponseMs);
      }
      
      return {
        newComments,
        message: `Found ${newComments.length} new review comment(s) from bots`,
        lastCommentFetchTime: now,
        updatedExpectedBotResponseTime: nextExpectedTime,
      };
    } else {
      // No new comments - push expected time back (check again in 30 seconds)
      return {
        newComments: null,
        message: null,
        lastCommentFetchTime: now,
        updatedExpectedBotResponseTime: new Date(Date.now() + 30 * 1000),
      };
    }
  } catch (err) {
    debug('Failed to check for new comments', { error: err });
    // On error, try again in 30 seconds
    return {
      newComments: null,
      message: null,
      lastCommentFetchTime: null,
      updatedExpectedBotResponseTime: new Date(Date.now() + 30 * 1000),
    };
  }
}

// More functions will be added here as we extract methods from PRResolver
