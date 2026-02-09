/**
 * Push iteration loop
 * 
 * Execute single push iteration:
 * 1. Process comments and prepare fix loop
 * 2. Run fix iterations until all fixed or max iterations
 * 3. Commit and push if changes
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { SimpleGit } from 'simple-git';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { Runner } from '../runners/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import { hasChanges } from '../git/git-clone-index.js';
import { formatNumber, debugStep, startTimer } from '../logger.js';
import * as ResolverProc from '../resolver-proc.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { recheckSolvability } from './helpers/solvability.js';

/** Git and GitHub context for a push iteration */
export interface PushIterationGitContext {
  git: SimpleGit;
  github: GitHubAPI;
  owner: string;
  repo: string;
  number: number;
  workdir: string;
}

/** Mutable iteration state tracked across push iterations */
export interface PushIterationState {
  pushIteration: number;
  maxPushIterations: number;
  rapidFailureCount: number;
  lastFailureTime: number;
  consecutiveFailures: number;
  modelFailuresInCycle: number;
  progressThisCycle: number;
  expectedBotResponseTime: Date | null;
}

/** Contextual objects passed through the push iteration */
export interface PushIterationContexts {
  prInfo: PRInfo;
  stateContext: StateContext;
  lessonsContext: LessonsContext;
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: ReviewComment[];
  /** Mutation refs for cross-iteration state */
  prInfoRef: { current: PRInfo };
  finalUnresolvedIssuesRef: { current: UnresolvedIssue[] };
  finalCommentsRef: { current: ReviewComment[] };
  expectedBotResponseTimeRef: { current: Date | null };
}

/** Callback functions used during push iteration */
export interface PushIterationCallbacks {
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<UnresolvedIssue[]>;
  resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>;
  getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>;
  printUnresolvedIssues: (issues: UnresolvedIssue[]) => void;
  getCurrentModel: () => string | undefined;
  parseNoChangesExplanation: (output: string) => string | null;
  trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  tryRotation: () => boolean;
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
  checkForNewBotReviews: (owner: string, repo: string, number: number, existingIds: Set<string>) => Promise<{ newComments: ReviewComment[]; message: string } | null>;
  calculateExpectedBotResponseTime: (lastCommitTime: Date) => Date | null;
  waitForBotReviews: (owner: string, repo: string, number: number, sha: string) => Promise<void>;
}

/** Service dependencies for push iteration */
export interface PushIterationServices {
  llm: LLMClient;
  options: CLIOptions;
  config: Config;
  spinner: Ora;
  runner: Runner;
}

/**
 * Execute single push iteration
 * 
 * WORKFLOW:
 * 1. Process comments and prepare fix loop
 * 2. Initialize fix loop state
 * 3. While not all fixed and under max iterations:
 *    - Run pre-iteration checks
 *    - Execute fix iteration
 *    - Verify fixes
 *    - Handle iteration cleanup
 *    - Post-verification handling (rotation if needed)
 * 4. Commit and push if changes exist
 * 
 * @returns Exit control flow
 */
