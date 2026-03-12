/**
 * Execute single fix iteration
 * 
 * Core fix iteration workflow:
 * 1. Run fixer tool with prompt
 * 2. Handle fixer errors
 * 3. If no changes → verification workflow
 * 4. If changes → continue to verification
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import { getIssuePrimaryPath, type UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { Runner } from '../../../shared/runners/types.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase, addTokenUsage, getState } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import type { CLIOptions } from '../cli.js';
import ora from 'ora';
import { createHash } from 'crypto';
import { debug, debugStep, startTimer, endTimer, formatDuration } from '../../../shared/logger.js';
import { hasChanges } from '../../../shared/git/git-clone-index.js';
import * as ResolverProc from '../resolver-proc.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { parseResultCode } from './utils.js';
import { stripPrrFromDiffStat } from './bot-prediction-llm.js';
import { tryRestoreFromBaseIfRequested } from './restore-from-base.js';
import { getMentionedTestFilePaths, getMigrationJournalPath, getConsolidateDuplicateTargetPath, getDocumentationPathFromComment, getImplPathForTestFileIssue, getPathsToDeleteFromComment, getReferencedFullPathFromComment, getRenameTargetPath, getSiblingFilePathsFromComment, getTestPathForSourceFileIssue, issueRequestsTests, reviewSuggestsFixInTest, reviewTargetsMentionedTestFile } from '../analyzer/prompt-builder.js';
import { filterAllowedPathsForFix } from '../../../shared/path-utils.js';
import { HALLUCINATION_DISMISS_THRESHOLD } from '../../../shared/constants.js';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import { assessSolvability } from './helpers/solvability.js';

// Track the last prompt+model combination to detect identical retries.
// WHY: When a fixer returns "no changes" and no new lessons are added,
// the next iteration generates the exact same prompt for the same model.
// Re-running it is guaranteed to fail again — skip straight to rotation.
let lastPromptKey: string | null = null;

/** Reset the duplicate prompt tracker (call after model/tool rotation). */
export function resetPromptTracker(): void {
  lastPromptKey = null;
}

/** Add file-scoped lessons and state when fixer attempted disallowed files (success or failure path). M2: one consolidated lesson instead of one per path to avoid prompt bloat. */
function addDisallowedFilesLessonsAndState(
  skippedDisallowedFiles: string[],
  issuesForPrompt: UnresolvedIssue[],
  allowedPathsForBatch: string[],
  lessonsContext: LessonsContext,
  stateContext: StateContext
): void {
  const allowedStr = allowedPathsForBatch.slice(0, 5).join(', ') + (allowedPathsForBatch.length > 5 ? ` (+${allowedPathsForBatch.length - 5} more)` : '');
  LessonsAPI.Add.addGlobalLesson(
    lessonsContext,
    `Fixer attempted disallowed file(s): ${skippedDisallowedFiles.join(', ')}. Only edit the file(s) listed in TARGET FILE(S): ${allowedStr}.`
  );
  if (stateContext.state) {
    const state = stateContext.state;
    if (!state.wrongFileLessonCountByCommentId) state.wrongFileLessonCountByCommentId = {};
    for (const issue of issuesForPrompt) {
      state.wrongFileLessonCountByCommentId[issue.comment.id] = (state.wrongFileLessonCountByCommentId[issue.comment.id] ?? 0) + 1;
    }
    const testFilePattern = /__tests__|\.(test|spec)\.(ts|js)$/i;
    function isPlausibleTestPathForIssue(attemptedPath: string, issuePath: string): boolean {
      const issueFirst = issuePath.split('/')[0];
      const attemptedFirst = attemptedPath.split('/')[0];
      if (issueFirst !== attemptedFirst) return false;
      const issueStem = basename(issuePath).replace(/\.(ts|tsx|js|jsx)$/i, '');
      const attemptedStem = basename(attemptedPath).replace(/\.(test|spec)\.(ts|js)$/i, '');
      return issueStem === attemptedStem;
    }
    for (const issue of issuesForPrompt) {
      const wantsTestPath = issueRequestsTests(issue) || reviewSuggestsFixInTest(issue.comment.body ?? '') || reviewTargetsMentionedTestFile(issue.comment.body ?? '');
      if (!wantsTestPath) continue;
      const inferredTestPaths = [
        ...getMentionedTestFilePaths(issue, { attemptedPaths: skippedDisallowedFiles }),
        ...(() => {
          const testPath = getTestPathForSourceFileIssue(issue, { forceTestPath: wantsTestPath });
          return testPath ? [testPath] : [];
        })(),
      ].filter((p, idx, arr) => Boolean(p) && arr.indexOf(p) === idx);
      if (inferredTestPaths.some((p) => allowedPathsForBatch.includes(p))) continue;
      const attemptedTestPath = skippedDisallowedFiles.find(
        (p) => testFilePattern.test(p) && isPlausibleTestPathForIssue(p, issue.comment.path)
      );
      if (!attemptedTestPath) continue;
      if (!state.wrongFileAllowedPathsByCommentId) state.wrongFileAllowedPathsByCommentId = {};
      const existing = state.wrongFileAllowedPathsByCommentId[issue.comment.id] ?? [];
      if (!existing.includes(attemptedTestPath)) {
        state.wrongFileAllowedPathsByCommentId[issue.comment.id] = [...existing, attemptedTestPath];
        debug('Allow test file on retry (fixer attempted)', { commentId: issue.comment.id, path: attemptedTestPath });
      }
    }
  }
}

