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
import type { Config } from '../../../shared/config.js';
import { debug, debugStep, startTimer, endTimer, formatNumber, formatDuration, setTokenPhase } from '../../../shared/logger.js';
import * as ResolverProc from '../resolver-proc.js';
import { computeLineMapFromDiff } from '../../../shared/git/git-diff.js';
import type { FindUnresolvedIssuesOptions } from './issue-analysis.js';

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
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number, options?: FindUnresolvedIssuesOptions) => Promise<{
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
  prefetchedComments?: ReviewComment[],
  /** When set, reuse cached analysis if comment count and prInfo.headSha unchanged. */
  analysisCacheRef?: { current: { commentCount: number; headSha: string; unresolvedIssues: UnresolvedIssue[]; comments: ReviewComment[]; duplicateMap: Map<string, string[]> } | null }
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

  // Store current comment IDs on stateContext so reporters can bound verifiedFixed
  // against the actual comment set (stale IDs from previous HEAD revisions are excluded).
  stateContext.currentCommentIds = new Set(comments.map(c => c.id));

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

  // Reuse cached analysis when comment set and HEAD unchanged (saves ~1–4 min of LLM analysis).
  const headSha = prInfo.headSha ?? '';
  const cache = analysisCacheRef?.current;
  let unresolvedIssues: UnresolvedIssue[];
  let duplicateMap: Map<string, string[]>;
  let analyzeTime: number;
  if (cache && cache.commentCount === comments.length && cache.headSha === headSha) {
    unresolvedIssues = cache.unresolvedIssues;
    duplicateMap = cache.duplicateMap;
    analyzeTime = 0;
    console.log(chalk.gray(`  Reusing cached analysis (${formatNumber(comments.length)} comments, same as previous iteration)`));
    debug('Reused analysis cache', { commentCount: comments.length, headSha: headSha.slice(0, 7) });
  } else {
    debugStep('ANALYZING ISSUES');
    setPhase(stateContext, 'analyzing');
    setTokenPhase('Analyze issues');
    startTimer('Analyze issues');
    const baseRef = prInfo.baseBranch ? `origin/${prInfo.baseBranch}` : 'HEAD~1';
    const lineMap = await computeLineMapFromDiff(git, baseRef, 'HEAD');
    if (lineMap.size > 0) debug('Line map from diff', { files: lineMap.size });
    let changedFiles: string[] = [];
    try {
      const out = await git.raw(['diff', '--name-only', baseRef, 'HEAD']);
      changedFiles = out.trim() ? out.trim().split('\n') : [];
    } catch {
      // Base ref may not exist (e.g. first push)
    }
    console.log(chalk.gray(`Analyzing ${formatNumber(comments.length)} review comments...`));
    const getFileContentFromRepo = async (path: string): Promise<string | null> => {
      try {
        return await git.raw(['show', `HEAD:${path}`]);
      } catch {
        return null;
      }
    };
    const analysisResult = await findUnresolvedIssues(comments, comments.length, {
      lineMap: lineMap.size > 0 ? lineMap : undefined,
      getFileContentFromRepo,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    });
    unresolvedIssues = analysisResult.unresolved;
    duplicateMap = analysisResult.duplicateMap;
    analyzeTime = endTimer('Analyze issues');
    if (analysisCacheRef) {
      analysisCacheRef.current = { commentCount: comments.length, headSha, unresolvedIssues: [...unresolvedIssues], comments: [...comments], duplicateMap: new Map(duplicateMap) };
    }
  }

  // Issue graduation: process high-attempt issues first (so they get batched first; future: single-issue or human review for ≥N attempts).
  unresolvedIssues = [...unresolvedIssues].sort((a, b) => {
    const na = Performance.getIssueAttempts(stateContext, a.comment.id).length;
    const nb = Performance.getIssueAttempts(stateContext, b.comment.id).length;
    return nb - na;
  });

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
      getCodeSnippet,
      stateContext,
      workdir
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
    // Audit only comments that are not already dismissed (output.log audit: dismissed (PR comment) issues were re-audited and re-entered fix loop, wasting 10 iterations).
    const auditComments = comments.filter((c) => !Dismissed.isCommentDismissed(stateContext, c.id));
    const getFullFile = (path: string) => ResolverProc.getFullFileForAudit(workdir, path);
    const auditResult = await ResolverProc.runFinalAudit(
      llm,
      stateContext,
      auditComments,
      options,
      spinner,
      getCodeSnippet,
      getFullFile
    );
    
    if (auditResult.failedAudit.length > 0) {
      // Invalidate verification cache for issues the audit says are still unfixed.
      // WHY: Without unmarkVerified(), the next iteration's verifyFixes still sees
      // these as "already verified" and skips them, so Changed files → [] and
      // zero progress — the loop re-enters forever (e.g. 30+ min runs).
      for (const { comment } of auditResult.failedAudit) {
        Verification.unmarkVerified(stateContext, comment.id);
      }
      // Re-run solvability on audit-failed items so we don't re-enter with unsolvable issues (e.g. (PR comment), deleted file).
      const { assessSolvability } = await import('./helpers/solvability.js');
      unresolvedIssues.length = 0;
      const failedItems = auditResult.failedAudit;
      let reEnterCount = 0;
      for (let i = 0; i < failedItems.length; i++) {
        const { comment, explanation } = failedItems[i];
        const solvability = assessSolvability(workdir, comment, stateContext);
        if (!solvability.solvable) {
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            solvability.reason ?? explanation,
            solvability.dismissCategory ?? 'not-an-issue',
            comment.path,
            comment.line,
            comment.body ?? '',
            solvability.remediationHint
          );
          debug('Audit re-entry: dismissed unsolvable issue', { commentId: comment.id, reason: solvability.reason });
          continue;
        }
        const codeSnippet = await getCodeSnippet(comment.path, comment.line, comment.body);
        unresolvedIssues.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation,
          triage: { importance: 2, ease: 3 },
        });
        reEnterCount++;
      }
      if (reEnterCount > 0) {
        console.log(chalk.cyan(`\n→ Re-entering fix loop with ${formatNumber(reEnterCount)} issues from audit\n`));
      }
      if (reEnterCount < failedItems.length) {
        await State.saveState(stateContext);
      }
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
      exitDetails: `Dry run mode - showed ${formatNumber(unresolvedIssues.length)} issue(s) without fixing`,
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
