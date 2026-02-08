/**
 * Initialization and setup functions for PR resolution workflow
 */

import type { CLIOptions } from '../cli.js';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { LockManager } from '../state/lock.js';
import type { Runner } from '../runners/types.js';

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
  stateManager: StateManager;
  lessonsManager: LessonsManager;
  lockManager: LockManager;
  state: any;
}> {
  const chalk = (await import('chalk')).default;
  const { debug, debugStep } = await import('../logger.js');
  const { StateManager } = await import('../state/manager.js');
  const { LessonsManager } = await import('../state/lessons.js');
  const { LockManager } = await import('../state/lock.js');
  
  // Initialize state manager
  debugStep('LOADING STATE');
  const stateManager = new StateManager(workdir);
  stateManager.setPhase('init');
  const state = await stateManager.load(
    `${owner}/${repo}#${prNumber}`, 
    branch,
    headSha
  );
  debug('Loaded state', {
    iterations: state.iterations.length,
    verifiedFixed: state.verifiedFixed.length,
  });

  // Initialize lessons manager (branch-permanent storage)
  // WHY: Lessons help the fixer avoid repeating mistakes
  const lessonsManager = new LessonsManager(owner, repo, branch);
  if (options.noClaudeMd) {
    lessonsManager.setSkipClaudeMd(true);
  }
  lessonsManager.setWorkdir(workdir); // Enable repo-based lesson sharing
  await lessonsManager.load();
  
  // Initialize lock manager for multi-instance coordination
  // WHY: Prevents duplicate work when multiple prr instances run on same PR
  const lockManager = new LockManager(workdir, { enabled: !options.noLock });
  if (lockManager.isEnabled()) {
    const lockStatus = await lockManager.getStatus();
    if (lockStatus.isLocked && !lockStatus.isOurs) {
      console.log(chalk.yellow(`⚠ Another prr instance is working on this PR`));
      console.log(chalk.gray(`  Instance: ${lockStatus.holder?.instanceId} on ${lockStatus.holder?.hostname}`));
      console.log(chalk.gray(`  Claimed issues: ${lockStatus.claimedIssues.length}`));
      console.log(chalk.gray(`  We will avoid those issues`));
    }
  }

  // Prune lessons for deleted files
  // WHY: Lessons about files that no longer exist are useless clutter
  const prunedDeletedFiles = lessonsManager.pruneDeletedFiles(workdir);
  if (prunedDeletedFiles > 0) {
    console.log(chalk.gray(`Pruned ${prunedDeletedFiles} lessons for deleted files`));
    await lessonsManager.save();
  }
  
  const lessonCounts = lessonsManager.getCounts();
  debug('Loaded lessons', lessonCounts);
  
  return { stateManager, lessonsManager, lockManager, state };
}

/**
 * Restore runner and model state from previous session
 */
export async function restoreRunnerState(
  stateManager: StateManager,
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
  
  // Restore tool/model rotation state from previous session
  // WHY: Resume where we left off if interrupted, don't restart from first model
  const savedRunnerIndex = stateManager.getCurrentRunnerIndex();
  const savedModelIndices = stateManager.getModelIndices();
  
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