/**
 * Execute one fix iteration (prompt build + fixer run + result handling)
 * 
 * WORKFLOW:
 * 1. Build fix prompt with lessons + PR context
 * 2. Run fixer tool
 * 3. Handle errors (rapid failure detection, exit on critical)
 * 4. If no changes → run verification workflow or rotation
 * 5. If changes → return for verification
 * 
 * NOTE on `prInfo` position: This function has 17+ positional parameters
 * (a known debt). `prInfo` is placed after `options` (CLIOptions) and before
 * `verifiedThisSession` (Set<string>). These three types are all distinct
 * (PRInfo vs CLIOptions vs Set), so accidental swaps are caught by tsc.
 * An options object refactor is planned but was deferred to keep this change
 * minimal and safe.
 * 
 * @returns Control flow and updated state
 */
export async function executeFixIteration(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  git: SimpleGit,
  workdir: string,
  runner: Runner,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  options: CLIOptions,
  openaiApiKey: string | undefined,
  prInfo: PRInfo,
  verifiedThisSession: Set<string>,
  rapidFailureCount: number,
  lastFailureTime: number,
  consecutiveFailures: number,
  modelFailuresInCycle: number,
  progressThisCycle: number,
  getCurrentModel: () => string | undefined,
  parseNoChangesExplanation: (output: string) => string | null,
  trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verified?: Set<string>) => Promise<boolean>,
  tryRotation: (failureErrorType?: string) => boolean,
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verified?: Set<string>) => Promise<boolean>,
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>,
  /** Current fix iteration (1-based). When 1, use conservative prompt cap to avoid timeout (audit). */
  fixIteration: number,
  onDisableRunner?: (runnerName: string) => void
): Promise<{
  shouldContinue: boolean;
  shouldBreak: boolean;
  shouldExit: boolean;
  allFixed: boolean;
  updatedRapidFailureCount: number;
  updatedLastFailureTime: number;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
  exitReason?: string;
  exitDetails?: string;
  lessonsBeforeFix: number;
  /** True when duplicate prompt was skipped (caller should not count this as an iteration). */
  skippedDuplicatePrompt?: boolean;
}> {
  const spinner = ora();

  // H3 (output.log audit): Dismiss issues whose file has accumulated too many S/R or hallucinated-stub failures.
  let workingUnresolved = unresolvedIssues;
  const runnerWithCounts = runner as { getFailureCounts?: () => Map<string, number> };
  if (typeof runnerWithCounts.getFailureCounts === 'function') {
    const failureCounts = runnerWithCounts.getFailureCounts();
    const dismissedIds = new Set<string>();
    for (const issue of workingUnresolved) {
      if ((failureCounts.get(issue.comment.path) ?? 0) >= HALLUCINATION_DISMISS_THRESHOLD) {
        Dismissed.dismissIssue(
          stateContext,
          issue.comment.id,
          'Repeated failed fix attempts (output did not match file); manual review recommended.',
          'remaining',
          issue.comment.path,
          issue.comment.line,
          issue.comment.body
        );
        dismissedIds.add(issue.comment.id);
      }
    }
    if (dismissedIds.size > 0) {
      workingUnresolved = workingUnresolved.filter((i) => !dismissedIds.has(i.comment.id));
      debug('H3: dismissed issues after repeated S/R failures', { count: dismissedIds.size, ids: [...dismissedIds] });
    }
  }

  // Re-run deterministic solvability immediately before prompt building.
  // WHY: New comments, cached unresolved issues, or changed repo state can let a now-unsolvable
  // item slip into the queue. Dismissing here prevents burning a full model rotation on noise.
  if (workingUnresolved.length > 0) {
    const dismissedIds = new Set<string>();
    for (const issue of workingUnresolved) {
      const solvability = assessSolvability(workdir, issue.comment, stateContext);
      if (solvability.solvable) continue;
      const primaryPath = getIssuePrimaryPath(issue);
      Dismissed.dismissIssue(
        stateContext,
        issue.comment.id,
        solvability.reason ?? 'Not solvable',
        solvability.dismissCategory ?? 'not-an-issue',
        primaryPath,
        issue.comment.line,
        issue.comment.body,
        solvability.remediationHint
      );
      dismissedIds.add(issue.comment.id);
    }
    if (dismissedIds.size > 0) {
      workingUnresolved = workingUnresolved.filter((i) => !dismissedIds.has(i.comment.id));
      debug('Dismissed unsolvable issues before fixer run', { count: dismissedIds.size, ids: [...dismissedIds] });
    }
  }
  if (workingUnresolved.length === 0) {
    return {
      shouldContinue: false,
      shouldBreak: false,
      shouldExit: false,
      allFixed: true,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle,
      updatedUnresolvedIssues: [],
      lessonsBeforeFix: 0,
    };
  }

  // Build fix prompt with adaptive batch sizing.
  // WHY: consecutiveFailures drives batch size reduction (50→25→12→6→5) so the model
  // gets fewer issues per prompt when it's struggling. Resets to MAX on any success.
  debugStep('GENERATING FIX PROMPT');
  // WHY merge allowed paths: When fixer returned CANNOT_FIX/WRONG_LOCATION and mentioned another file, we persisted it in wrongFileAllowedPathsByCommentId; merging here lets the fixer edit the correct file on this attempt.
  const allowedPathsByComment = stateContext.state?.wrongFileAllowedPathsByCommentId;
  const mergedIssues = allowedPathsByComment
    ? workingUnresolved.map((issue) => {
        const extra = allowedPathsByComment[issue.comment.id];
        if (!extra?.length) return issue;
        const base = issue.allowedPaths?.length ? issue.allowedPaths : [issue.comment.path];
        const merged = [...new Set([...base, ...extra])];
        return { ...issue, allowedPaths: merged };
      })
    : workingUnresolved;
  // Exclude already-verified issues from the fix prompt (they stay in unresolvedIssues for re-verification if file changed).
  // WHY: Avoids sending them to the fixer and wasting tokens; verifyFixes still re-checks them when their file is in changedFiles.
  // Exclude issues the fixer already said ALREADY_FIXED 2+ times (P3 prompts.log audit).
  // WHY: Batch prompts were re-including these; the fixer would again return ALREADY_FIXED and we'd burn a 64k+ char prompt. Filter at 2 so we stop sending before dismissal at 3.
  const alreadyFixedCount = stateContext.state?.consecutiveAlreadyFixedAnyByCommentId;
  const issuesForPrompt = mergedIssues.filter((i) => {
    if (Verification.isVerified(stateContext, i.comment.id)) return false;
    const n = alreadyFixedCount?.[i.comment.id] ?? 0;
    if (n >= 2) return false;
    return true;
  });
  // Run git diff ourselves so the fixer sees what this PR changes; no need for tools to run it.
  let diffStat: string | undefined;
  try {
    const baseRef = `origin/${prInfo.baseBranch}`;
    diffStat = await git.raw(['diff', `${baseRef}...HEAD`, '--stat']);
    if (diffStat) diffStat = stripPrrFromDiffStat(diffStat);
  } catch {
    // Base ref may not exist (e.g. first push); prompt still works without diff.
  }
  // WHY forceNextBatchSizeReduce: When the previous attempt had a huge prompt (>200k) and failed, we want the next
  // attempt to use a smaller batch immediately (effectiveConsecutive ≥ 2) without waiting for two real failures.
  const effectiveConsecutive = stateContext.forceNextBatchSizeReduce
    ? Math.max(consecutiveFailures, 2)
    : consecutiveFailures;
  if (stateContext.forceNextBatchSizeReduce) {
    stateContext.forceNextBatchSizeReduce = false;
    debug('Using reduced batch size after large-prompt failure', { effectiveConsecutive, consecutiveFailures });
  }
  // Per-model prompt cap: builder uses modelContext to limit prompt size for models with smaller context windows.
  const currentModelForCap = getCurrentModel();
  const modelContext =
    runner.provider && currentModelForCap
      ? { provider: runner.provider, model: currentModelForCap }
      : undefined;
  const pathExists = (p: string) => existsSync(join(workdir, p));
  const promptDetails = ResolverProc.buildAndDisplayFixPrompt(
    issuesForPrompt,
    lessonsContext,
    options.verbose,
    effectiveConsecutive,
    options.priorityOrder,
    prInfo,
    diffStat,
    comments,
    runner.name,
    undefined,
    modelContext,
    pathExists,
    fixIteration === 1
  );
  
  if (promptDetails.shouldSkip) {
    if (workingUnresolved.length > 0) {
      console.log(chalk.gray(`  All ${workingUnresolved.length} issue(s) in queue already verified — skipping fixer.`));
    }
    return {
      shouldContinue: false,
      shouldBreak: false,
      shouldExit: false,
      allFixed: true,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: consecutiveFailures,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle,
      updatedUnresolvedIssues: workingUnresolved,
      lessonsBeforeFix: promptDetails.lessonsBeforeFix,
    };
  }
  
  const { prompt, lessonsBeforeFix } = promptDetails;
  const currentModel = getCurrentModel();

  // Detect identical prompt+model retries — skip straight to rotation.
  // WHY issue IDs + lesson count: Full-prompt hash rarely matched (wording/formatting drift).
  // Hashing sorted issue IDs and lessonsBeforeFix detects "same issues, same context" and
  // avoids redundant LLM calls; we rotate to the next model instead of re-running the same call.
  const sortedIds = workingUnresolved.map(i => i.comment.id).sort().join(',');
  const promptKey = createHash('md5')
    .update(`${runner.name}:${currentModel || ''}:${sortedIds}:${lessonsBeforeFix}`)
    .digest('hex');

  if (promptKey === lastPromptKey) {
    console.log(chalk.yellow(`\n  ⚡ Same prompt+model as last iteration (no new lessons/context)`));
    console.log(chalk.yellow(`  → Skipping to rotation instead of re-running`));
    debug('Duplicate prompt detected, skipping to rotation', {
      tool: runner.name, model: currentModel, promptLength: prompt.length,
    });
    lastPromptKey = null; // Reset so the ROTATED model gets a fair shot

    // Count as failure and trigger rotation
    const updatedConsecutiveFailures = consecutiveFailures + 1;
    const updatedModelFailuresInCycle = modelFailuresInCycle + 1;

    const rotationResult = await ResolverProc.handleRotationStrategy(
      workingUnresolved, comments, git,
      updatedConsecutiveFailures, updatedModelFailuresInCycle, progressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession,
      runner.name, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut
    );

    return {
      shouldContinue: !rotationResult.shouldBreak,
      shouldBreak: rotationResult.shouldBreak,
      shouldExit: false,
      allFixed: false,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: rotationResult.updatedConsecutiveFailures,
      updatedModelFailuresInCycle: rotationResult.updatedModelFailuresInCycle,
      updatedProgressThisCycle: rotationResult.updatedProgressThisCycle,
      updatedUnresolvedIssues: rotationResult.updatedUnresolvedIssues,
      lessonsBeforeFix,
      skippedDuplicatePrompt: true,
    };
  }
  lastPromptKey = promptKey;

  // Run fixer tool
  debugStep('RUNNING FIXER TOOL');
  setPhase(stateContext, 'fixing');
  startTimer('Run fixer');
  spinner.start(`Running ${runner.name} to fix issues...`);
   
   debug('Executing runner', { tool: runner.name, workdir, model: currentModel });
   const codexAddDirs = [...(options.codexAddDir ?? [])];
  // Pass OpenAI key explicitly so Codex gets it even when config came from env and runner spawns with a copy of process.env
  const keyForRunner = openaiApiKey ?? process.env.OPENAI_API_KEY;
  // Union of allowed paths so runner can skip change blocks targeting wrong files.
  // WHY: Must mirror prompt-builder expansion (journal, consolidate-duplicate, test-impl, fix-in-test) or the
  // runner rejects edits the prompt asked for (e.g. _journal.json for Drizzle migrations) as "disallowed file".
  const allowedPathsForBatch = filterAllowedPathsForFix(Array.from(new Set(issuesForPrompt.flatMap((i) => {
    const primaryPath = i.resolvedPath ?? i.comment.path;
    const base = i.allowedPaths?.length ? [...i.allowedPaths] : [primaryPath];
    const journal = getMigrationJournalPath(i);
    if (journal && !base.includes(journal)) base.push(journal);
    const consolidate = getConsolidateDuplicateTargetPath(i);
    if (consolidate && !base.includes(consolidate)) base.push(consolidate);
    const referencedFull = getReferencedFullPathFromComment(i);
    if (referencedFull && !base.includes(referencedFull)) base.push(referencedFull);
    const docPath = getDocumentationPathFromComment(i);
    if (docPath && !base.includes(docPath)) base.push(docPath);
    const renameTarget = getRenameTargetPath(i);
    if (renameTarget && !base.includes(renameTarget)) base.push(renameTarget);
    for (const sibling of getSiblingFilePathsFromComment(i)) {
      if (!base.includes(sibling)) base.push(sibling);
    }
    for (const p of getPathsToDeleteFromComment(i)) {
      if (!base.includes(p)) base.push(p);
    }
    const impl = getImplPathForTestFileIssue(i, undefined);
    if (impl && !base.includes(impl)) base.push(impl);
    const forceTestPath = reviewSuggestsFixInTest(i.comment.body ?? '');
    const testPath = getTestPathForSourceFileIssue(i, { pathExists, forceTestPath });
    if (testPath && !base.includes(testPath)) base.push(testPath);
    if (issueRequestsTests(i) || forceTestPath) {
      const srcPath = i.resolvedPath ?? i.comment.path ?? '';
      if (/\.(?:ts|tsx|js|jsx)$/.test(srcPath)) {
        const testBase = srcPath.replace(/^.*\//, '').replace(/\.(ts|tsx|js|jsx)$/, '.test.$1');
        const testsRootPath = `__tests__/${testBase}`;
        if (!base.includes(testsRootPath)) base.push(testsRootPath);
      }
    }
    for (const hiddenTestPath of getMentionedTestFilePaths(i, { pathExists })) {
      if (!base.includes(hiddenTestPath)) base.push(hiddenTestPath);
    }
    return base;
  }))));

  let result;
   try {
     result = await runner.run(workdir, prompt, {
       model: currentModel,
       codexAddDirs,
       openaiApiKey: keyForRunner,
       unresolvedIssues: workingUnresolved,
       allowedPathsForBatch,
       allowedPathsForInjection: allowedPathsForBatch,
     });
   } finally {
     spinner.stop();
   }
  const fixerTime = endTimer('Run fixer');
  if (result.usage) {
    addTokenUsage(stateContext, result.usage);
  }
  debug('Runner result', { success: result.success, error: result.error, duration: fixerTime });

  if (!result.success) {
    // Restore-from-base heuristic: when fixer says file corrupted / restore from base, do it and treat as change.
    if (result.error && /search\/replace operations failed|search text did not match/i.test(result.error)) {
      const restored = await tryRestoreFromBaseIfRequested(
        git,
        workdir,
        prInfo.baseBranch,
        result.output || '',
        workingUnresolved
      );
      if (restored && (await hasChanges(git))) {
        console.log(chalk.cyan(`  Restored ${restored} from base; will verify next.`));
        return {
          shouldContinue: false,
          shouldBreak: false,
          shouldExit: false,
          allFixed: false,
          updatedRapidFailureCount: rapidFailureCount,
          updatedLastFailureTime: lastFailureTime,
          updatedConsecutiveFailures: consecutiveFailures,
          updatedModelFailuresInCycle: modelFailuresInCycle,
          updatedProgressThisCycle: progressThisCycle,
          updatedUnresolvedIssues: workingUnresolved,
          lessonsBeforeFix,
        };
      }
    }
    // When search/replace failed to match, add file-specific lessons so next run uses exact content, narrower anchor, or full-file rewrite.
    if (result.error && /search\/replace operations failed|search text did not match/i.test(result.error)) {
      const paths = [...new Set(workingUnresolved.map((i) => i.comment.path))];
      for (const path of paths) {
        const one = workingUnresolved.find((i) => i.comment.path === path);
        if (one) {
          LessonsAPI.Add.addLesson(
            lessonsContext,
            `Fix for ${path}:${one.comment.line ?? '?'} - Search/replace failed to match; use exact file content, a shorter <search> block (3–5 lines that uniquely match the location), or full-file rewrite`
          );
        }
      }
    }
    // Strict allowlist failure: fixer attempted only disallowed files — add file-scoped lesson and state.
    if (result.skippedDisallowedFiles?.length) {
      addDisallowedFilesLessonsAndState(result.skippedDisallowedFiles, issuesForPrompt, allowedPathsForBatch, lessonsContext, stateContext);
    }
    if (result.skippedNewfilePathExists?.length) {
      const pathList = result.skippedNewfilePathExists.join(', ');
      LessonsAPI.Add.addGlobalLesson(lessonsContext, `File(s) already exist: ${pathList}. Use <change path="..."> to edit, not <newfile> (overwriting would destroy existing content).`);
    }
    const errorResult = ResolverProc.handleFixerError(result, runner, fixerTime, rapidFailureCount, lastFailureTime, stateContext, getCurrentModel);
    
    if (errorResult.shouldExit) {
      return {
        shouldContinue: false,
        shouldBreak: false,
        shouldExit: true,
        allFixed: false,
        updatedRapidFailureCount: errorResult.rapidFailureCount,
        updatedLastFailureTime: errorResult.lastFailureTime,
        updatedConsecutiveFailures: consecutiveFailures,
        updatedModelFailuresInCycle: modelFailuresInCycle,
        updatedProgressThisCycle: progressThisCycle,
        updatedUnresolvedIssues: workingUnresolved,
        lessonsBeforeFix,
      };
    }

    // Tool-level failure (e.g. tool_config): disable this runner for rest of run so we don't retry it
    if (errorResult.skipRunnerForRun) {
      onDisableRunner?.(runner.name);
    }

    // Non-fatal fixer error: increment failure counters and trigger rotation.
    // WHY: Previously, fixer errors returned shouldContinue without incrementing
    // consecutiveFailures or triggering rotation, causing the same tool/model to
    // be retried indefinitely. Now we treat it like a "no changes" failure.
    const updatedConsecutiveFailures = consecutiveFailures + 1;
    const updatedModelFailuresInCycle = modelFailuresInCycle + 1;
    // WHY: Oversized prompts cause 500s/timeouts; next iteration should use smaller batch without waiting for two real failures.
    if (prompt.length > 200_000) {
      stateContext.forceNextBatchSizeReduce = true;
      debug('Large prompt failed (error path) — will reduce batch size next iteration', { promptLength: prompt.length, threshold: 200_000 });
    }

    const rotationResult = await ResolverProc.handleRotationStrategy(
      workingUnresolved, comments, git,
      updatedConsecutiveFailures, updatedModelFailuresInCycle, progressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession, runner.name,
      trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut,
      result.errorType
    );
    
    return {
      shouldContinue: !rotationResult.shouldBreak,
      shouldBreak: rotationResult.shouldBreak,
      shouldExit: false,
      allFixed: false,
      updatedRapidFailureCount: errorResult.rapidFailureCount,
      updatedLastFailureTime: errorResult.lastFailureTime,
      updatedConsecutiveFailures: rotationResult.updatedConsecutiveFailures,
      updatedModelFailuresInCycle: rotationResult.updatedModelFailuresInCycle,
      updatedProgressThisCycle: rotationResult.updatedProgressThisCycle,
      updatedUnresolvedIssues: rotationResult.updatedUnresolvedIssues,
      lessonsBeforeFix,
    };
  }
  
  console.log(chalk.gray(`\n  Fixer completed in ${formatDuration(fixerTime)}`));

  // Strict allowlist: fixer also attempted disallowed files — add file-scoped lesson and state.
  if (result.skippedDisallowedFiles?.length) {
    addDisallowedFilesLessonsAndState(result.skippedDisallowedFiles, issuesForPrompt, allowedPathsForBatch, lessonsContext, stateContext);
  }
  if (result.skippedNewfilePathExists?.length) {
    const pathList = result.skippedNewfilePathExists.join(', ');
    LessonsAPI.Add.addGlobalLesson(lessonsContext, `File(s) already exist: ${pathList}. Use <change path="..."> to edit, not <newfile> (overwriting would destroy existing content).`);
  }

  // Placeholder test content (e.g. expect(true).toBe(true)): add lesson and treat as non-fix so we rotate without counting as success.
  if (result.placeholderTestContent) {
    LessonsAPI.Add.addGlobalLesson(lessonsContext, 'Tests must implement real assertions and behavior, not placeholder expectations like expect(true).toBe(true). Add actual test logic that exercises the code under test.');
    console.log(chalk.yellow('\n  Fixer wrote placeholder test content — skipping verification and rotating'));
    const updatedConsecutiveFailures = consecutiveFailures + 1;
    const updatedModelFailuresInCycle = modelFailuresInCycle + 1;
    const rotationResult = await ResolverProc.handleRotationStrategy(
      workingUnresolved, comments, git,
      updatedConsecutiveFailures, updatedModelFailuresInCycle, progressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession, runner.name,
      trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut,
      undefined
    );
    return {
      shouldContinue: !rotationResult.shouldBreak,
      shouldBreak: rotationResult.shouldBreak,
      shouldExit: false,
      allFixed: false,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: rotationResult.updatedConsecutiveFailures,
      updatedModelFailuresInCycle: rotationResult.updatedModelFailuresInCycle,
      updatedProgressThisCycle: rotationResult.updatedProgressThisCycle,
      updatedUnresolvedIssues: rotationResult.updatedUnresolvedIssues,
      lessonsBeforeFix,
    };
  }

  // All changes were no-op (search === replace): skip verification and treat as no changes for rotation.
  // WHY: handleNoChangesWithVerification would run an LLM call to parse ALREADY_FIXED etc.; when we know all changes were no-ops there's nothing to verify, so we skip that call and go straight to rotation.
  if (result.noMeaningfulChanges) {
    console.log(chalk.yellow('\n  All fixer changes were no-ops (no files modified) — skipping verification'));
    const updatedConsecutiveFailures = consecutiveFailures + 1;
    const updatedModelFailuresInCycle = modelFailuresInCycle + 1;
    if (prompt.length > 200_000) {
      stateContext.forceNextBatchSizeReduce = true;
      debug('Large prompt produced only no-ops — will reduce batch size next iteration', { promptLength: prompt.length, threshold: 200_000 });
    }
    const rotationResult = await ResolverProc.handleRotationStrategy(
      workingUnresolved, comments, git,
      updatedConsecutiveFailures, updatedModelFailuresInCycle, progressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession, runner.name,
      trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut,
      result.usedFullFileRewrite ? 'full_rewrite_no_diff' : undefined
    );
    return {
      shouldContinue: !rotationResult.shouldBreak,
      shouldBreak: rotationResult.shouldBreak,
      shouldExit: false,
      allFixed: false,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: rotationResult.updatedConsecutiveFailures,
      updatedModelFailuresInCycle: rotationResult.updatedModelFailuresInCycle,
      updatedProgressThisCycle: rotationResult.updatedProgressThisCycle,
      updatedUnresolvedIssues: rotationResult.updatedUnresolvedIssues,
      lessonsBeforeFix,
    };
  }

  // Check for changes
  if (!(await hasChanges(git))) {
    // Handle no-changes scenario with verification
    const noChangesResult = await ResolverProc.handleNoChangesWithVerification(workingUnresolved, runner.name, currentModel, result.output || '', llm, stateContext, lessonsContext, verifiedThisSession, parseNoChangesExplanation, workdir);
    
    let updatedConsecutiveFailures = consecutiveFailures;
    let updatedModelFailuresInCycle = modelFailuresInCycle;
    let updatedProgressThisCycle = progressThisCycle + noChangesResult.progressMade;
    const updatedUnresolvedIssues = noChangesResult.updatedUnresolvedIssues;
    
    // Check control flow signals
    if (noChangesResult.shouldBreak) {
      return {
        shouldContinue: false,
        shouldBreak: true,
        shouldExit: false,
        allFixed: true,
        updatedRapidFailureCount: rapidFailureCount,
        updatedLastFailureTime: lastFailureTime,
        updatedConsecutiveFailures,
        updatedModelFailuresInCycle,
        updatedProgressThisCycle,
        updatedUnresolvedIssues,
        exitReason: 'all_fixed',
        exitDetails: 'All issues verified as already fixed',
        lessonsBeforeFix,
      };
    }
    
    if (noChangesResult.shouldContinue) {
      return {
        shouldContinue: true,
        shouldBreak: false,
        shouldExit: false,
        allFixed: false,
        updatedRapidFailureCount: rapidFailureCount,
        updatedLastFailureTime: lastFailureTime,
        updatedConsecutiveFailures: 0,
        updatedModelFailuresInCycle,
        updatedProgressThisCycle,
        updatedUnresolvedIssues,
        lessonsBeforeFix,
      };
    }
    
    // Count this as a failure for rotation purposes
    updatedConsecutiveFailures++;
    updatedModelFailuresInCycle++;
    const failureErrorType = result.usedFullFileRewrite ? 'full_rewrite_no_diff' : undefined;
    // WHY: Same as error path — large prompt that produced no changes should trigger batch reduce on next attempt.
    if (prompt.length > 200_000) {
      stateContext.forceNextBatchSizeReduce = true;
      debug('Large prompt failed — will reduce batch size next iteration', { promptLength: prompt.length, threshold: 200_000 });
    }
    // Execute rotation strategy
    const rotationResult = await ResolverProc.handleRotationStrategy(updatedUnresolvedIssues, comments, git, updatedConsecutiveFailures, updatedModelFailuresInCycle, updatedProgressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession, runner.name, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut, failureErrorType);
    
    return {
      shouldContinue: !rotationResult.shouldBreak,
      shouldBreak: rotationResult.shouldBreak,
      shouldExit: false,
      allFixed: false,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: rotationResult.updatedConsecutiveFailures,
      updatedModelFailuresInCycle: rotationResult.updatedModelFailuresInCycle,
      updatedProgressThisCycle: rotationResult.updatedProgressThisCycle,
      updatedUnresolvedIssues: rotationResult.updatedUnresolvedIssues,
      lessonsBeforeFix,
    };
  }

  // WHY NEEDS_DISCUSSION here: When the fixer adds only a // REVIEW: comment (no code change),
  // hasChanges(git) is true but the "fix" isn't something to verify — it's a discussion reply.
  // Treating it as progress (reset consecutive failures, increment progress) avoids running
  // verification on a comment and avoids counting it as a failure. Must live in the "has changes"
  // branch because NEEDS_DISCUSSION implies a file was modified (the comment was added).
  const structuredResult = parseResultCode(result.output || '');
  if (structuredResult?.resultCode === 'NEEDS_DISCUSSION') {
    console.log(chalk.cyan(`  Discussion response: ${structuredResult.resultDetail}`));
    console.log(chalk.gray('  → Code comment added as discussion contribution'));
    return {
      shouldContinue: true,
      shouldBreak: false,
      shouldExit: false,
      allFixed: false,
      updatedRapidFailureCount: rapidFailureCount,
      updatedLastFailureTime: lastFailureTime,
      updatedConsecutiveFailures: 0,
      updatedModelFailuresInCycle: modelFailuresInCycle,
      updatedProgressThisCycle: progressThisCycle + 1,
      updatedUnresolvedIssues: workingUnresolved,
      lessonsBeforeFix,
    };
  }

  // WHY reset here: The fixer made actual file changes, breaking the "no changes" streak.
  // Without this, the counter would carry over from previous no-change iterations and
  // incorrectly count non-consecutive ALREADY_FIXED results as consecutive.
  const stateForReset = getState(stateContext);
  if (stateForReset.consecutiveAlreadyFixedAnyByCommentId) {
    for (const issue of workingUnresolved) {
      delete stateForReset.consecutiveAlreadyFixedAnyByCommentId[issue.comment.id];
    }
  }

  // Has changes - return for verification
  return {
    shouldContinue: false,
    shouldBreak: false,
    shouldExit: false,
    allFixed: false,
    updatedRapidFailureCount: rapidFailureCount,
    updatedLastFailureTime: lastFailureTime,
    updatedConsecutiveFailures: consecutiveFailures,
    updatedModelFailuresInCycle: modelFailuresInCycle,
    updatedProgressThisCycle: progressThisCycle,
    updatedUnresolvedIssues: workingUnresolved,
    lessonsBeforeFix,
  };
}
