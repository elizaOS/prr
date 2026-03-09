/**
 * Fix iteration pre-checks
 * 
 * Runs at the start of each fix iteration:
 * 1. Check for new bot reviews
 * 2. Filter out verified issues
 * 3. Check for empty issues
 * 4. Pull remote commits
 * 5. Display iteration header
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import type { GitHubAPI } from '../github/api.js';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { CLIOptions } from '../cli.js';
import type { Runner } from '../../../shared/runners/types.js';
import * as ResolverProc from '../resolver-proc.js';

/**
 * Execute pre-iteration checks before running fixer
 * 
 * WORKFLOW:
 * 1. Check for new bot reviews (during long-running fix cycles)
 * 2. Filter out issues that were verified in this session
 * 3. Check if all issues are empty (exit early)
 * 4. Pull remote commits (detect concurrent updates)
 * 5. Update PR head SHA if remote was pulled
 * 6. Display iteration header with model info
 * 7. Start new iteration tracking in state
 * 
 * @returns Control flow signals and updated state
 */
export async function executePreIterationChecks(
  fixIteration: number,
  git: SimpleGit,
  github: GitHubAPI,
  owner: string,
  repo: string,
  number: number,
  prInfo: PRInfo,
  comments: ReviewComment[],
  unresolvedIssues: UnresolvedIssue[],
  existingCommentIds: Set<string>,
  verifiedThisSession: Set<string>,
  stateContext: StateContext,
  runner: Runner,
  options: CLIOptions,
  checkForNewBotReviews: (
    owner: string,
    repo: string,
    number: number,
    existingIds: Set<string>
  ) => Promise<{ newComments: ReviewComment[]; message: string } | null>,
  getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>,
  getCurrentModel: () => string | undefined,
  githubToken?: string,
  // WHY: Required for P1 (prompts.log audit) — new comments are run through assessSolvability when workdir is set; without it, (PR comment) and other unsolvable items would enter the fix queue mid-loop.
  workdir?: string
): Promise<{
  shouldBreak: boolean;
  exitReason?: string;
  exitDetails?: string;
  updatedHeadSha?: string;
}> {
  // Check for new bot reviews (skip on first iteration — comments were just fetched in main loop setup).
  if (fixIteration > 1) {
    await ResolverProc.processNewBotReviews(
      github,
      owner,
      repo,
      number,
      existingCommentIds,
      comments,
      unresolvedIssues,
      checkForNewBotReviews,
      getCodeSnippet,
      prInfo.headSha,
      stateContext,
      workdir
    );
  }
  
  // Filter verified issues
  ResolverProc.filterVerifiedIssues(unresolvedIssues, verifiedThisSession);
  
  // Check for empty issues
  const emptyCheck = await ResolverProc.checkEmptyIssues(
    unresolvedIssues,
    comments,
    stateContext,
    getCodeSnippet
  );
  if (emptyCheck.shouldBreak) {
    return {
      shouldBreak: true,
      exitReason: emptyCheck.exitReason,
      exitDetails: emptyCheck.exitDetails,
    };
  }
  
  // Check and pull remote commits (pass token so fetch/pull do not prompt for password)
  const remotePull = await ResolverProc.checkAndPullRemoteCommits(
    git,
    prInfo.branch,
    unresolvedIssues,
    stateContext,
    github,
    owner,
    repo,
    number,
    getCodeSnippet,
    githubToken
  );
  if (remotePull.shouldBreak) {
    return {
      shouldBreak: true,
      exitReason: remotePull.exitReason,
      exitDetails: remotePull.exitDetails,
    };
  }
  
  // Display iteration header
  const iterLabel = options.maxFixIterations ? `${fixIteration}/${options.maxFixIterations}` : `${fixIteration}`;
  const currentModel = getCurrentModel();
  const modelInfo = currentModel ? chalk.gray(` [${runner.name}/${currentModel}]`) : chalk.gray(` [${runner.name}]`);
  console.log(chalk.blue(`\n--- Fix iteration ${iterLabel}${modelInfo} ---\n`));

  // Start new iteration in state
  Iterations.startIteration(stateContext);

  return {
    shouldBreak: false,
    updatedHeadSha: remotePull.updatedHeadSha,
  };
}
