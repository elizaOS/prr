/**
 * Initialization and setup functions for PR resolution workflow
 */

import type { CLIOptions } from '../cli.js';
import type { StateContext } from '../state/state-context.js';
import { createStateContext, setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import * as Lock from '../state/lock-functions.js';
import type { Runner } from '../runners/types.js';
import * as LessonsAPI from '../state/lessons-index.js';

/**
 * Ensure state file is added to .gitignore
 * WHY: State file should never be committed - it's local/temporary
 */
export async function ensureStateFileIgnored(workdir: string): Promise<void> {
  const { join } = await import('path');
  const { readFile, writeFile } = await import('fs/promises');
  const { simpleGit } = await import('simple-git');
  const chalk = (await import('chalk')).default;
  
  const gitignorePath = join(workdir, '.gitignore');
  const stateFileName = '.pr-resolver-state.json';
  
  try {
    // First, check if the state file is tracked in git (accidentally committed)
    const git = simpleGit(workdir);
    try {
      const tracked = await git.raw(['ls-files', stateFileName]);
      if (tracked.trim()) {
        console.log(chalk.yellow(`  ⚠ ${stateFileName} was committed to git - removing from tracking...`));
        await git.raw(['rm', '--cached', stateFileName]);
        console.log(chalk.green(`  ✓ Removed ${stateFileName} from git tracking (local file preserved)`));
      }
    } catch {
      // File not tracked, which is good
    }
    
    let gitignoreContent = '';
    try {
      gitignoreContent = await readFile(gitignorePath, 'utf-8');
    } catch {
      // .gitignore doesn't exist, we'll create it
    }
    
    // Check if already ignored
    const lines = gitignoreContent.split('\n');
    const isIgnored = lines.some(line => {
      const trimmed = line.trim();
      return trimmed === stateFileName || 
             trimmed === `/${stateFileName}` ||
             trimmed === `**/${stateFileName}`;
    });
    
    if (!isIgnored) {
      const newContent = gitignoreContent.endsWith('\n') || gitignoreContent === ''
        ? `${gitignoreContent}# prr state file (auto-generated)\n${stateFileName}\n`
        : `${gitignoreContent}\n\n# prr state file (auto-generated)\n${stateFileName}\n`;
      
      await writeFile(gitignorePath, newContent, 'utf-8');
      console.log(chalk.gray(`  Added ${stateFileName} to .gitignore`));
    }
  } catch (err) {
    // Non-fatal - just log and continue
  }
}

/**
 * Initialize state, lessons, and lock managers
 */
export async function initializeManagers(
  workdir: string,
  owner: string,
  repo: string,
  prNumber: number,
  branch: string,
  headSha: string,
  options: CLIOptions
): Promise<{
  stateContext: StateContext;
  lessonsContext: LessonsContext;
  lockConfig: LockConfig;
  state: any;
}> {
  const chalk = (await import('chalk')).default;
  const { debug, debugStep } = await import('../logger.js');
  
  // Initialize state context
  debugStep('LOADING STATE');
  const stateContext = createStateContext(workdir);
  setPhase(stateContext, 'init');
  const state = await State.loadState(
    stateContext,
    `${owner}/${repo}#${prNumber}`, 
    branch,
    headSha
  );
  debug('Loaded state', {
    iterations: state.iterations.length,
    verifiedFixed: state.verifiedFixed.length,
  });

  // Initialize lessons context (branch-permanent storage)
  // WHY: Lessons help the fixer avoid repeating mistakes
  const lessonsContext = LessonsAPI.createLessonsContext(owner, repo, branch, workdir);
  if (options.noClaudeMd) {
    LessonsAPI.setSkipClaudeMd(lessonsContext, true);
  }
  LessonsAPI.setWorkdir(lessonsContext, workdir); // Enable repo-based lesson sharing
  await LessonsAPI.Load.loadLessons(lessonsContext);
  
  // Initialize lock config for multi-instance coordination
  // WHY: Prevents duplicate work when multiple prr instances run on same PR
  const lockConfig = Lock.createLockConfig(workdir, { enabled: !options.noLock });
  if (Lock.isLockEnabled(lockConfig)) {
    const lockStatus = await Lock.getLockStatus(lockConfig);
    if (lockStatus.isLocked && !lockStatus.isOurs) {
      console.log(chalk.yellow(`⚠ Another prr instance is working on this PR`));
      console.log(chalk.gray(`  Instance: ${lockStatus.holder?.instanceId} on ${lockStatus.holder?.hostname}`));
      console.log(chalk.gray(`  Claimed issues: ${lockStatus.claimedIssues.length}`));
      console.log(chalk.gray(`  We will avoid those issues`));
    }
  }

  // Prune lessons for deleted files
  // WHY: Lessons about files that no longer exist are useless clutter
  const prunedDeletedFiles = LessonsAPI.Prune.pruneDeletedFiles(lessonsContext, workdir);
  if (prunedDeletedFiles > 0) {
    console.log(chalk.gray(`Pruned ${prunedDeletedFiles} lessons for deleted files`));
    await LessonsAPI.Save.save(lessonsContext);
  }
  
  const lessonCounts = LessonsAPI.Retrieve.getCounts(lessonsContext);
  debug('Loaded lessons', lessonCounts);
  
  return { stateContext, lessonsContext, lockConfig, state };
}

/**
 * Restore runner and model state from previous session
 */
export async function restoreRunnerState(
  stateContext: StateContext,
  runners: Runner[],
  currentRunnerIndex: number,
  modelIndices: Map<string, number>,
  getCurrentModelFn: () => string | undefined
): Promise<{
  currentRunnerIndex: number;
  runner: Runner;
  modelIndices: Map<string, number>;
}> {
  const chalk = (await import('chalk')).default;
  const Rotation = await import('../state/state-rotation.js');
  
  // Restore tool/model rotation state from previous session
  // WHY: Resume where we left off if interrupted, don't restart from first model
  const savedRunnerIndex = Rotation.getCurrentRunnerIndex(stateContext);
  const savedModelIndices = Rotation.getModelIndices(stateContext);
  
  let newRunnerIndex = currentRunnerIndex;
  let runner = runners[currentRunnerIndex];
  const newModelIndices = new Map(modelIndices);
  
  if (savedRunnerIndex > 0 && savedRunnerIndex < runners.length) {
    newRunnerIndex = savedRunnerIndex;
    runner = runners[savedRunnerIndex];
    console.log(chalk.gray(`  Resuming at tool: ${runner.displayName} (from previous session)`));
  }
  
  if (Object.keys(savedModelIndices).length > 0) {
    for (const [runnerName, index] of Object.entries(savedModelIndices)) {
      newModelIndices.set(runnerName, index);
    }
    const currentModel = getCurrentModelFn();
    if (currentModel) {
      console.log(chalk.gray(`  Resuming at model: ${currentModel} (from previous session)`));
    }
  }
  
  return { currentRunnerIndex: newRunnerIndex, runner, modelIndices: newModelIndices };
}
