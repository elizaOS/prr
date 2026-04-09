/**
 * Issue analysis — determines which PR comments still need fixing.
 *
 * This is the "brain" of the fix loop. For each push iteration, it takes
 * the full set of review comments and produces the subset that still need
 * work (UnresolvedIssue[]).
 *
 * WHY this pipeline matters: Without careful filtering, the fixer would
 * receive 50+ comments every iteration — most already fixed or irrelevant.
 * Each unnecessary LLM analysis call costs tokens and time. The pipeline
 * filters aggressively before touching the LLM:
 *
 *   1. isVerified() gate     — skip comments already confirmed fixed
 *   2. Solvability check     — skip impossible issues (deleted files, stale refs)
 *   3. Heuristic dedup       — group obviously-duplicate comments (same file+line)
 *   4. LLM semantic dedup    — group semantically-duplicate comments (different lines, same issue)
 *   5. Comment status cache  — skip "open" comments on unmodified files
 *   6. LLM analysis          — only fresh/changed comments reach the LLM
 *
 * WHY the status cache is critical: Steps 1-4 are cheap (no LLM calls for
 * most). But step 6 sends each surviving comment to the LLM with its code
 * snippet. For 20 comments, that's 20 LLM calls (sequential) or 1 large
 * batch call. The status cache (step 5) prevents this for comments we've
 * already classified and whose target file hasn't changed.
 *
 * WHY forceReanalyze: The --reverify flag and stale verifications bypass
 * the status cache. Without this, sync hooks that flip status to "resolved"
 * would prevent re-analysis of comments that SHOULD be re-checked (stale
 * verifications exist specifically to catch regressions).
 *
 * WHY modular files (issue-analysis-*.ts): Snippet line math, LLM dedup, and
 * STALE/ordering context change for different reasons and at different rates.
 * Keeping them next to this orchestrator would recreate a multi-thousand-line
 * file; instead, **`findUnresolvedIssues`** stays here as the pipeline driver,
 * and **`issue-analysis.ts`** re-exports the small public surface tests and
 * **`resolver-proc`** need — without importing every submodule at every call site.
 */
import chalk from 'chalk';
import { join } from 'path';
import { readFile } from 'fs/promises';
import type { CLIOptions } from '../cli.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import {
  commentAsksForAccessibility,
  getMentionedTestFilePaths,
  getPathsToDeleteFromCommentBody,
  getRenameTargetPath,
  getTestPathForSourceFileIssue,
  isSnippetTooShort,
  reviewSuggestsFixInTest,
  sanitizeCommentForPrompt,
} from '../analyzer/prompt-builder.js';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as CommentStatusAPI from '../state/state-comment-status.js';
import * as State from '../state/state-core.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient, ModelRecommendationContext } from '../llm/client.js';
import type { Runner } from '../../../shared/runners/types.js';
import {
  COULD_NOT_INJECT_CREATE_FILE_THRESHOLD,
  COULD_NOT_INJECT_DISMISS_THRESHOLD,
  getVerificationExpiryForIterationCount,
  VERIFICATION_EXPIRY_ITERATIONS,
} from '../../../shared/constants.js';
import { filterAllowedPathsForFix, normalizeRepoPath, stripGitDiffPathPrefix } from '../../../shared/path-utils.js';
import { isBlastRadiusDismissEnabled } from '../../../shared/dependency-graph/index.js';
import { looksLikeCreateFileIssue, validateDismissalExplanation } from './utils.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, warn, formatNumber } from '../../../shared/logger.js';
import { assessSolvability, resolveTrackedPathWithPrFiles, SNIPPET_PLACEHOLDER } from './helpers/solvability.js';
import { isTrackedGitSubmodulePath } from '../../../shared/git/git-submodule-path.js';
import { stripSeverityFraming } from './helpers/review-body-normalize.js';
import { hashFileContent } from '../../../shared/utils/file-hash.js';
import { buildLifecycleAwareVerificationSnippet, commentNeedsLifecycleContext } from './fix-verification.js';
import { printDebugIssueTable } from './debug-issue-table.js';
import type { DedupResult } from './issue-analysis-dedup.js';
import {
  crossFileDedup,
  heuristicDedup,
  llmDedup,
  logDuplicateCandidates,
  propagateStatusToDuplicates,
} from './issue-analysis-dedup.js';
import {
  commentNeedsConservativeAnalysisContext,
  extractSymbolsFromStaleExplanation,
  fileContainsSymbol,
} from './issue-analysis-context.js';
import {
  getFullFileForAudit,
  getWiderSnippetForAnalysis,
} from './issue-analysis-snippet-helpers.js';
import { buildSnippetFromRepoContent } from './issue-analysis-snippets.js';

export {
  commentNeedsConservativeAnalysisContext,
  commentNeedsOrderingContext,
  extractSymbolsFromStaleExplanation,
  fileContainsSymbol,
} from './issue-analysis-context.js';
export type { DedupResult } from './issue-analysis-dedup.js';
export { getCodeSnippet } from './issue-analysis-snippets.js';
export type { FullFileForAuditResult } from './issue-analysis-snippet-helpers.js';
export { getFullFileForAudit, getWiderSnippetForAnalysis, parseLineReferencesFromBody } from './issue-analysis-snippet-helpers.js';

/** Optional options for findUnresolvedIssues (e.g. line map from git diff for post-push). */
export type FindUnresolvedIssuesOptions = {
  /** Map path -> (oldLine -> newLine) from git diff base..HEAD. Use when code moved so comment line refs stay valid. */
  lineMap?: Map<string, Map<number, number>>;
  /** When file is not in workdir, try to read from repo (e.g. git show HEAD:path). Used when snippet is "(file not found or unreadable)". */
  getFileContentFromRepo?: (path: string) => Promise<string | null>;
  /** Files changed in the PR (e.g. from git diff --name-only). When comment.path is a basename, prefer matching full path so issue targets the correct file. */
  changedFiles?: string[];
  /** Map path → BFS depth from changed files (imports + proximity). When set, issues get `inBlastRadius` / `blastRadiusDepth`; optional dismiss when `PRR_BLAST_RADIUS_DISMISS=1`. */
  blastRadius?: Map<string, number>;
};

/** If the issue requests tests or review suggests fix-in-test (e.g. "fix mocks in tests"), return [primaryPath, testPath] so allowedPaths is set at issue build. */
function getAllowedPathsForNewIssue(comment: ReviewComment, primaryPath: string, codeSnippet: string, explanation: string | undefined): string[] | undefined {
  const issueLike = { comment: { ...comment, path: primaryPath }, codeSnippet, stillExists: true, explanation: explanation ?? '' };
  const testPath = getTestPathForSourceFileIssue(issueLike, { forceTestPath: reviewSuggestsFixInTest(comment.body ?? '') });
  const renameTarget = getRenameTargetPath(issueLike);
  const hiddenTestTargets = getMentionedTestFilePaths(issueLike);
  const extraPaths = [testPath, renameTarget, ...hiddenTestTargets].filter((p): p is string => Boolean(p));
  if (extraPaths.length === 0) return undefined;
  return filterAllowedPathsForFix([primaryPath, ...extraPaths]);
}