export async function executePushIteration(
  gitCtx: PushIterationGitContext,
  iterState: PushIterationState,
  contexts: PushIterationContexts,
  callbacks: PushIterationCallbacks,
  services: PushIterationServices
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
  updatedRapidFailureCount: number;
  updatedLastFailureTime: number;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: number;
  updatedHeadSha?: string;
}> {
  // Destructure parameter objects for local use
  const { git, github, owner, repo, number, workdir } = gitCtx;
  let { rapidFailureCount, lastFailureTime, consecutiveFailures, modelFailuresInCycle, progressThisCycle } = iterState;
  const { pushIteration, maxPushIterations } = iterState;
  const { prInfo, stateContext, lessonsContext } = contexts;
  const { prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef } = contexts;
  const {
    findUnresolvedIssues, resolveConflictsWithLLM, getCodeSnippet, printUnresolvedIssues,
    getCurrentModel, parseNoChangesExplanation, trySingleIssueFix, tryRotation,
    tryDirectLLMFix, executeBailOut, checkForNewBotReviews, calculateExpectedBotResponseTime, waitForBotReviews,
  } = callbacks;
  const { llm, options, config, spinner, runner } = services;

  if (options.autoPush && pushIteration > 1) {
    const iterLabel = maxPushIterations === Infinity ? `${pushIteration}` : `${pushIteration}/${maxPushIterations}`;
    console.log(chalk.blue(`\n--- Push iteration ${iterLabel} ---\n`));
  }

  // Process comments and prepare fix loop
  const loopResult = await ResolverProc.processCommentsAndPrepareFixLoop(
    git, github, owner, repo, number, prInfo, stateContext, lessonsContext, llm, options, config, workdir, spinner,
    findUnresolvedIssues, resolveConflictsWithLLM, getCodeSnippet, printUnresolvedIssues
  );
  
  const { comments, unresolvedIssues } = loopResult;
  
  if (loopResult.shouldBreak) {
    // Store final state for after action report (for dry-run)
    if (options.dryRun) {
      finalUnresolvedIssuesRef.current = [...unresolvedIssues];
      finalCommentsRef.current = [...comments];
    }
    return {
      shouldBreak: true,
      exitReason: loopResult.exitReason,
      exitDetails: loopResult.exitDetails,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle,
    };
  }

  // Initialize fix loop
  // CLI convention: 0 = unlimited. Use || (not ??) since 0 should map to Infinity.
  const maxFixIterations = options.maxFixIterations || Infinity;
  const loopState = ResolverProc.initializeFixLoop(comments.map(c => c.id));
  let { fixIteration, allFixed, verifiedThisSession, alreadyCommitted, existingCommentIds } = loopState;
  
  let exitReason = '';
  let exitDetails = '';
  
  
  while (fixIteration < maxFixIterations && !allFixed) {
    fixIteration++;
    
    // Pre-iteration checks
    const preChecks = await ResolverProc.executePreIterationChecks(
      fixIteration, git, github, owner, repo, number, prInfo, comments, unresolvedIssues, existingCommentIds, verifiedThisSession, stateContext, runner, options,
      checkForNewBotReviews, getCodeSnippet, getCurrentModel
    );
    
    if (preChecks.shouldBreak) {
      exitReason = preChecks.exitReason || '';
      exitDetails = preChecks.exitDetails || '';
      break;
    }
    if (preChecks.updatedHeadSha) {
      prInfoRef.current.headSha = preChecks.updatedHeadSha;
    }

    // Execute fix iteration
    const iterResult = await ResolverProc.executeFixIteration(
      unresolvedIssues, comments, git, workdir, runner, stateContext, lessonsContext, llm, options, verifiedThisSession,
      rapidFailureCount, lastFailureTime, consecutiveFailures, modelFailuresInCycle, progressThisCycle,
      getCurrentModel, parseNoChangesExplanation, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut
    );
    
    // Update state
    rapidFailureCount = iterResult.updatedRapidFailureCount;
    lastFailureTime = iterResult.updatedLastFailureTime;
    consecutiveFailures = iterResult.updatedConsecutiveFailures;
    modelFailuresInCycle = iterResult.updatedModelFailuresInCycle;
    progressThisCycle = iterResult.updatedProgressThisCycle;
    unresolvedIssues.splice(0, unresolvedIssues.length, ...iterResult.updatedUnresolvedIssues);
    const lessonsBeforeFix = iterResult.lessonsBeforeFix;
    
    if (iterResult.shouldExit) return { shouldBreak: true, exitReason: iterResult.exitReason || 'bail_out', exitDetails: iterResult.exitDetails || 'Fix iteration requested early exit', updatedRapidFailureCount: rapidFailureCount, updatedLastFailureTime: lastFailureTime, updatedConsecutiveFailures: consecutiveFailures, updatedModelFailuresInCycle: modelFailuresInCycle, updatedProgressThisCycle: progressThisCycle };
    if (iterResult.shouldBreak) {
      exitReason = iterResult.exitReason || '';
      exitDetails = iterResult.exitDetails || '';
      break;
    }
    if (iterResult.allFixed) {
      allFixed = true;
      break;
    }
    if (iterResult.shouldContinue) {
      await State.saveState(stateContext);
      await LessonsAPI.Save.save(lessonsContext);
      continue;
    }

    // Verify fixes
    const { verifiedCount, failedCount, changedIssues, unchangedIssues, changedFiles } = await ResolverProc.verifyFixes(git, unresolvedIssues, stateContext, lessonsContext, llm, verifiedThisSession, options.noBatch);
    const totalIssues = unresolvedIssues.length;
    const currentModel = getCurrentModel();
    
    // Handle iteration cleanup
    const cleanupResult = await ResolverProc.handleIterationCleanup(verifiedCount, failedCount, totalIssues, changedIssues, unchangedIssues, runner, currentModel,
      stateContext, lessonsContext, verifiedThisSession, alreadyCommitted, lessonsBeforeFix, fixIteration, git, prInfo.branch, config.githubToken, options, calculateExpectedBotResponseTime);
    
    progressThisCycle += cleanupResult.progressMade;
    if (cleanupResult.expectedBotResponseTime !== undefined) expectedBotResponseTimeRef.current = cleanupResult.expectedBotResponseTime;

    // Check if all fixed
    allFixed = failedCount === 0;
    if (allFixed && !exitReason.startsWith('all')) {
      exitReason = 'all_fixed';
      exitDetails = 'All issues fixed and verified in fix loop';
    }

    if (!allFixed) {
      // Post-verification handling
      const postVerif = await ResolverProc.handlePostVerification(verifiedCount, allFixed, unresolvedIssues, comments, verifiedThisSession, git, consecutiveFailures, modelFailuresInCycle, progressThisCycle,
        stateContext, lessonsContext, options, runner.name, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut);
      
      consecutiveFailures = postVerif.updatedConsecutiveFailures;
      modelFailuresInCycle = postVerif.updatedModelFailuresInCycle;
      progressThisCycle = postVerif.updatedProgressThisCycle;
      unresolvedIssues.splice(0, unresolvedIssues.length, ...postVerif.updatedUnresolvedIssues);
      
      // Phase 2: Refresh snippets for issues whose files were touched by fixer
      const getCodeSnippetFn = (path: string, line: number | null, body?: string) =>
        ResolverProc.getCodeSnippet(gitCtx.workdir, path, line, body);
      const refreshResult = await recheckSolvability(
        unresolvedIssues, 
        changedFiles, 
        gitCtx.workdir, 
        stateContext, 
        getCodeSnippetFn
      );
      if (refreshResult.dismissed > 0) {
        console.log(chalk.yellow(`  ${refreshResult.dismissed} issue(s) became stale (files deleted by fixer)`));
      }
      if (refreshResult.refreshed > 0) {
        console.log(chalk.gray(`  ${refreshResult.refreshed} issue(s) refreshed (snippets updated)`));
      }
      unresolvedIssues.splice(0, unresolvedIssues.length, ...refreshResult.updated);
      
      if (postVerif.shouldBreak) break;
    }
  }

  if (!allFixed && maxFixIterations !== Infinity) {
    console.log(chalk.yellow(`\nMax fix iterations (${formatNumber(maxFixIterations)}) reached. ${formatNumber(unresolvedIssues.length)} issues remain.`));
    exitReason = 'max_iterations';
    exitDetails = `Hit max fix iterations (${maxFixIterations}) with ${unresolvedIssues.length} issue(s) remaining`;
    finalUnresolvedIssuesRef.current = [...unresolvedIssues];
    finalCommentsRef.current = [...comments];
  }

  // Commit changes if we have any
  debugStep('COMMIT PHASE');
  if (await hasChanges(git)) {
    const commitResult = await ResolverProc.handleCommitAndPush(git, prInfo, owner, repo, number, comments, stateContext, lessonsContext, options, config.githubToken, github, workdir, spinner, pushIteration, maxPushIterations,
      resolveConflictsWithLLM, waitForBotReviews);
    if (commitResult.shouldBreak) {
      return {
        shouldBreak: true,
        exitReason: commitResult.exitReason,
        exitDetails: commitResult.exitDetails,
        updatedRapidFailureCount: rapidFailureCount,
        updatedLastFailureTime: lastFailureTime,
        updatedConsecutiveFailures: consecutiveFailures,
        updatedModelFailuresInCycle: modelFailuresInCycle,
        updatedProgressThisCycle: progressThisCycle,
      };
    }
  } else {
    console.log(chalk.yellow('\nNo changes to commit'));
    finalUnresolvedIssuesRef.current = [...unresolvedIssues];
    finalCommentsRef.current = [...comments];
    return {
      shouldBreak: true,
      exitReason: 'no_changes',
      exitDetails: 'No changes to commit (fixer made no modifications)',
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle,
    };
  }

  return {
    shouldBreak: false,
    exitReason,
    exitDetails,
    updatedRapidFailureCount: rapidFailureCount,
    updatedLastFailureTime: lastFailureTime,
    updatedConsecutiveFailures: consecutiveFailures,
    updatedModelFailuresInCycle: modelFailuresInCycle,
    updatedProgressThisCycle: progressThisCycle,
  };
}
