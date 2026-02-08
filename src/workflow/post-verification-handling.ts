/**
 * Post-verification handling
 * 
 * After fixes are verified, handle:
 * 1. Success → reset failure counters
 * 2. All failures → execute rotation strategy
 * 3. Update unresolved list for next iteration
 */

import type { SimpleGit } from 'simple-git';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment } from '../github/types.js';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { CLIOptions } from '../cli.js';

/**
 * Handle post-verification state updates and rotation
 * 
 * LOGIC:
 * - If verified > 0: Reset failure counters (made progress)
 * - If verified = 0: Increment failures, execute rotation strategy
 * - Update unresolved list (filter out verified items)
 * 
 * @returns Control flow and updated state
 */
export async function handlePostVerification(
  verifiedCount: number,
  allFixed: boolean,
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  verifiedThisSession: Set<string>,
  git: SimpleGit,
  consecutiveFailures: number,
  modelFailuresInCycle: number,
  progressThisCycle: number,
  stateManager: StateManager,
  lessonsManager: LessonsManager,
  options: CLIOptions,
  trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verified?: Set<string>) => Promise<boolean>,
  tryRotation: () => boolean,
  tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verified?: Set<string>) => Promise<boolean>,
  executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>
): Promise<{
  shouldBreak: boolean;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
}> {
  const ResolverProc = await import('../resolver-proc.js');

  if (!allFixed) {
    // Track consecutive failures for strategy switching
    if (verifiedCount === 0) {
      const updatedConsecutiveFailures = consecutiveFailures + 1;
      const updatedModelFailuresInCycle = modelFailuresInCycle + 1;
      
      // Execute rotation strategy
      const rotationResult = await ResolverProc.handleRotationStrategy(unresolvedIssues, comments, git, updatedConsecutiveFailures, updatedModelFailuresInCycle, progressThisCycle,
        stateManager, lessonsManager, options, verifiedThisSession, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut);
      
      return {
        shouldBreak: rotationResult.shouldBreak,
        updatedConsecutiveFailures: rotationResult.updatedConsecutiveFailures,
        updatedModelFailuresInCycle: rotationResult.updatedModelFailuresInCycle,
        updatedProgressThisCycle: rotationResult.updatedProgressThisCycle,
        updatedUnresolvedIssues: rotationResult.updatedUnresolvedIssues,
      };
    } else {
      // Made progress, reset failure counters
      const filteredIssues = unresolvedIssues.filter((i) => !verifiedThisSession.has(i.comment.id));
      return {
        shouldBreak: false,
        updatedConsecutiveFailures: 0,
        updatedModelFailuresInCycle: 0,
        updatedProgressThisCycle: progressThisCycle,
        updatedUnresolvedIssues: filteredIssues,
      };
    }
  }

  return {
    shouldBreak: false,
    updatedConsecutiveFailures: consecutiveFailures,
    updatedModelFailuresInCycle: modelFailuresInCycle,
    updatedProgressThisCycle: progressThisCycle,
    updatedUnresolvedIssues: unresolvedIssues,
  };
}