/** Allowed paths for a new issue: test path when relevant, plus any paths listed in "delete/remove these files" body. Never returns []. */
function getEffectiveAllowedPathsForNewIssue(comment: ReviewComment, primaryPath: string, codeSnippet: string, explanation: string | undefined): string[] {
  const base = getAllowedPathsForNewIssue(comment, primaryPath, codeSnippet, explanation) ?? [primaryPath];
  const deletePaths = getPathsToDeleteFromCommentBody(comment.body ?? '');
  if (deletePaths.length === 0) {
    const filtered = filterAllowedPathsForFix(base);
    return filtered.length > 0 ? filtered : [primaryPath];
  }
  const merged = filterAllowedPathsForFix([...base, ...deletePaths]);
  return merged.length > 0 ? merged : [primaryPath];
}

/**
 * Annotate unresolved issues with blast-radius fields; optionally dismiss out-of-scope when
 * `PRR_BLAST_RADIUS_DISMISS=1`. Runs once before final save so dismissals persist.
 */
function applyBlastRadiusToUnresolved(
  unresolved: UnresolvedIssue[],
  blastRadius: Map<string, number> | undefined,
  stateContext: StateContext
): UnresolvedIssue[] {
  if (!blastRadius || blastRadius.size === 0) {
    return unresolved;
  }
  for (const issue of unresolved) {
    const primary = issue.resolvedPath ?? issue.comment.path;
    const k = stripGitDiffPathPrefix(normalizeRepoPath(primary));
    const d = blastRadius.get(k) ?? blastRadius.get(primary);
    if (d !== undefined) {
      issue.inBlastRadius = true;
      issue.blastRadiusDepth = d;
    } else {
      issue.inBlastRadius = false;
    }
  }
  if (!isBlastRadiusDismissEnabled()) {
    return unresolved;
  }
  const kept: UnresolvedIssue[] = [];
  for (const issue of unresolved) {
    if (issue.inBlastRadius === false) {
      const primary = issue.resolvedPath ?? issue.comment.path;
      Dismissed.dismissIssue(
        stateContext,
        issue.comment.id,
        'Comment target is outside the PR dependency blast radius (imports + proximity heuristics).',
        'out-of-scope',
        primary,
        issue.comment.line,
        issue.comment.body ?? '',
        'This file is outside the PR\'s dependency graph (blast radius). Review manually if the comment is valid.',
      );
    } else {
      kept.push(issue);
    }
  }
  return kept;
}

/** When comment.path is a basename (no directory), resolve to full path from diff if present. Prompts.log audit: fixer was sent wrong file (root reporting.py) when issue was about benchmarks/bfcl/reporting.py. */
function resolvePathFromDiff(commentPath: string, changedFiles: string[] | undefined): string | undefined {
  if (!changedFiles?.length || commentPath.includes('/')) return undefined;
  const base = commentPath;
  const full = changedFiles.find((f) => f.endsWith('/' + base) || f === base);
  return full && full !== base ? full : undefined;
}

