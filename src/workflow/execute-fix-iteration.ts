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
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment, PRInfo } from '../github/types.js';
import type { Runner } from '../runners/types.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase, addTokenUsage } from '../state/state-context.js';
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
import { debug, debugStep, startTimer, endTimer, formatDuration } from '../logger.js';
import { hasChanges } from '../git/git-clone-index.js';
import * as ResolverProc from '../resolver-proc.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { parseResultCode } from './utils.js';
import { stripPrrFromDiffStat } from './bot-prediction-llm.js';
import { tryRestoreFromBaseIfRequested } from './restore-from-base.js';

// Track the last prompt+model combination to detect identical retries.
// WHY: When a fixer returns "no changes" and no new lessons are added,
// the next iteration generates the exact same prompt for the same model.
// Re-running it is guaranteed to fail again — skip straight to rotation.
let lastPromptKey: string | null = null;

/** Reset the duplicate prompt tracker (call after model/tool rotation). */
export function resetPromptTracker(): void {
  lastPromptKey = null;
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
}> {
  const spinner = ora();

  // Build fix prompt with adaptive batch sizing.
  // WHY: consecutiveFailures drives batch size reduction (50→25→12→6→5) so the model
  // gets fewer issues per prompt when it's struggling. Resets to MAX on any success.
  debugStep('GENERATING FIX PROMPT');
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
  const promptDetails = ResolverProc.buildAndDisplayFixPrompt(
    unresolvedIssues,
    lessonsContext,
    options.verbose,
    effectiveConsecutive,
    options.priorityOrder,
    prInfo,
    diffStat,
    comments,
    runner.name,
    undefined,
    modelContext
  );
  
  if (promptDetails.shouldSkip) {
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
      updatedUnresolvedIssues: unresolvedIssues,
      lessonsBeforeFix: promptDetails.lessonsBeforeFix,
    };
  }
  
  const { prompt, lessonsBeforeFix } = promptDetails;
  const currentModel = getCurrentModel();

  // Detect identical prompt+model retries — skip straight to rotation.
  // WHY: If the prompt is identical (same issues, same lessons, same model),
  // running the fixer again will produce the same "no changes" result.
  // A lightweight hash avoids storing the full prompt in memory.
  const promptKey = createHash('md5')
    .update(`${runner.name}:${currentModel || ''}:${prompt}`)
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
      unresolvedIssues, comments, git,
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

  let result;
  try {
    result = await   runner.run(workdir, prompt, {
      model: currentModel,
      codexAddDirs,
      openaiApiKey: keyForRunner,
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
        unresolvedIssues
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
          updatedUnresolvedIssues: unresolvedIssues,
          lessonsBeforeFix,
        };
      }
    }
    // When search/replace failed to match, add file-specific lessons so next run uses exact content or full-file rewrite.
    if (result.error && /search\/replace operations failed|search text did not match/i.test(result.error)) {
      const paths = [...new Set(unresolvedIssues.map((i) => i.comment.path))];
      for (const path of paths) {
        const one = unresolvedIssues.find((i) => i.comment.path === path);
        if (one) {
          LessonsAPI.Add.addLesson(
            lessonsContext,
            `Fix for ${path}:${one.comment.line ?? '?'} - Search/replace failed to match; use exact file content or full-file rewrite`
          );
        }
      }
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
        updatedUnresolvedIssues: unresolvedIssues,
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
      unresolvedIssues, comments, git,
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

  // Check for changes
  if (!(await hasChanges(git))) {
    // Handle no-changes scenario with verification
    const noChangesResult = await ResolverProc.handleNoChangesWithVerification(unresolvedIssues, runner.name, currentModel, result.output || '', llm, stateContext, lessonsContext, verifiedThisSession, parseNoChangesExplanation);
    
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
      updatedUnresolvedIssues: unresolvedIssues,
      lessonsBeforeFix,
    };
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
    updatedUnresolvedIssues: unresolvedIssues,
    lessonsBeforeFix,
  };
}
