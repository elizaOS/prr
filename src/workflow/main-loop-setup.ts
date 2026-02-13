/**
 * Main loop setup and comment processing
 * 
 * Handles the outer push iteration loop:
 * 1. Fetch review comments
 * 2. Handle no-comments case
 * 3. Analyze unresolved issues
 * 4. Check for new comments added during cycle
 * 5. Run final audit if all resolved
 * 6. Handle dry-run mode
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
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
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import type { CLIOptions } from '../cli.js';
import type { Config } from '../config.js';
import { debug, debugStep, startTimer, endTimer, formatNumber, formatDuration, setTokenPhase } from '../logger.js';
import * as ResolverProc from '../resolver-proc.js';

/**
 * Process comments and determine if fix loop should run
 * 
 * WORKFLOW:
 * 1. Fetch all review comments from GitHub
 * 2. If no comments, handle via workflow (merge base, exit)
 * 3. Analyze which issues are still unresolved
 * 4. If all resolved, check for new comments during cycle
 * 5. If still all resolved, run final audit
 * 6. If audit fails, re-enter fix loop with failed items
 * 7. If dry-run, just print issues and exit
 * 
 * @returns Comments, unresolved issues, and control flow signals
 */
export async function processCommentsAndPrepareFixLoop(
  git: SimpleGit,
  github: GitHubAPI,
  owner: string,
  repo: string,
  number: number,
  prInfo: PRInfo,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  options: CLIOptions,
  config: Config,
  workdir: string,
  spinner: Ora,
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<{
    unresolved: UnresolvedIssue[];
    recommendedModels?: string[];
    recommendedModelIndex: number;
    modelRecommendationReasoning?: string;
    duplicateMap: Map<string, string[]>;
  }>,
  resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>,
  getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>,
  printUnresolvedIssues: (issues: UnresolvedIssue[]) => void,
  /** Comments already fetched during setup (e.g., CodeRabbit polling).
   *  WHY: Avoids re-fetching 200+ comments (3 GraphQL pages, ~3s) when
   *  the CodeRabbit check already did the exact same API call. */
  prefetchedComments?: ReviewComment[]
): Promise<{
  comments: ReviewComment[];
  unresolvedIssues: UnresolvedIssue[];
  shouldBreak: boolean;
  shouldRunFixLoop: boolean;
  exitReason?: string;
  exitDetails?: string;
  duplicateMap: Map<string, string[]>;
}> {
  // Fetch review comments (reuse prefetched if available)
  // WHY reuse: The CodeRabbit polling phase already fetches all comments via the same
  // GraphQL query (3+ pages for 200+ comments). Fetching again wastes ~3s and API quota.
  // Only reuse on the first push iteration — subsequent iterations need fresh data.
  debugStep('FETCHING REVIEW COMMENTS');
  startTimer('Fetch comments');
  let comments: ReviewComment[];
  if (prefetchedComments && prefetchedComments.length > 0) {
    comments = prefetchedComments;
    const fetchTime = endTimer('Fetch comments');
    spinner.succeed(`Found ${formatNumber(comments.length)} review comments (prefetched, ${formatDuration(fetchTime)})`);
    debug('Reused prefetched comments from setup phase', { count: comments.length });
  } else {
    spinner.start('Fetching review comments...');
    comments = await github.getReviewComments(owner, repo, number);
    const fetchTime = endTimer('Fetch comments');
    spinner.succeed(`Found ${formatNumber(comments.length)} review comments (${formatDuration(fetchTime)})`);
  }
  
  debug('Review comments', comments.map(c => ({
    id: c.id,
    author: c.author,
    path: c.path,
    line: c.line,
    bodyPreview: c.body.substring(0, 100) + (c.body.length > 100 ? '...' : ''),
  })));

  if (comments.length === 0) {
    const noCommentsResult = await ResolverProc.handleNoComments(
      git,
      prInfo,
      options,
      config,
      resolveConflictsWithLLM
    );
    if (noCommentsResult.shouldExit) {
      return {
        comments,
        unresolvedIssues: [],
        shouldBreak: true,
        shouldRunFixLoop: false,
        exitReason: noCommentsResult.exitReason,
        exitDetails: noCommentsResult.exitDetails,
        duplicateMap: new Map(),
      };
    }
  }

  // Check which issues still exist
  debugStep('ANALYZING ISSUES');
  setPhase(stateContext, 'analyzing');
  setTokenPhase('Analyze issues');
  startTimer('Analyze issues');
  console.log(chalk.gray(`Analyzing ${formatNumber(comments.length)} review comments...`));
  const analysisResult = await findUnresolvedIssues(comments, comments.length);
  const unresolvedIssues = analysisResult.unresolved;
  const duplicateMap = analysisResult.duplicateMap;
  const analyzeTime = endTimer('Analyze issues');
  
  // Analyze and report issues
  ResolverProc.analyzeAndReportIssues(comments, unresolvedIssues, stateContext, analyzeTime);

  if (unresolvedIssues.length === 0) {
    // Check for new comments added during fix cycle
    const newCommentsResult = await ResolverProc.checkForNewComments(
      github,
      owner,
      repo,
      number,
      comments,
      unresolvedIssues,
      spinner,
      getCodeSnippet
    );
    if (newCommentsResult.hasNewComments) {
      comments.length = 0;
      comments.push(...newCommentsResult.updatedComments);
      unresolvedIssues.length = 0;
      unresolvedIssues.push(...newCommentsResult.updatedUnresolvedIssues);
    }
  }
  
  // Only run final audit if we still have no unresolved issues
  if (unresolvedIssues.length === 0) {
    const auditResult = await ResolverProc.runFinalAudit(
      llm,
      stateContext,
      comments,
      options,
      spinner,
      getCodeSnippet
    );
    
    if (auditResult.failedAudit.length > 0) {
      // Re-populate unresolvedIssues with failed audit items so fix loop can continue
      unresolvedIssues.length = 0; // Clear
      for (const { comment, explanation } of auditResult.failedAudit) {
        const codeSnippet = await getCodeSnippet(comment.path, comment.line, comment.body);
        unresolvedIssues.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation,
          triage: { importance: 2, ease: 3 },  // Audit failures are important (fooled verifier)
        });
      }
      console.log(chalk.cyan(`\n→ Re-entering fix loop with ${formatNumber(unresolvedIssues.length)} issues from audit\n`));
      // Fall through to fix loop
    } else {
      // Final audit passed - all issues verified fixed
      // Commit and push changes
      await ResolverProc.commitAndPushChanges(
        git,
        prInfo,
        comments,
        stateContext,
        lessonsContext,
        options,
        config,
        workdir,
        spinner,
        resolveConflictsWithLLM
      );
      return {
        comments,
        unresolvedIssues,
        shouldBreak: true,
        shouldRunFixLoop: false,
        exitReason: 'audit_passed',
        exitDetails: 'Final audit passed - all issues verified fixed',
        duplicateMap,
      };
    }
  }

  // Dry run - just show issues
  if (options.dryRun) {
    printUnresolvedIssues(unresolvedIssues);
    return {
      comments,
      unresolvedIssues,
      shouldBreak: true,
      shouldRunFixLoop: false,
      exitReason: 'dry_run',
      exitDetails: `Dry run mode - showed ${unresolvedIssues.length} issue(s) without fixing`,
      duplicateMap,
    };
  }

  // Skip fix loop if there are no issues to fix
  if (unresolvedIssues.length === 0) {
    debug('No unresolved issues - skipping fix loop');
    console.log(chalk.green('\n✓ All issues resolved - nothing to fix'));
    return {
      comments,
      unresolvedIssues,
      shouldBreak: true,
      shouldRunFixLoop: false,
      exitReason: 'all_resolved',
      exitDetails: 'All issues were already resolved before fix loop',
      duplicateMap,
    };
  }

  // Ready to run fix loop
  return {
    comments,
    unresolvedIssues,
    shouldBreak: false,
    shouldRunFixLoop: true,
    duplicateMap,
  };
}
