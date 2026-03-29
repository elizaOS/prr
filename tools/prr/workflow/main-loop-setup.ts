/**
 * Main loop setup and comment processing
 *
 * Handles the outer push iteration loop:
 * 1. Fetch review comments
 * 2. **Catalog model auto-heal** (before path hashes — see applyCatalogModelAutoHeals)
 * 3. Handle no-comments case
 * 4. Analyze unresolved issues
 * 5. Check for new comments added during cycle
 * 6. Run final audit if all resolved
 * 7. Handle dry-run mode
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
import { hashFileContent } from '../../../shared/utils/file-hash.js';
import { createHash } from 'crypto';
import type { FindUnresolvedIssuesOptions } from './issue-analysis.js';
import { hasChanges } from '../../../shared/git/git-clone-index.js';
import { applyCatalogModelAutoHeals } from './catalog-model-autoheal.js';

/**
 * Process comments and determine if fix loop should run
 * 
 * WORKFLOW:
 * 1. Fetch all review comments from GitHub
 * 2. Catalog model auto-heal (quoted literals near review lines, before analysis hashes)
 * 3. If no comments, handle via workflow (merge base, exit)
 * 4. Analyze which issues are still unresolved
 * 5. If all resolved, check for new comments during cycle
 * 6. If still all resolved, run final audit
 * 7. If audit fails, re-enter fix loop with failed items
 * 8. If dry-run, just print issues and exit
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
  /** When set, reuse cached analysis if comment IDs, headSha, and file hashes for comment paths unchanged (output.log audit). */
  analysisCacheRef?: { current: { commentCount: number; headSha: string; commentIds?: string; fileHashesKeyDigest?: string; unresolvedIssues: UnresolvedIssue[]; comments: ReviewComment[]; duplicateMap: Map<string, string[]> } | null }
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

  if (stateContext.state && stateContext.currentCommentIds.size > 0) {
    const pruned = State.pruneVerifiedToCurrentCommentIds(stateContext.state, stateContext.currentCommentIds);
    if (pruned.removedVerified > 0 || pruned.removedVerifiedComments > 0) {
      const recovered = stateContext.gitRecoveredVerificationCount;
      const recoveredHint =
        recovered != null && recovered > 0
          ? ` (${formatNumber(recovered)} ID(s) recovered from git this run; pruned entries are absent from the ${formatNumber(comments.length)} current PR comment(s).)`
          : '';
      console.log(
        chalk.gray(
          `  Pruned stale verification: ${formatNumber(pruned.removedVerified)} ID(s) from verifiedFixed, ${formatNumber(pruned.removedVerifiedComments)} from verifiedComments (not in current PR comments).${recoveredHint}`,
        ),
      );
      await State.saveState(stateContext);
    }
    delete stateContext.gitRecoveredVerificationCount;
  }

  // Restore catalog-correct model strings before analysis. Order matters: solvability dismisses
  // outdated advice, but the workdir may still carry a prior bad rename — heal first so snippets
  // and fileHashesKey below reflect corrected source. WHY saveState: markVerified updates verification state.
  debug('[Auto-heal] Starting catalog model auto-heal phase', { 
    workdir, 
    commentCount: comments.length,
    verifiedThisSessionSize: stateContext.verifiedThisSession?.size ?? 0,
  });
  const catalogHeal = applyCatalogModelAutoHeals(workdir, comments, stateContext);
  if (catalogHeal.modifiedPaths.length > 0) {
    debug('[Auto-heal] Catalog model auto-heal applied', {
      paths: catalogHeal.modifiedPaths,
      count: catalogHeal.modifiedPaths.length,
      verifiedThisSessionSize: stateContext.verifiedThisSession?.size ?? 0,
    });
  }
  if (catalogHeal.verificationTouched) {
    await State.saveState(stateContext);
  } else if (catalogHeal.modifiedPaths.length === 0) {
    debug('[Auto-heal] No files healed and no catalog verification updates');
  }

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

  // Reuse cached analysis when comment set, HEAD, and file content for comment paths unchanged (output.log audit: key by comment IDs + file hashes).
  const headSha = prInfo.headSha ?? '';
  const cache = analysisCacheRef?.current;
  const currentCommentIds = comments.map((c) => c.id).sort().join(',');
  const uniquePaths = [...new Set(comments.map((c) => c.path).filter(Boolean))];
  const pathHashes = await Promise.all(
    uniquePaths.map(async (p) => ({ path: p, hash: await hashFileContent(workdir, p) }))
  );
  const fileHashesKey = pathHashes
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, hash }) => `${path}:${hash}`)
    .join('|');
  const fileHashesKeyDigest = createHash('sha256').update(fileHashesKey).digest('hex').slice(0, 16);

  let unresolvedIssues: UnresolvedIssue[];
  let duplicateMap: Map<string, string[]>;
  let analyzeTime: number;
  const cacheHit =
    cache &&
    cache.headSha === headSha &&
    (cache.commentIds != null ? cache.commentIds === currentCommentIds : cache.commentCount === comments.length) &&
    (cache.fileHashesKeyDigest != null ? cache.fileHashesKeyDigest === fileHashesKeyDigest : true);
  if (cacheHit) {
    unresolvedIssues = cache.unresolvedIssues;
    duplicateMap = cache.duplicateMap;
    analyzeTime = 0;
    console.log(chalk.gray(`  Reusing cached analysis (${formatNumber(comments.length)} comments, same IDs + file hashes)`));
    debug('Reused analysis cache', { commentCount: comments.length, headSha: headSha.slice(0, 7), fileHashesDigest: fileHashesKeyDigest });
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
      analysisCacheRef.current = {
        commentCount: comments.length,
        headSha,
        commentIds: currentCommentIds,
        fileHashesKeyDigest,
        unresolvedIssues: [...unresolvedIssues],
        comments: [...comments],
        duplicateMap: new Map(duplicateMap),
      };
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
    const getFullFile = (path: string, line: number | null, body: string) =>
      ResolverProc.getFullFileForAudit(workdir, path, line, body);
    const auditResult = await ResolverProc.runFinalAudit(
      llm,
      stateContext,
      auditComments,
      options,
      spinner,
      getCodeSnippet,
      getFullFile,
      workdir // Pill cycle 2 #4: Pass workdir for Rule 6 validation
    );
    
    if (auditResult.failedAudit.length > 0) {
      // runFinalAudit() already unmarked every failed-audit comment (single place — avoids duplicate unmark logs).
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
    // Heal-only run: no LLM fixes, but catalog auto-heal may have written files + verifiedThisSession.
    // WHY same entry as post-audit commit: commit gate requires verified session ids + dirty tree;
    // without this branch, users would see a clean analysis but an uncommitted workdir.
    const vs = stateContext.verifiedThisSession;
    if (
      vs &&
      vs.size > 0 &&
      !options.dryRun &&
      !options.noCommit &&
      (await hasChanges(git))
    ) {
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
        resolveConflictsWithLLM,
      );
    }
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
