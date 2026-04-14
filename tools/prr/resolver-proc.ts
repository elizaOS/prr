/**
 * Procedural implementation of PR resolution logic.
 * Extracted from PRResolver class to reduce file size and improve testability.
 *
 * This file is a **pure facade**: re-exports the public workflow API used by
 * `resolver.ts` and tests. Implementation lives under `workflow/`.
 *
 * WHY a facade (no logic here): `resolver.ts` and integration tests import one
 * stable module instead of a growing list of `workflow/*.ts` paths. New workflow
 * steps are implemented next to their domain (e.g. `bot-wait.ts`, `bailout.ts`)
 * and only need an `export { … } from` line here — reducing merge conflicts and
 * making “what is the resolver’s public surface?” grepable in this file only.
 */

// ============================================================================
// RE-EXPORTS FROM WORKFLOW MODULES
// ============================================================================

// Utilities
export {
  type ResolverContext,
  createResolverContext,
  ringBell,
  parseNoChangesExplanation,
  sanitizeOutputForLog,
  validateDismissalExplanation,
  sleep,
  buildSingleIssuePrompt,
  calculateExpectedBotResponseTime,
  shouldCheckForNewComments,
} from './workflow/utils.js';

// Initialization
export {
  ensureStateFileIgnored,
  initializeManagers,
  restoreRunnerState,
} from './workflow/initialization.js';

// Issue analysis
export {
  getCodeSnippet,
  getFullFileForAudit,
  findUnresolvedIssues,
} from './workflow/issue-analysis.js';

// Startup workflows
export {
  displayPRStatus,
  analyzeBotTimingAndDisplay,
  checkCodeRabbitStatus,
  setupWorkdirAndManagers,
} from './workflow/startup.js';

// Repository workflows
export {
  restoreRunnerRotationState,
  cloneOrUpdateRepository,
  recoverVerificationState,
  checkAndSyncWithRemote,
} from './workflow/repository.js';

// Base branch merge workflows
export {
  checkAndMergeBaseBranch,
} from './workflow/base-merge.js';

// No comments workflows
export {
  handleNoComments,
} from './workflow/no-comments.js';

// Analysis workflows
export {
  analyzeAndReportIssues,
  checkForNewComments,
  runFinalAudit,
} from './workflow/analysis.js';

// Commit workflows
export {
  commitAndPushChanges,
} from './workflow/commit.js';

// Fix loop utilities
export {
  processNewBotReviews,
  filterVerifiedIssues,
  checkEmptyIssues,
  checkAndPullRemoteCommits,
  refreshSnippetsForVerifierContradiction,
  refreshSnippetsForChangedFiles,
} from './workflow/fix-loop-utils.js';

// Fixer error handling
export {
  handleFixerError,
} from './workflow/fixer-errors.js';

// Fix verification
export {
  verifyFixes,
} from './workflow/fix-verification.js';

// Iteration cleanup
export {
  handleIterationCleanup,
} from './workflow/iteration-cleanup.js';

// Recovery helpers
export {
  trySingleIssueFix,
  tryDirectLLMFix,
} from './workflow/helpers/recovery.js';

// Fix loop rotation
export {
  handleRotationStrategy,
} from './workflow/fix-loop-rotation.js';

// No-changes verification
export {
  handleNoChangesWithVerification,
} from './workflow/no-changes-verification.js';

// Run initialization
export {
  initializeRun,
} from './workflow/run-initialization.js';

// Run setup phase
export {
  executeSetupPhase,
} from './workflow/run-setup-phase.js';

// Push iteration loop
export {
  executePushIteration,
} from './workflow/push-iteration-loop.js';

// Graceful shutdown
export {
  executeGracefulShutdown,
} from './workflow/graceful-shutdown.js';

// Run orchestrator
export {
  executeRun,
  type RunState,
  type RunCallbacks,
} from './workflow/run-orchestrator.js';

// Main loop setup
export {
  processCommentsAndPrepareFixLoop,
} from './workflow/main-loop-setup.js';

// Fix loop initialization
export {
  initializeFixLoop,
  type FixLoopState,
} from './workflow/fix-loop-initialization.js';

// Fix iteration pre-checks
export {
  executePreIterationChecks,
} from './workflow/fix-iteration-pre-checks.js';

// Execute fix iteration
export {
  executeFixIteration,
} from './workflow/execute-fix-iteration.js';

// Post-verification handling
export {
  handlePostVerification,
} from './workflow/post-verification-handling.js';

// Prompt building
export {
  buildAndDisplayFixPrompt,
} from './workflow/prompt-building.js';

// Commit and push within fix loop
export {
  handleCommitAndPush,
} from './workflow/commit-and-push-loop.js';

// Final cleanup and reporting
export {
  executeFinalCleanup,
  executeErrorCleanup,
} from './workflow/final-cleanup.js';

// Cleanup mode
export {
  runCleanupMode,
} from './workflow/cleanup-mode.js';

// Bot wait and new-review polling (post-push / fix loop)
export {
  calculateSmartWaitTime,
  waitForBotReviews,
  checkForNewBotReviews,
} from './workflow/bot-wait.js';

// Stalemate bail-out
export {
  executeBailOut,
} from './workflow/bailout.js';
