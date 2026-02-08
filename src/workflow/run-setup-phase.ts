/**
 * Run setup phase
 * 
 * Complete setup after initialization:
 * 1. Check CodeRabbit status
 * 2. Setup workdir and managers
 * 3. Setup runner
 * 4. Restore rotation state
 * 5. Clone/update repository
 * 6. Ensure state file ignored
 * 7. Recover verification state
 * 8. Check and sync with remote
 * 9. Check and merge base branch
 */

import type { Ora } from 'ora';
import type { SimpleGit } from 'simple-git';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import type { PRInfo } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { LockManager } from '../state/lock.js';
import type { Runner } from '../runners/types.js';

/**
 * Execute complete setup phase
 * 
 * WORKFLOW:
 * 1. Check CodeRabbit status
 * 2. Setup workdir and initialize managers
 * 3. Setup runner (detect or use specified)
 * 4. Restore tool/model rotation state
 * 5. Clone or update repository
 * 6. Ensure state file in .gitignore
 * 7. Recover verification state from git
 * 8. Check and sync with remote
 * 9. Merge base branch if needed
 * 
 * @returns Setup results and git instance
 */
export async function executeSetupPhase(
  config: Config,
  options: CLIOptions,
  owner: string,
  repo: string,
  number: number,
  prInfo: PRInfo,
  github: GitHubAPI,
  spinner: Ora,
  setupRunner: () => Promise<Runner>,
  ensureStateFileIgnored: () => Promise<void>,
  resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>,
  getRotationContext: () => any,
  getCurrentModel: () => string | undefined
): Promise<{
  workdir: string;
  stateManager: StateManager;
  lessonsManager: LessonsManager;
  lockManager: LockManager;
  runner: Runner;
  runners: Runner[];
  currentRunnerIndex: number;
  modelIndices: Map<string, number>;
  git: SimpleGit;
  shouldExit: boolean;
  exitReason?: string;
  exitDetails?: string;
}> {
  const { debug, debugStep } = await import('../logger.js');
  const ResolverProc = await import('../resolver-proc.js');

  // Check CodeRabbit status
  debugStep('CHECKING CODERABBIT STATUS');
  await ResolverProc.checkCodeRabbitStatus(github, owner, repo, number, prInfo.branch, prInfo.headSha, spinner);
  
  // Setup workdir and managers
  const managers = await ResolverProc.setupWorkdirAndManagers(config, options, owner, repo, number, prInfo);
  const { workdir, stateManager, lessonsManager, lockManager } = managers;
  const state = stateManager.getState();

  // Setup runner
  debugStep('SETTING UP RUNNER');
  const runner = await setupRunner();
  debug('Using runner', runner.name);
  
  // Restore tool/model rotation state
  const ctx = getRotationContext();
  const rotationState = ResolverProc.restoreRunnerRotationState(stateManager, ctx.runners, ctx.modelIndices, getCurrentModel);
  let currentRunnerIndex = ctx.currentRunnerIndex;
  let resolvedRunner = runner;
  if (rotationState.runner) {
    currentRunnerIndex = rotationState.runnerIndex;
    resolvedRunner = rotationState.runner;
  }
  
  // Clone or update repo
  const hasVerifiedFixes = state.verifiedFixed.length > 0;
  const git = await ResolverProc.cloneOrUpdateRepository(prInfo, workdir, config.githubToken, hasVerifiedFixes, spinner);

  // Ensure state file is in .gitignore
  await ensureStateFileIgnored();

  // Recover verification state from git history
  await ResolverProc.recoverVerificationState(git, prInfo.branch, stateManager);

  // Check for conflicts and sync with remote
  const syncResult = await ResolverProc.checkAndSyncWithRemote(git, prInfo.branch, spinner, resolveConflictsWithLLM);
  if (!syncResult.success) {
    return {
      workdir, stateManager, lessonsManager, lockManager, runner: resolvedRunner, runners: ctx.runners, currentRunnerIndex, modelIndices: ctx.modelIndices, git,
      shouldExit: true,
    };
  }

  // Check and merge base branch
  const mergeResult = await ResolverProc.checkAndMergeBaseBranch(git, prInfo, options, spinner, resolveConflictsWithLLM);
  if (!mergeResult.success) {
    return {
      workdir, stateManager, lessonsManager, lockManager, runner: resolvedRunner, runners: ctx.runners, currentRunnerIndex, modelIndices: ctx.modelIndices, git,
      shouldExit: true,
      exitReason: mergeResult.exitReason,
      exitDetails: mergeResult.exitDetails,
    };
  }

  return {
    workdir, stateManager, lessonsManager, lockManager, runner: resolvedRunner, runners: ctx.runners, currentRunnerIndex, modelIndices: ctx.modelIndices, git,
    shouldExit: false,
  };
}