/** True if the comment is purely positive (e.g. "What's Good", praise only). Prompts.log audit: such comments were sent to fixer 4× with every model saying nothing to fix. */
function isCommentPositiveOnly(body: string): boolean {
  if (!body || body.length > 2000) return false;
  const trimmed = body.trim();
  if (!/(?:^|\n)#*\s*✅\s*What's Good|Documentation:.*are now accurate|only contains positive feedback|looks clean and follows .*spec|nice work on the frontmatter structure|no hardcoded credentials|doesn'?t expose any sensitive APIs|no security (?:issues|concerns) identified|correctly reflects|nice attention to detail|(?:docs?|documentation) in sync/i.test(trimmed)) return false;
  if (/\b(?:fix|change|should|incorrect|missing|add|remove|update|⚠️|❌|issue\s+(is|with)|bug|error|concern)\b/i.test(trimmed)) return false;
  return true;
}

/** True if the comment is a Vercel bot deployment status or team-permissions notification, not a code review. output.log audit: such comments burned 10 fix iterations. */
function isVercelDeploymentOrTeamComment(comment: { author: string; body: string }): boolean {
  if (comment.author !== 'vercel[bot]') return false;
  const b = (comment.body ?? '').trim();
  if (/\[vc\]:\s*#?[A-Za-z0-9=]+/.test(b)) return true;
  if (/must be a member of the \*\*[^*]+\*\* team on Vercel to deploy/i.test(b)) return true;
  return false;
}

export async function findUnresolvedIssues(
  comments: ReviewComment[],
  totalCount: number,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  runner: Runner,
  options: CLIOptions,
  workdir: string,
  getCodeSnippetFn: (path: string, line: number | null, commentBody?: string) => Promise<string>,
  getModelsForRunner: (runner: Runner) => string[],
  findUnresolvedIssuesOptions?: FindUnresolvedIssuesOptions
): Promise<{
  unresolved: UnresolvedIssue[];
  recommendedModels?: string[];
  recommendedModelIndex: number;
  modelRecommendationReasoning?: string;
  duplicateMap: Map<string, string[]>;
}> {
  const lineMap = findUnresolvedIssuesOptions?.lineMap;
  const getSnippet = lineMap
    ? (path: string, line: number | null, body?: string) => {
        const L = (line != null && path) ? (lineMap.get(path)?.get(line) ?? line) : line;
        return getCodeSnippetFn(path, L, body);
      }
    : getCodeSnippetFn;

  const unresolved: UnresolvedIssue[] = [];
  let alreadyResolved = 0;
  let skippedCache = 0;
  let staleRecheck = 0;
  let dismissedStaleFiles = 0;
  let dismissedChronicFailure = 0;
  let dismissedNotAnIssue = 0;
  let dismissedPlaceholder = 0;
  let dismissedRemaining = 0;

  const iterationCount = stateContext.state?.iterations?.length ?? 0;
  const effectiveExpiry = getVerificationExpiryForIterationCount(iterationCount);
  const staleVerificationsRaw = Verification.getStaleVerifications(stateContext, effectiveExpiry);
  // WHY: output.log audit — don't re-check or unmark comments just recovered from git this run.
  const recoveredIds = stateContext.state?.recoveredFromGitCommentIds;
  const recoveredSet = recoveredIds?.length ? new Set(recoveredIds) : undefined;
  if (recoveredIds?.length) {
    stateContext.state!.recoveredFromGitCommentIds = undefined;
  }
  let staleVerifications = recoveredIds?.length
    ? staleVerificationsRaw.filter((id) => !recoveredIds.includes(id))
    : staleVerificationsRaw;
  const changedFiles = findUnresolvedIssuesOptions?.changedFiles;
  if (changedFiles?.length) {
    // Only re-check stale verifications for comments whose file changed (output.log audit).
    const changedSet = new Set(changedFiles);
    staleVerifications = staleVerifications.filter((id) => {
      const c = comments.find((co) => co.id === id);
      if (!c?.path) return true;
      if (changedSet.has(c.path)) return true;
      return [...changedSet].some((f) => f.endsWith('/' + c.path) || c.path.endsWith('/' + f));
    });
  }

  // First pass: filter out already-verified issues, run solvability checks (sync),
  // then batch-fetch all code snippets concurrently.
  // WHY two-phase: Solvability checks are synchronous (file existence, attempt counts)
  // and filter out ~30-50% of comments. By running them first, we avoid fetching
  // snippets for issues we'll immediately dismiss. Then we fetch all remaining
  // snippets in parallel instead of one-at-a-time.
  const toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
    resolvedPath?: string;
  }> = [];

  // Phase 1: Sync filtering (verified, solvability)
  const needSnippets: Array<{
    comment: ReviewComment;
    snippetLine: number | null;
    contextHints?: string[];
    resolvedPath?: string;
  }> = [];

  for (const comment of comments) {
    // WHY not skip outdated: GitHub "outdated" means the diff hunk moved, not that the issue is fixed
    // (DEVELOPMENT.md §2). Still run solvability + LLM existence check so we don't miss bugs that remain.

    const isStale = staleVerifications.includes(comment.id);
    
    // If --reverify flag is set, ignore the cache and re-check everything
    if (!options.reverify && !isStale && Verification.isVerified(stateContext, comment.id)) {
      alreadyResolved++;
      continue;
    }
    
    if (options.reverify && Verification.isVerified(stateContext, comment.id)) {
      skippedCache++;
    }
    
    if (isStale) {
      staleRecheck++;
    }

    if (isCommentPositiveOnly(comment.body ?? '')) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'Comment is purely positive (e.g. What\'s Good) with no actionable issue — dismissing',
        'not-an-issue',
        comment.path,
        comment.line,
        comment.body,
        undefined
      );
      dismissedNotAnIssue++;
      continue;
    }

    if (isVercelDeploymentOrTeamComment(comment)) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'Vercel deployment/team notification — not a code review; fix via Vercel dashboard',
        'not-an-issue',
        comment.path,
        comment.line,
        comment.body,
        undefined
      );
      dismissedNotAnIssue++;
      continue;
    }

    const couldNotInjectCount = stateContext.state?.couldNotInjectCountByCommentId?.[comment.id] ?? 0;
    const couldNotInjectThreshold = looksLikeCreateFileIssue(comment) ? COULD_NOT_INJECT_CREATE_FILE_THRESHOLD : COULD_NOT_INJECT_DISMISS_THRESHOLD;
    if (couldNotInjectCount >= couldNotInjectThreshold) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'Target file could not be resolved in the repository (repeated could-not-inject + no-change cycles)',
        'file-unchanged',
        comment.path,
        comment.line,
        comment.body,
        undefined
      );
      continue;
    }

    // Deterministic solvability check (zero LLM cost)
    const solvability = assessSolvability(workdir, comment, stateContext);
    if (!solvability.solvable) {
      // Pill cycle 2 #6: Auto-verify after N ALREADY_FIXED verdicts instead of dismissing
      if (solvability.autoVerify && solvability.dismissCategory === 'already-fixed') {
        debug('Auto-verifying issue after multiple ALREADY_FIXED verdicts', {
          commentId: comment.id,
          path: comment.path,
          reason: solvability.reason,
        });
        Verification.markVerified(stateContext, comment.id);
        // Add to verifiedThisSession if available (it's set on stateContext)
        if (stateContext.verifiedThisSession) {
          stateContext.verifiedThisSession.add(comment.id);
        }
        continue;
      }
      
      // CRITICAL: dismissIssue ONLY — do NOT call markVerified.
      // If the file comes back (revert, re-add), we want to re-analyze it.
      const reason = solvability.reason ?? `Issue not solvable (${solvability.dismissCategory ?? 'unknown'})`;
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        reason,
        solvability.dismissCategory!,
        comment.path,
        comment.line,
        comment.body,
        solvability.remediationHint
      );
      
      // Pill #7: Cascade dismissal to sibling sub-items when dismissing for outdated model advice
      // (same file+line means same underlying issue; all sub-items should be dismissed consistently)
      if (solvability.dismissCategory === 'not-an-issue' && /outdated.*model/i.test(reason)) {
        const match = /^ic-(\d+)-(\d+)$/.exec(comment.id);
        if (match) {
          const parentId = match[1];
          const siblings = comments.filter(c => 
            c.id.startsWith(`ic-${parentId}-`) && 
            c.id !== comment.id &&
            c.path === comment.path &&
            c.line === comment.line
          );
          for (const sibling of siblings) {
            if (!Dismissed.isCommentDismissed(stateContext, sibling.id) && !Verification.isVerified(stateContext, sibling.id)) {
              Dismissed.dismissIssue(
                stateContext,
                sibling.id,
                `${reason} (cascaded from sibling sub-item)`,
                solvability.dismissCategory!,
                sibling.path,
                sibling.line,
                sibling.body,
                solvability.remediationHint
              );
              debug('Cascaded dismissal to sibling sub-item', { parent: comment.id, sibling: sibling.id, category: solvability.dismissCategory });
            }
          }
        }
      }
      
      if (solvability.dismissCategory === 'stale') {
        dismissedStaleFiles++;
      } else if (solvability.dismissCategory === 'chronic-failure') {
        dismissedChronicFailure++;
      } else if (solvability.dismissCategory === 'not-an-issue') {
        dismissedNotAnIssue++;
      } else if (solvability.dismissCategory === 'remaining') {
        dismissedRemaining++;
      }
      continue;
    }

    const snippetLine = solvability.retargetedLine ?? comment.line;
    let contextHints = solvability.contextHints;
    // WHY: PRR appends "✅ Addressed in commits X to Y" after pushing a fix. When that comment
    // is still open (e.g. bot hasn't re-reviewed), the analysis LLM should verify that the
    // current code actually resolves the issue instead of assuming the prior fix is still valid.
    if (/✅\s*Addressed in commits?\s+\w+/i.test(comment.body)) {
      contextHints = [
        ...(contextHints || []),
        'A previous fix attempt claimed to address this issue. Verify whether the current code actually resolves it before making new changes.',
      ];
    }
    if (commentNeedsConservativeAnalysisContext(comment.body ?? '')) {
      contextHints = [
        ...(contextHints || []),
        'This is a lifecycle/order-sensitive issue. Answer NO only if the shown code provides concrete evidence that the full behavior is now correct.',
      ];
    }
    // resolvedPath: solvability first, then rename/diff hints, then PR-scoped basename tie-break.
    // WHY resolveTrackedPathWithPrFiles last: bare filenames can match many tracked files; the PR
    // diff list disambiguates to the path actually changed on this branch (DEVELOPMENT.md — path accounting).
    const resolvedPath = solvability.resolvedPath
      ?? resolvePathFromDiff(comment.path, changedFiles)
      ?? resolveTrackedPathWithPrFiles(workdir, comment.path, comment.body ?? '', changedFiles)
      ?? undefined;
    needSnippets.push({ comment, snippetLine, contextHints, resolvedPath });
  }

  // Phase 2: Batch-fetch all code snippets concurrently
  // WHY parallel: Each snippet is an independent file read. With 30+ comments
  // surviving the solvability filter, sequential reads add ~1-2s of I/O latency.
  const snippetResults = await Promise.all(
    needSnippets.map(async ({ comment, snippetLine, contextHints, resolvedPath }) => {
      const pathForSnippet = resolvedPath ?? comment.path;
      const codeSnippet = await getSnippet(pathForSnippet, snippetLine, comment.body);
      return { comment, codeSnippet, contextHints, resolvedPath };
    })
  );

  // Phase 3: Post-filter placeholder results
  for (const { comment, codeSnippet, contextHints, resolvedPath } of snippetResults) {
    if (codeSnippet === SNIPPET_PLACEHOLDER) {
      const pathForSubmoduleCheck = (resolvedPath ?? comment.path).replace(/\\/g, '/');
      if (isTrackedGitSubmodulePath(workdir, pathForSubmoduleCheck)) {
        Dismissed.dismissIssue(
          stateContext,
          comment.id,
          'Review path is a git submodule (gitlink) — no regular file text for snippets after existence check',
          'not-an-issue',
          comment.path,
          comment.line,
          comment.body,
          'Run git submodule update --init, or fix in the submodule repo / parent manifest.',
        );
        dismissedNotAnIssue++;
      } else {
        Dismissed.dismissIssue(
          stateContext,
          comment.id,
          'File not found or unreadable after existence check passed',
          'stale',
          comment.path,
          comment.line,
          comment.body,
        );
      }
      dismissedPlaceholder++;
      continue;
    }

    toCheck.push({ comment, codeSnippet, contextHints, resolvedPath });
  }

  // Build stable commentId → display number mapping ONCE.
  // Used by candidate log (Phase 0) AND dedup verdicts (Phase 1) so that
  // "#7" means the same comment everywhere in the output.
  const idToDisplayNum = new Map<string, number>();
  for (let i = 0; i < toCheck.length; i++) {
    idToDisplayNum.set(toCheck[i].comment.id, i + 1);
  }

  // Phase 0: Log duplicate candidates (observation only, no filtering)
  logDuplicateCandidates(toCheck, idToDisplayNum);

  // ── Dedup cache: skip LLM dedup when full comment set is unchanged ─────────
  // Key by ALL comment IDs (from API), not toCheck. WHY: Push iteration 2+ often has same
  // comments but toCheck shrinks (some resolved), so keying by toCheck caused cache miss and
  // re-ran LLM dedup (~200k chars wasted). Reuse grouping for full set and filter to current toCheck.
  const allCommentIds = comments.map(c => c.id).sort().join(',');
  const persisted = stateContext.state?.dedupCache;
  const dedupCacheHit =
    persisted?.commentIds === allCommentIds &&
    Array.isArray(persisted.dedupedIds) &&
    persisted.duplicateMap &&
    typeof persisted.duplicateMap === 'object' &&
    persisted.schema === 'dedup-v2';

  let dedupResult: DedupResult;

  if (dedupCacheHit && persisted) {
    const toCheckById = new Map(toCheck.map(item => [item.comment.id, item]));
    const persistedMap = new Map<string, string[]>(Object.entries(persisted.duplicateMap));
    const newDuplicateMap = new Map<string, string[]>();
    const newDuplicateItems = new Map<string, typeof toCheck[0]>();
    const repIds = new Set<string>();
    const inSomeGroup = new Set<string>();

    for (const [canonicalId, dupeIds] of persistedMap) {
      const allInGroup = [canonicalId, ...dupeIds];
      const inToCheck = allInGroup.filter(id => toCheckById.has(id));
      if (inToCheck.length === 0) continue;
      const repId = inToCheck[0];
      repIds.add(repId);
      for (const id of inToCheck) inSomeGroup.add(id);
      const otherIds = inToCheck.filter(id => id !== repId);
      if (otherIds.length > 0) {
        newDuplicateMap.set(repId, otherIds);
        for (const otherId of otherIds) {
          const otherItem = toCheckById.get(otherId);
          if (otherItem) newDuplicateItems.set(otherId, otherItem);
        }
      }
    }
    const dedupedToCheck = [
      ...repIds,
      ...toCheck.filter(i => !inSomeGroup.has(i.comment.id)).map(i => i.comment.id),
    ].map(id => toCheckById.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
    dedupResult = {
      dedupedToCheck,
      duplicateMap: newDuplicateMap,
      duplicateItems: newDuplicateItems,
    };
    console.log(chalk.gray(`  Dedup results reused (comment set unchanged, ${formatNumber(dedupResult.duplicateMap.size)} canonical groups)`));
  } else {
    // Phase 1: Heuristic deduplication (zero LLM cost)
    try {
      dedupResult = heuristicDedup(toCheck, idToDisplayNum);
    } catch (err) {
      warn(`Dedup failed, proceeding without dedup: ${err}`);
      dedupResult = {
        dedupedToCheck: toCheck,
        duplicateMap: new Map(),
        duplicateItems: new Map(),
      };
    }

    // Phase 2: LLM semantic deduplication (catches what heuristics miss).
    // Phase 3: Cross-file root-cause dedup (gated on 5+ survivors, one cheap-model call).
    // Rate limits: global 1 concurrent + 6s delay + 429 retry backoff keep us under 10/min.
    try {
      dedupResult = await llmDedup(dedupResult, toCheck, llm);
    } catch (err) {
      warn(`LLM dedup failed, proceeding with heuristic-only results: ${err}`);
    }

    try {
      dedupResult = await crossFileDedup(dedupResult, llm);
    } catch (err) {
      warn(`Cross-file dedup failed, proceeding without it: ${err}`);
    }

    // Persist dedup results keyed by full comment set so next run (or push iteration) can skip LLM when comments unchanged.
    if (stateContext.state) {
      stateContext.state.dedupCache = {
        commentIds: allCommentIds,
        duplicateMap: Object.fromEntries(dedupResult.duplicateMap),
        dedupedIds: dedupResult.dedupedToCheck.map(item => item.comment.id),
        // WHY versioned: cross-file phase invalidates caches written before schema existed.
        schema: 'dedup-v2',
      };
    }
  }

  // Use deduplicated list for analysis
  const toAnalyze = dedupResult.dedupedToCheck;

  // ── Comment status: skip LLM for open comments on unchanged files ─────
  //
  // HISTORY: Every push iteration sent ALL unresolved comments to the LLM
  // for classification, even when neither the comment body nor its target
  // file had changed. For 20+ issues this burned 5-15s and thousands of
  // tokens on identical "still exists" results. Now each comment has an
  // explicit open/resolved status in the persisted state. "Open" comments
  // whose target file hasn't been modified are skipped — we already know
  // the issue exists. Only new comments and comments on modified files
  // (where our fixes may have resolved them) go through the LLM.

  // Compute file content hashes (batched by unique path)
  const uniqueAnalyzePaths = new Set(toAnalyze.map(item => item.comment.path));
  const fileHashes = new Map<string, string>();
  await Promise.all(
    Array.from(uniqueAnalyzePaths).map(async (p) => {
      fileHashes.set(p, await hashFileContent(workdir, p));
    })
  );

  // Build a set for fast lookup in the status check loop (after dedup, before status split).
  // HISTORY: staleVerifications forces re-check of comments past verification-expiry (see getVerificationExpiryForIterationCount).
  // Without this bypass, Phase 0 hooks would mark them 'resolved', Phase 2 hash relaxation
  // would return the status, and line 774 would re-dismiss them — defeating stale re-check.
  const staleVerificationSet = new Set(staleVerifications);

  // Split toAnalyze into status hits (reuse) and fresh items (need LLM)
  const freshToAnalyze: typeof toAnalyze = [];
  let statusHits = 0;

  for (const item of toAnalyze) {
    const fileHash = fileHashes.get(item.comment.path) || '__missing__';
    
    // Both --reverify and stale verifications force fresh LLM analysis.
    // --reverify: user explicitly wants to re-check everything.
    // staleVerifications: comment was verified long enough ago (iteration-scaled expiry), fix may have regressed.
    // Without this, Phase 0 hooks + Phase 2 hash relaxation would make these
    // bypass the LLM entirely, defeating the purpose of stale verification.
    const forceReanalyze = options.reverify || staleVerificationSet.has(item.comment.id);
    const validStatus = forceReanalyze
      ? undefined
      : CommentStatusAPI.getValidStatus(stateContext, item.comment.id, fileHash);

    if (validStatus && validStatus.status === 'open') {
      // Status hit: comment is "open" and file hasn't changed since classification
      statusHits++;

      // Issue still exists — reuse persisted classification
      const duplicates = dedupResult.duplicateMap.get(item.comment.id);
      const mergedDuplicates = duplicates?.map(dupId => {
        const dupItem = dedupResult.duplicateItems.get(dupId);
        return dupItem ? {
          commentId: dupItem.comment.id,
          author: dupItem.comment.author,
          body: dupItem.comment.body,
          path: dupItem.comment.path,
          line: dupItem.comment.line,
        } : null;
      }).filter((d): d is NonNullable<typeof d> => d !== null);

      unresolved.push({
        comment: item.comment,
        codeSnippet: item.codeSnippet,
        stillExists: true,
        explanation: validStatus.explanation,
        triage: { importance: validStatus.importance, ease: validStatus.ease },
        mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
        allowedPaths: getEffectiveAllowedPathsForNewIssue(item.comment, item.resolvedPath ?? item.comment.path, item.codeSnippet, validStatus.explanation),
        resolvedPath: item.resolvedPath,
      });
    } else if (validStatus && validStatus.status === 'resolved') {
      // Resolved but not in verifiedFixed (stale dismissal) — re-dismiss preserving existing category
      const existing = Dismissed.getDismissedIssue(stateContext, item.comment.id);
      if (existing) {
        Dismissed.dismissIssue(stateContext, item.comment.id, existing.reason ?? 'Previously dismissed', existing.category,
          item.comment.path, item.comment.line, item.comment.body, existing.remediationHint);
      } else {
        Dismissed.dismissIssue(stateContext, item.comment.id, validStatus.explanation ?? 'Resolved (no explanation recorded)',
          validStatus.classification === 'stale' ? 'stale' : 'already-fixed',
          item.comment.path, item.comment.line, item.comment.body);
      }
      statusHits++;
    } else {
      // No valid status: new comment, or file changed → need fresh LLM analysis
      freshToAnalyze.push(item);
    }
  }

  // Report solvability dismissals — issues leaving the queue before fix attempt
  const totalDismissed = dismissedStaleFiles + dismissedChronicFailure + dismissedNotAnIssue + dismissedPlaceholder + dismissedRemaining;
  if (totalDismissed > 0) {
    const parts: string[] = [];
    if (dismissedStaleFiles > 0) parts.push(`${formatNumber(dismissedStaleFiles)} stale file(s)`);
    if (dismissedChronicFailure > 0) parts.push(`${formatNumber(dismissedChronicFailure)} chronic failure(s)`);
    if (dismissedNotAnIssue > 0) parts.push(`${formatNumber(dismissedNotAnIssue)} lockfile/not-an-issue`);
    if (dismissedPlaceholder > 0) parts.push(`${formatNumber(dismissedPlaceholder)} unreadable file(s)`);
    if (dismissedRemaining > 0) parts.push(`${formatNumber(dismissedRemaining)} remaining (verifier/wrong-file exhaust)`);
    console.log(chalk.gray(`  DISMISSED: ${formatNumber(totalDismissed)} issue(s) removed from queue (${parts.join(', ')})`));
    if (dismissedChronicFailure > 0) {
      console.log(chalk.cyan(`  ↳ ${formatNumber(dismissedChronicFailure)} chronic-failure dismissal(s) — token-saving (no LLM retries)`));
    }
  }

  if (options.reverify && skippedCache > 0) {
    console.log(chalk.yellow(`  --reverify: Re-checking ${formatNumber(skippedCache)} previously cached as "fixed"`));
  } else if (alreadyResolved > 0) {
    console.log(chalk.gray(`  ${formatNumber(alreadyResolved)} already verified as fixed (cached)`));
  }
  
  if (staleRecheck > 0) {
    console.log(chalk.yellow(`  ${formatNumber(staleRecheck)} stale verifications (>${formatNumber(effectiveExpiry)} iterations old) - re-checking`));
  }

  // Report comment status stats
  if (statusHits > 0) {
    console.log(chalk.gray(`  ${formatNumber(statusHits)} comment(s) skipped (status unchanged — open issues on unmodified files)`));
  }
  if (freshToAnalyze.length > 0 && statusHits > 0) {
    console.log(chalk.gray(`  ${formatNumber(freshToAnalyze.length)} comment(s) need fresh LLM analysis (new or file changed)`));
  }

  if (freshToAnalyze.length === 0) {
    // All items served from persisted status — no LLM call needed
    if (statusHits > 0 && toAnalyze.length > 0) {
      console.log(chalk.green(`  ✓ All ${formatNumber(statusHits)} issue(s) served from persisted status — skipping LLM analysis`));
    }
    if (options.verbose) {
      printDebugIssueTable('after analysis', comments, stateContext, unresolved);
    }
    return {
      unresolved,
      recommendedModelIndex: 0,
      duplicateMap: dedupResult.duplicateMap,
    };
  }

  let recommendedModels: string[] | undefined;
  let recommendedModelIndex = 0;
  let modelRecommendationReasoning: string | undefined;

  if (options.noBatch) {
    // Sequential mode - one LLM call per comment
    console.log(chalk.gray(`  Analyzing ${formatNumber(freshToAnalyze.length)} comments sequentially...`));
    
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const { comment, codeSnippet, contextHints, resolvedPath } = freshToAnalyze[i];
      console.log(chalk.gray(`    [${formatNumber(i + 1)}/${formatNumber(freshToAnalyze.length)}] ${comment.path}:${comment.line || '?'}`));
      
      const result = await llm.checkIssueExists(
        comment.body,
        comment.path,
        comment.line,
        codeSnippet,
        contextHints
      );

      // Persist comment status
      const fHash = fileHashes.get(comment.path) || '__missing__';
      if (result.stale) {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'stale', result.explanation, comment.path, fHash);
        propagateStatusToDuplicates(stateContext, comment.id, dedupResult, fileHashes, { kind: 'resolved', classification: 'stale', explanation: result.explanation });
      } else if (result.exists) {
        CommentStatusAPI.markOpen(stateContext, comment.id, 'exists', result.explanation, 3, 3, comment.path, fHash);
        propagateStatusToDuplicates(stateContext, comment.id, dedupResult, fileHashes, { kind: 'open', classification: 'exists', explanation: result.explanation, importance: 3, ease: 3 });
      } else {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'fixed', result.explanation, comment.path, fHash);
        propagateStatusToDuplicates(stateContext, comment.id, dedupResult, fileHashes, { kind: 'resolved', classification: 'fixed', explanation: result.explanation });
      }

      if (result.stale) {
        // Issue is stale (code fundamentally restructured) - dismiss without marking verified
        if (validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            result.explanation,
            'stale',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          warn(`Stale issue missing valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue is stale, but provided insufficient explanation',
            triage: { importance: 3, ease: 3 },  // Default: sequential mode has no triage
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, undefined),
            resolvedPath,
          });
        }
      } else if (result.exists) {
        // Check if this is a canonical issue with duplicates
        const duplicates = dedupResult.duplicateMap.get(comment.id);
        const mergedDuplicates = duplicates?.map(dupId => {
          const dupItem = dedupResult.duplicateItems.get(dupId);
          return dupItem ? {
            commentId: dupItem.comment.id,
            author: dupItem.comment.author,
            body: dupItem.comment.body,
            path: dupItem.comment.path,
            line: dupItem.comment.line,
          } : null;
        }).filter((d): d is NonNullable<typeof d> => d !== null);

        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: result.explanation,
          triage: { importance: 3, ease: 3 },  // Default: sequential mode has no triage
          mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, result.explanation),
          resolvedPath,
        });
      } else {
        // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
        if (validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
          // Valid explanation - document why it doesn't need fixing
          Verification.markVerified(stateContext, comment.id);
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            result.explanation,
            'already-fixed',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          // Invalid/missing explanation - treat as unresolved (potential bug)
          warn(`Cannot dismiss without valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
            triage: { importance: 3, ease: 3 },  // Default: sequential mode has no triage
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, undefined),
            resolvedPath,
          });
        }
      }
    }
  } else {
    // Batch mode - one LLM call for all comments
    console.log(chalk.gray(`  Batch analyzing ${formatNumber(freshToAnalyze.length)} comments with LLM...`));
    // Prompts.log audit (Cycle 38): one snippet per file so we don't send the same file content twice for multiple issues on the same file (token saving).
    // When snippet is too short or a11y, expand once per file. When file not in workdir, try getFileContentFromRepo once per file.
    const pathToFirstIndex = new Map<string, number>();
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const p = freshToAnalyze[i]!.resolvedPath ?? freshToAnalyze[i]!.comment.path;
      if (!pathToFirstIndex.has(p)) pathToFirstIndex.set(p, i);
    }
    const snippetByPath = new Map<string, string>();
    await Promise.all(
      [...pathToFirstIndex.entries()].map(async ([primaryPath, firstIndex]) => {
        const item = freshToAnalyze[firstIndex]!;
        let codeSnippet = item.codeSnippet;
        if (isSnippetTooShort(codeSnippet) || commentAsksForAccessibility(item.comment.body)) {
          codeSnippet = await getWiderSnippetForAnalysis(workdir, primaryPath, item.comment.line, item.comment.body);
        }
        if (codeSnippet === '(file not found or unreadable)' && findUnresolvedIssuesOptions?.getFileContentFromRepo) {
          const content = await findUnresolvedIssuesOptions.getFileContentFromRepo(primaryPath);
          if (content) {
            codeSnippet = buildSnippetFromRepoContent(content, item.comment.line, item.comment.body, primaryPath);
          }
        }
        snippetByPath.set(primaryPath, codeSnippet);
      })
    );
    const batchInput = freshToAnalyze.map((item, index) => {
      const primaryPath = item.resolvedPath ?? item.comment.path;
      const codeSnippet = snippetByPath.get(primaryPath) ?? item.codeSnippet;
      return {
        id: `issue_${index + 1}`,
        comment: sanitizeCommentForPrompt(item.comment.body),
        filePath: primaryPath,
        line: item.comment.line,
        codeSnippet,
        contextHints: item.contextHints,
      };
    });

    // Build model context for smart model selection (unless --model-rotation is set)
    let modelContext: ModelRecommendationContext | undefined;
    if (!options.modelRotation) {
      const availableModels = getModelsForRunner(runner);
      // Get attempt history for these specific issues
      const commentIds = freshToAnalyze.map(item => item.comment.id);
      modelContext = {
        availableModels,
        modelHistory: Performance.getModelHistorySummary(stateContext) || undefined,
        attemptHistory: Performance.getAttemptHistoryForIssues(stateContext, commentIds),
        // WHY false: Verification only judges issues; model recommendation block wasted ~60k chars/run (audit). Recommendation is not used for verify path.
        includeModelRecommendation: false,
      };
    }

    type BatchInputItem = Parameters<LLMClient['batchCheckIssuesExist']>[0][number];
    type BatchCheckResultType = Awaited<ReturnType<LLMClient['batchCheckIssuesExist']>>;

    const MAX_ANALYSIS_RETRIES = 2;
    const ANALYSIS_RETRY_DELAY_MS = [15_000, 30_000];
    const MIN_BATCH_SIZE_TO_SPLIT = 2;
    /** Reduced batch limits for retry after 500 — must be strictly smaller than initial (fewer issues + lower context cap) so prompt size never increases on retry. */
    const REDUCED_MAX_CONTEXT_CHARS = 50_000;
    const REDUCED_MAX_ISSUES_PER_BATCH = 5;

    type BatchOverrides = { maxContextChars?: number; maxIssuesPerBatch?: number };

    async function runBatchWithRetry(input: BatchInputItem[], overrides?: BatchOverrides): Promise<BatchCheckResultType> {
      const maxContextChars = overrides?.maxContextChars ?? options.maxContextChars;
      const maxIssuesPerBatch = overrides?.maxIssuesPerBatch;
      for (let attempt = 0; ; attempt++) {
        try {
          return await llm.batchCheckIssuesExist(input, modelContext, maxContextChars, maxIssuesPerBatch, 'batch-verify');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isTransient = /500|502|504|timeout|gateway|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
          if (isTransient && attempt < MAX_ANALYSIS_RETRIES) {
            const delay = ANALYSIS_RETRY_DELAY_MS[attempt] ?? 30_000;
            warn(`Batch analysis failed (attempt ${attempt + 1}/${MAX_ANALYSIS_RETRIES + 1}): ${msg} — retrying in ${delay / 1000}s`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw err;
        }
      }
    }

    function mergeBatchResults(a: BatchCheckResultType, b: BatchCheckResultType): BatchCheckResultType {
      const issues = new Map(a.issues);
      for (const [k, v] of b.issues) issues.set(k, v);
      return {
        issues,
        recommendedModels: a.recommendedModels?.length ? a.recommendedModels : b.recommendedModels,
        modelRecommendationReasoning: a.modelRecommendationReasoning ?? b.modelRecommendationReasoning,
        partial: a.partial || b.partial,
      };
    }

    let batchResult: BatchCheckResultType;
    const reducedOverrides: BatchOverrides = { maxContextChars: REDUCED_MAX_CONTEXT_CHARS, maxIssuesPerBatch: REDUCED_MAX_ISSUES_PER_BATCH };
    try {
      batchResult = await runBatchWithRetry(batchInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /500|502|504|timeout|gateway|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (isTransient && batchInput.length >= MIN_BATCH_SIZE_TO_SPLIT) {
        // First retry with smaller per-batch size (avoids 200k-char prompts that 500)
        try {
          warn(`Batch analysis failed after retries — retrying with smaller batches (max ${REDUCED_MAX_ISSUES_PER_BATCH} issues, ${REDUCED_MAX_CONTEXT_CHARS / 1000}k chars)`);
          batchResult = await runBatchWithRetry(batchInput, reducedOverrides);
        } catch (reduceErr) {
          // Then split input in half and run each with reduced limits
          const mid = Math.ceil(batchInput.length / 2);
          const firstBatchInput = batchInput.slice(0, mid);
          const secondBatchInput = batchInput.slice(mid).map((item, index) => ({
            ...item,
            id: `issue_${mid + index + 1}`,
          }));
          warn(`Batch analysis failed with reduced size — splitting into ${formatNumber(firstBatchInput.length)} + ${formatNumber(secondBatchInput.length)} issues and retrying`);
          let firstResult: BatchCheckResultType;
          try {
            firstResult = await runBatchWithRetry(firstBatchInput, reducedOverrides);
          } catch (firstErr) {
            warn(`Batch analysis failed: ${msg}`);
            throw new Error(`Batch analysis failed (${formatNumber(freshToAnalyze.length)} issues): ${msg}`);
          }
          try {
            const secondResult = await runBatchWithRetry(secondBatchInput, reducedOverrides);
            batchResult = mergeBatchResults(firstResult, secondResult);
          } catch (secondErr) {
            warn(`Second half failed after split — saving partial results (${formatNumber(firstResult.issues.size)}/${formatNumber(freshToAnalyze.length)} issues)`);
            batchResult = { ...firstResult, partial: true };
          }
        }
      } else {
        warn(`Batch analysis failed: ${msg}`);
        throw new Error(`Batch analysis failed (${formatNumber(freshToAnalyze.length)} issues): ${msg}`);
      }
    }

    // Separate model recommendation call after all verification batches (saves tokens vs baking into first batch).
    // Skip when 0 or 1 issue actually to fix — use default rotation; saves ~4s and tokens (output.log audit).
    // WHY: For a single fixable issue the recommendation adds little value; default rotation is sufficient.
    const analyzedIds = new Set(freshToAnalyze.map((item) => item.comment.id));
    const cachedOpenNotInBatch = comments.filter(
      (c) =>
        !Verification.isVerified(stateContext, c.id)
        && !Dismissed.isCommentDismissed(stateContext, c.id)
        && !analyzedIds.has(c.id)
    ).length;
    let toFixFromBatch = 0;
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const r = batchResult.issues.get(batchInput[i].id);
      if (r?.exists && !Verification.isVerified(stateContext, freshToAnalyze[i].comment.id)) toFixFromBatch++;
    }
    const toFixCount = toFixFromBatch + cachedOpenNotInBatch;
    if (toFixCount >= 5 && (modelContext?.availableModels?.length ?? 0) > 1) {
      const summaryLines = [...batchResult.issues.entries()].map(([id, r]) => {
        const triage = r.exists ? ` I${r.importance} D${r.ease}` : '';
        const snippet = r.explanation.slice(0, 200).replace(/\n/g, ' ');
        return `${id}: ${r.exists ? 'YES' : r.stale ? 'STALE' : 'NO'}${triage} | ${snippet}`;
      });
      // Audit: recommender didn't account for prompt size; 94k prompt timed out. Rough estimate: ~5k chars per issue + header.
      const estimatedFixPromptChars = toFixCount * 5000 + 20000;
      const modelContextWithEstimate = { ...modelContext, estimatedFixPromptChars };
      try {
        const rec = await llm.getModelRecommendationOnly(summaryLines.join('\n'), modelContextWithEstimate);
        if (rec.recommendedModels?.length) {
          batchResult = {
            ...batchResult,
            recommendedModels: rec.recommendedModels,
            modelRecommendationReasoning: rec.reasoning,
          };
        }
      } catch (recErr) {
        debug('Model recommendation call failed', recErr);
      }
    }

    const results = batchResult.issues;
    debug('Batch analysis results', { count: results.size });

    // Store model recommendation for use in fix loop
    if (batchResult.recommendedModels?.length) {
      recommendedModels = batchResult.recommendedModels;
      recommendedModelIndex = 0;
      modelRecommendationReasoning = batchResult.modelRecommendationReasoning;
      console.log(chalk.cyan(`  📊 Model recommendation: ${recommendedModels.join(', ')}`));
      // Only show reasoning when it looks like real explanation, not the literal prompt phrase
      const reasoning = modelRecommendationReasoning?.trim();
      if (reasoning && reasoning.length > 40 && !/explain why these models in this order/i.test(reasoning)) {
        console.log(chalk.gray(`     (${reasoning})`));
      }
    }

    // Process results
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const { comment, codeSnippet, contextHints, resolvedPath } = freshToAnalyze[i];
      // Use widened snippet from batch input when we expanded for a11y or short snippet (fixer gets same context as analyzer).
      const snippetForFix = batchInput[i]?.codeSnippet ?? codeSnippet;
      const issueId = batchInput[i].id.toLowerCase();
      const result = results.get(issueId);

      if (!result) {
        // If LLM didn't return a result for this, assume it still exists
        warn(`No result for comment ${issueId}, assuming unresolved`);
        
        // Don't cache: LLM failure, next iteration should retry
        
        // Check if this is a canonical issue with duplicates
        const duplicates = dedupResult.duplicateMap.get(comment.id);
        const mergedDuplicates = duplicates?.map(dupId => {
          const dupItem = dedupResult.duplicateItems.get(dupId);
          return dupItem ? {
            commentId: dupItem.comment.id,
            author: dupItem.comment.author,
            body: dupItem.comment.body,
            path: dupItem.comment.path,
            line: dupItem.comment.line,
          } : null;
        }).filter((d): d is NonNullable<typeof d> => d !== null);

        unresolved.push({
          comment,
          codeSnippet: snippetForFix,
          stillExists: true,
          explanation: 'Unable to determine status',
          triage: { importance: 3, ease: 3 },  // Default: fallback path
          mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, snippetForFix, undefined),
          resolvedPath,
        });
        continue;
      }

      // Post-STALE grep: if LLM said STALE and named a symbol, check if that symbol is still in the file
      let effectiveResult = result;
      if (result.stale) {
        const symbols = extractSymbolsFromStaleExplanation(result.explanation);
        const primaryPath = resolvedPath ?? comment.path;
        for (const sym of symbols) {
          if (await fileContainsSymbol(workdir, primaryPath, sym)) {
            debug(`Post-STALE grep: "${sym}" found in ${primaryPath}, overriding STALE→YES`);
            effectiveResult = {
              ...result,
              stale: false,
              exists: true,
              explanation: `${result.explanation} [Override: symbol "${sym}" still present in file]`,
            };
            break;
          }
        }
      }

      // Persist comment status
      const fHash = fileHashes.get(comment.path) || '__missing__';
      if (effectiveResult.stale) {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'stale', effectiveResult.explanation, comment.path, fHash);
        propagateStatusToDuplicates(stateContext, comment.id, dedupResult, fileHashes, { kind: 'resolved', classification: 'stale', explanation: effectiveResult.explanation });
      } else if (effectiveResult.exists) {
        CommentStatusAPI.markOpen(stateContext, comment.id, 'exists', effectiveResult.explanation, effectiveResult.importance ?? 3, effectiveResult.ease ?? 3, comment.path, fHash);
        propagateStatusToDuplicates(stateContext, comment.id, dedupResult, fileHashes, { kind: 'open', classification: 'exists', explanation: effectiveResult.explanation, importance: effectiveResult.importance ?? 3, ease: effectiveResult.ease ?? 3 });
      } else {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'fixed', effectiveResult.explanation, comment.path, fHash);
        propagateStatusToDuplicates(stateContext, comment.id, dedupResult, fileHashes, { kind: 'resolved', classification: 'fixed', explanation: effectiveResult.explanation });
      }

      if (effectiveResult.stale) {
        // Issue is stale (code fundamentally restructured) - dismiss without marking verified
        if (validateDismissalExplanation(effectiveResult.explanation, comment.path, comment.line)) {
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            effectiveResult.explanation,
            'stale',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          warn(`Stale issue missing valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet: snippetForFix,
            stillExists: true,
            explanation: 'LLM indicated issue is stale, but provided insufficient explanation',
            triage: { importance: effectiveResult.importance, ease: effectiveResult.ease },
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, snippetForFix, effectiveResult.explanation),
            resolvedPath,
          });
        }
      } else if (effectiveResult.exists) {
        // Stale re-check: batch said "still exists" — if comment was previously verified, unmark so it re-enters the fix queue.
        // WHY: output.log audit — push iter 2 had 2 unresolved (reporting.py) but "All 2 already verified — skipping fixer"
        // because they stayed in verifiedFixed; re-check had correctly said stillExists but we never unmarked.
        if (Verification.isVerified(stateContext, comment.id)) {
          if (recoveredSet?.has(comment.id)) {
            debug('Skipping unmark (recovered from git this run)', { commentId: comment.id, path: comment.path });
          } else {
            Verification.unmarkVerified(stateContext, comment.id);
            debug('Unmarked verified (stale re-check said still exists)', { commentId: comment.id, path: comment.path });
          }
        }
        // Check if this is a canonical issue with duplicates
        const duplicates = dedupResult.duplicateMap.get(comment.id);
        const mergedDuplicates = duplicates?.map(dupId => {
          const dupItem = dedupResult.duplicateItems.get(dupId);
          return dupItem ? {
            commentId: dupItem.comment.id,
            author: dupItem.comment.author,
            body: dupItem.comment.body,
            path: dupItem.comment.path,
            line: dupItem.comment.line,
          } : null;
        }).filter((d): d is NonNullable<typeof d> => d !== null);

        unresolved.push({
          comment,
          codeSnippet: snippetForFix,
          stillExists: true,
          explanation: effectiveResult.explanation,
          triage: { importance: effectiveResult.importance, ease: effectiveResult.ease },
          mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, snippetForFix, effectiveResult.explanation),
          resolvedPath,
        });
      } else {
        // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
        if (validateDismissalExplanation(effectiveResult.explanation, comment.path, comment.line)) {
          // Valid explanation - document why it doesn't need fixing
          Verification.markVerified(stateContext, comment.id);
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            effectiveResult.explanation,
            'already-fixed',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          // Invalid/missing explanation - treat as unresolved (potential bug)
          warn(`Cannot dismiss without valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet: snippetForFix,
            stillExists: true,
            explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
            triage: { importance: effectiveResult.importance, ease: effectiveResult.ease },
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, snippetForFix, effectiveResult.explanation),
            resolvedPath,
          });
        }
      }
    }

    if (batchResult.partial) {
      await State.saveState(stateContext);
      await LessonsAPI.Save.save(lessonsContext);
      throw new Error(
        `Batch analysis incomplete: ${formatNumber(results.size)}/${formatNumber(freshToAnalyze.length)} issues analyzed (partial results saved - re-run to continue)`
      );
    }
  }

  const unresolvedAfterBlast = applyBlastRadiusToUnresolved(
    unresolved,
    findUnresolvedIssuesOptions?.blastRadius,
    stateContext
  );
  await State.saveState(stateContext);
  await LessonsAPI.Save.save(lessonsContext);
  if (options.verbose) {
    printDebugIssueTable('after analysis', comments, stateContext, unresolvedAfterBlast);
  }

  return {
    unresolved: unresolvedAfterBlast,
    recommendedModels,
    recommendedModelIndex,
    modelRecommendationReasoning,
    duplicateMap: dedupResult.duplicateMap,
  };
}
