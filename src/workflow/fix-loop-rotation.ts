/**
 * Fix loop rotation and recovery strategy
 * 
 * Handles failure recovery in the fix loop using a multi-stage strategy:
 * 1. Try single-issue focus with current model (odd failures)
 * 2. Rotate to next model/tool (even failures)
 * 3. Try direct LLM API as last resort
 * 4. Execute bail-out if all strategies exhausted
 */

import type { SimpleGit } from 'simple-git';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import * as Bailout from '../state/state-bailout.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { CLIOptions } from '../cli.js';
import chalk from 'chalk';
import { debug } from '../logger.js';
import { resetPromptTracker } from './execute-fix-iteration.js';

/**
 * Execute rotation strategy after failure (either "no changes" or "verification failed")
 * 
 * ROTATION STRATEGY:
 * - Odd failures (1, 3, 5...): Try single-issue focus mode with current model
 * - Even failures (2, 4, 6...): Rotate model/tool, or try direct LLM
 * - Quota/rate-limit: Skip single-issue (same model will hit limit again) and rotate immediately
 * 
 * BAIL-OUT DETECTION:
 * - If rotation triggers bail-out (maxStaleCycles reached), try direct LLM once more
 * - If direct LLM also fails, execute bail-out and signal caller to break
 * 
 * @returns Object with updated state and control flow signals
 */
