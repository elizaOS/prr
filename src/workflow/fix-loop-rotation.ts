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

/**
 * Execute rotation strategy after failure (either "no changes" or "verification failed")
 * 
 * ROTATION STRATEGY:
 * - Odd failures (1, 3, 5...): Try single-issue focus mode with current model
 * - Even failures (2, 4, 6...): Rotate model/tool, or try direct LLM
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
  trySingleIssueFix: (
    issues: UnresolvedIssue[],
    git: SimpleGit,
    verifiedThisSession?: Set<string>
  ) => Promise<boolean>,
  tryRotation: () => boolean,
  tryDirectLLMFix: (
    issues: UnresolvedIssue[],
    git: SimpleGit,
    verifiedThisSession?: Set<string>
  ) => Promise<boolean>,
  executeBailOut: (
    unresolvedIssues: UnresolvedIssue[],
    comments: ReviewComment[]
  ) => Promise<void>
): Promise<{
  shouldBreak: boolean;
  shouldContinue: boolean;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
}> {
  const chalk = (await import('chalk')).default;
  const { debug } = await import('../logger.js');

  const isOddFailure = consecutiveFailures % 2 === 1;
  let shouldBreak = false;
  let shouldContinue = false;
  let newConsecutiveFailures = consecutiveFailures;
  let newModelFailuresInCycle = modelFailuresInCycle;
  let newProgressThisCycle = progressThisCycle;

  if (isOddFailure && unresolvedIssues.length > 1) {
    console.log(chalk.yellow('\n  🎯 Trying single-issue focus mode...'));
    const singleIssueFixed = await trySingleIssueFix(unresolvedIssues, git, verifiedThisSession);
    if (singleIssueFixed) {
      newConsecutiveFailures = 0;
      newModelFailuresInCycle = 0;
      newProgressThisCycle++;  // Track progress for bail-out
    }
  } else if (!isOddFailure) {
    // Try rotating model or tool
    const rotated = tryRotation();
    
    // Check if bail-out was triggered by tryRotation()
    if (Bailout.getNoProgressCycles(stateContext) >= options.maxStaleCycles) {
      // Bail-out triggered - try direct LLM one last time before giving up
      console.log(chalk.yellow('\n  🧠 Last resort: trying direct LLM API fix before bail-out...'));
      const directFixed = await tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
      if (directFixed) {
        newConsecutiveFailures = 0;
        newModelFailuresInCycle = 0;
        newProgressThisCycle++;
        Bailout.resetNoProgressCycles(stateContext);  // Made progress, reset
      } else {
        // Direct LLM also failed - execute bail-out
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
      console.log(chalk.yellow('\n  🧠 All tools/models exhausted, trying direct LLM API fix...'));
      const directFixed = await tryDirectLLMFix(unresolvedIssues, git, verifiedThisSession);
      if (directFixed) {
        newConsecutiveFailures = 0;
        newModelFailuresInCycle = 0;
        newProgressThisCycle++;
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
