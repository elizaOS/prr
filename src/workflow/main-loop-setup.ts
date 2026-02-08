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
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { LLMClient } from '../llm/client.js';
import type { CLIOptions } from '../cli.js';
import type { Config } from '../config.js';

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
  stateManager: StateManager,
  lessonsManager: LessonsManager,
  llm: LLMClient,
  options: CLIOptions,
  config: Config,
  workdir: string,
  spinner: Ora,
  findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<UnresolvedIssue[]>,
  resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>,
  getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>,
  printUnresolvedIssues: (issues: UnresolvedIssue[]) => void
): Promise<{
  comments: ReviewComment[];
  unresolvedIssues: UnresolvedIssue[];
  shouldBreak: boolean;
  shouldRunFixLoop: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  const {
    debug,
    debugStep,
    startTimer,
    endTimer,
    formatNumber,
    formatDuration,
    setTokenPhase,
  } = await import('../logger.js');
  const ResolverProc = await import('../resolver-proc.js');

  // Fetch review comments
  debugStep('FETCHING REVIEW COMMENTS');
  startTimer('Fetch comments');
  spinner.start('Fetching review comments...');
  const comments = await github.getReviewComments(owner, repo, number);
  const fetchTime = endTimer('Fetch comments');
  spinner.succeed(`Found ${formatNumber(comments.length)} review comments (${formatDuration(fetchTime)})`);
  
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
      };
    }
  }

  // Check which issues still exist
  debugStep('ANALYZING ISSUES');
  stateManager.setPhase('analyzing');
  setTokenPhase('Analyze issues');
  startTimer('Analyze issues');
  console.log(chalk.gray(`Analyzing ${formatNumber(comments.length)} review comments...`));
  const unresolvedIssues = await findUnresolvedIssues(comments, comments.length);
  const analyzeTime = endTimer('Analyze issues');
  
  // Analyze and report issues
  ResolverProc.analyzeAndReportIssues(comments, unresolvedIssues, stateManager, analyzeTime);

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
      stateManager,
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
        stateManager,
        lessonsManager,
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
    };
  }

  // Ready to run fix loop
  return {
    comments,
    unresolvedIssues,
    shouldBreak: false,
    shouldRunFixLoop: true,
  };
}