export async function handleRotationStrategy(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  git: SimpleGit,
  consecutiveFailures: number,
  modelFailuresInCycle: number,
  progressThisCycle: number,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  options: CLIOptions,
  verifiedThisSession: Set<string>,
  currentRunnerName: string,
  trySingleIssueFix: (
    issues: UnresolvedIssue[],
    git: SimpleGit,
    verifiedThisSession?: Set<string>
  ) => Promise<boolean>,
  tryRotation: (failureErrorType?: string) => boolean,
  tryDirectLLMFix: (
    issues: UnresolvedIssue[],
    git: SimpleGit,
    verifiedThisSession?: Set<string>
  ) => Promise<boolean>,
  executeBailOut: (
    unresolvedIssues: UnresolvedIssue[],
    comments: ReviewComment[]
  ) => Promise<void>,
  /** When 'quota', skip single-issue and rotate immediately; same model will hit limit again. */
  failureErrorType?: string
): Promise<{
  shouldBreak: boolean;
  shouldContinue: boolean;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
}> {
  const isOddFailure = consecutiveFailures % 2 === 1;
  // Skip single-issue for quota (same model will hit limit), 504 (same model would timeout again), and tool_config (same tool will fail again).
  const skipSingleIssueForQuota = failureErrorType === 'quota';
  const skipSingleIssueFor504 = failureErrorType === 'timeout';
  const skipSingleIssueForToolConfig = failureErrorType === 'tool_config';
  const skipSingleIssueForToolTimeout = failureErrorType === 'tool_timeout';
  const skipSingleIssue = skipSingleIssueForQuota || skipSingleIssueFor504 || skipSingleIssueForToolConfig || skipSingleIssueForToolTimeout;
  let shouldBreak = false;
  let shouldContinue = false;
  let newConsecutiveFailures = consecutiveFailures;
  let newModelFailuresInCycle = modelFailuresInCycle;
  let newProgressThisCycle = progressThisCycle;

  if (isOddFailure && unresolvedIssues.length > 1 && !skipSingleIssue) {
    console.log(chalk.yellow('\n  🎯 Trying single-issue focus mode...'));
    const singleIssueFixed = await trySingleIssueFix(unresolvedIssues, git, verifiedThisSession);
    if (singleIssueFixed) {
      // Track progress for bail-out detection, but do NOT reset consecutiveFailures.
      // WHY: Resetting consecutiveFailures to 0 here causes a rotation stall bug:
      // the next batch failure sets it back to 1 (odd), which triggers single-issue
      // again, and if that succeeds, it resets to 0 again — the model NEVER rotates.
      // By keeping consecutiveFailures at its current value, the next batch failure
      // will make it even, which triggers model rotation.
      newProgressThisCycle++;
    }
  }
  if (!isOddFailure || skipSingleIssue) {
    // Try rotating model or tool (even failure, or quota/504: skip single-issue and rotate)
    if (skipSingleIssueForQuota) {
      console.log(chalk.yellow('\n  ⏭ Quota exceeded — skipping single-issue, rotating to next tool/model...'));
    }
    if (skipSingleIssueForToolConfig || skipSingleIssueForToolTimeout) {
      console.log(chalk.yellow('\n  ⏭ Tool error — skipping single-issue, rotating to next tool...'));
    }
    const rotated = tryRotation(failureErrorType);
    // WHY reset: The prompt tracker detects identical prompt+model combos to
    // skip redundant iterations. After rotation, the prompt content may be
    // identical (same issues, same lessons) but the MODEL is different. Without
    // resetting, the new model would be immediately skipped as a "duplicate,"
    // defeating the purpose of rotation. Each rotated model deserves a fair shot.
    resetPromptTracker();
    
    // Check if bail-out was triggered by tryRotation()
    if (Bailout.getNoProgressCycles(stateContext) >= options.maxStaleCycles) {
      // Skip direct LLM if we're already running as llm-api - it already failed
      const alreadyOnLLMApi = currentRunnerName === 'llm-api';
      if (alreadyOnLLMApi) {
        debug('Skipping direct LLM last resort - already running as llm-api runner');
        console.log(chalk.yellow('\n  🛑 Already using direct LLM API - skipping redundant retry'));
      } else {
        // Bail-out triggered - try direct LLM one last time before giving up
        console.log(chalk.yellow('\n  🧠 Last resort: trying direct LLM API fix before bail-out...'));
        const directFixed = await tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
        if (directFixed) {
          newConsecutiveFailures = 0;
          newModelFailuresInCycle = 0;
          newProgressThisCycle++;
          Bailout.resetNoProgressCycles(stateContext);  // Made progress, reset
        }
      }
      
      // If still no progress (LLM skipped or failed), execute bail-out
      if (newProgressThisCycle <= progressThisCycle) {
        await executeBailOut(unresolvedIssues, comments);
        shouldBreak = true;  // Signal caller to exit fix loop
        return {
          shouldBreak,
          shouldContinue,
          updatedConsecutiveFailures: newConsecutiveFailures,
          updatedModelFailuresInCycle: newModelFailuresInCycle,
          updatedProgressThisCycle: newProgressThisCycle,
          updatedUnresolvedIssues: unresolvedIssues,
        };
      }
    } else if (rotated) {
      console.log(chalk.cyan('  Starting fresh with batch mode...'));
    } else {
      // Rotation failed but not at bail-out threshold yet
      // Skip if already on llm-api - same strategy won't help
      if (currentRunnerName === 'llm-api') {
        debug('Skipping direct LLM fallback - already running as llm-api runner');
        console.log(chalk.yellow('\n  ⏭ Already using direct LLM API - skipping redundant fallback'));
      } else {
        console.log(chalk.yellow('\n  🧠 All tools/models exhausted, trying direct LLM API fix...'));
        const directFixed = await tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
        if (directFixed) {
          newConsecutiveFailures = 0;
          newModelFailuresInCycle = 0;
          newProgressThisCycle++;
        }
      }
    }
  }

  // After single-issue or rotation attempts, filter out any newly verified items
  // WHY: trySingleIssueFix/tryDirectLLMFix can mark items as verified
  // but we might 'continue' before the normal filtering at end of verification
  // IMPORTANT: Use verifiedThisSession, not isCommentVerifiedFixed, to avoid
  // removing stale verifications that findUnresolvedIssues kept for re-checking
  const verifiedDuringRecovery = unresolvedIssues.filter(
    (i) => verifiedThisSession.has(i.comment.id)
  );
  if (verifiedDuringRecovery.length > 0) {
    debug('Filtering verified items after recovery attempt', {
      before: unresolvedIssues.length,
      verified: verifiedDuringRecovery.map(i => i.comment.id),
    });
    unresolvedIssues.splice(
      0,
      unresolvedIssues.length,
      ...unresolvedIssues.filter(
        (i) => !verifiedThisSession.has(i.comment.id)
      )
    );
  }

  return {
    shouldBreak,
    shouldContinue,
    updatedConsecutiveFailures: newConsecutiveFailures,
    updatedModelFailuresInCycle: newModelFailuresInCycle,
    updatedProgressThisCycle: newProgressThisCycle,
    updatedUnresolvedIssues: unresolvedIssues,
  };
}
