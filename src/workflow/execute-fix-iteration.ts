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
import type { ReviewComment } from '../github/types.js';
import type { Runner } from '../runners/types.js';
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
import ora from 'ora';
import { debug, debugStep, startTimer, endTimer, formatDuration } from '../logger.js';
import { hasChanges } from '../git/git-clone-index.js';
import * as ResolverProc from '../resolver-proc.js';

/**
 * Execute one fix iteration (prompt build + fixer run + result handling)
 * 
 * WORKFLOW:
 * 1. Build fix prompt with lessons
 * 2. Run fixer tool
 * 3. Handle errors (rapid failure detection, exit on critical)
 * 4. If no changes → run verification workflow or rotation
 * 5. If changes → return for verification
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
  verifiedThisSession: Set<string>,
  rapidFailureCount: number,
  lastFailureTime: number,
  consecutiveFailures: number,
  modelFailuresInCycle: number,
  progressThisCycle: number,
  getCurrentModel: () => string | undefined,
  parseNoChangesExplanation: (output: string) => string | null,
  trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verified?: Set<string>) => Promise<boolean>,
  tryRotation: () => boolean,
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verified?: Set<string>) => Promise<boolean>,
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>
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
  const promptDetails = ResolverProc.buildAndDisplayFixPrompt(unresolvedIssues, lessonsContext, options.verbose, consecutiveFailures, options.priorityOrder);
  
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

  // Run fixer tool
  debugStep('RUNNING FIXER TOOL');
  setPhase(stateContext, 'fixing');
  startTimer('Run fixer');
  spinner.start(`Running ${runner.name} to fix issues...`);
  
  debug('Executing runner', { tool: runner.name, workdir, model: currentModel });
  const codexAddDirs = [...(options.codexAddDir ?? [])];

  let result;
  try {
    result = await runner.run(workdir, prompt, {
      model: currentModel,
      codexAddDirs,
    });
  } finally {
    spinner.stop();
  }
  const fixerTime = endTimer('Run fixer');
  debug('Runner result', { success: result.success, error: result.error, duration: fixerTime });

  if (!result.success) {
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
    
    // Non-fatal fixer error: increment failure counters and trigger rotation.
    // WHY: Previously, fixer errors returned shouldContinue without incrementing
    // consecutiveFailures or triggering rotation, causing the same tool/model to
    // be retried indefinitely. Now we treat it like a "no changes" failure.
    const updatedConsecutiveFailures = consecutiveFailures + 1;
    const updatedModelFailuresInCycle = modelFailuresInCycle + 1;
    
    const rotationResult = await ResolverProc.handleRotationStrategy(
      unresolvedIssues, comments, git,
      updatedConsecutiveFailures, updatedModelFailuresInCycle, progressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession, runner.name,
      trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut
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
    
    // Execute rotation strategy
    const rotationResult = await ResolverProc.handleRotationStrategy(updatedUnresolvedIssues, comments, git, updatedConsecutiveFailures, updatedModelFailuresInCycle, updatedProgressThisCycle,
      stateContext, lessonsContext, options, verifiedThisSession, runner.name, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut);
    
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
