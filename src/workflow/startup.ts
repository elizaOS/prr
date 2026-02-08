/**
 * Startup workflow functions for PR processing
 * Handles initialization, PR status checks, bot timing analysis, etc.
 */

import type { Ora } from 'ora';
import type { GitHubAPI } from '../github/api.js';
import type { PRInfo, BotResponseTiming, PRStatus } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { createStateContext, setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import * as Lock from '../state/lock-functions.js';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';

/**
 * Display PR status including CI checks, bot reviews, and overall activity
 */
export function displayPRStatus(prStatus: PRStatus): void {
  const chalk = require('chalk');
  const { warn, info } = require('../logger.js');
  
  // CI checks status
  if (prStatus.inProgressChecks.length > 0) {
    warn(`CI: ${prStatus.inProgressChecks.length} checks running: ${prStatus.inProgressChecks.join(', ')}`);
  } else if (prStatus.pendingChecks.length > 0) {
    warn(`CI: ${prStatus.pendingChecks.length} checks queued: ${prStatus.pendingChecks.join(', ')}`);
  } else {
    console.log(chalk.green('✓'), `CI: ${prStatus.completedChecks}/${prStatus.totalChecks} checks completed (${prStatus.ciState})`);
  }

  // Bot review status
  if (prStatus.activelyReviewingBots.length > 0) {
    warn(`Bots reviewing: ${prStatus.activelyReviewingBots.join(', ')}`);
    info('These bots may still be analyzing - consider waiting for them to finish.');
  }
  
  // Bots with 👀 reaction (looking at it)
  if (prStatus.botsWithEyesReaction.length > 0) {
    warn(`Bots looking (👀): ${prStatus.botsWithEyesReaction.join(', ')}`);
  }
  
  // Pending reviewers
  if (prStatus.pendingReviewers.length > 0) {
    info(`Pending reviewers: ${prStatus.pendingReviewers.join(', ')}`);
  }

  // Overall status
  const hasActivity = prStatus.inProgressChecks.length > 0 || 
                      prStatus.pendingChecks.length > 0 || 
                      prStatus.activelyReviewingBots.length > 0 ||
                      prStatus.botsWithEyesReaction.length > 0;
  if (!hasActivity) {
    console.log(chalk.green('✓'), 'PR is idle - safe to proceed');
  }
}

/**
 * Analyze and display bot response timing, calculate expected bot review time
 */
export async function analyzeBotTimingAndDisplay(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  spinner: Ora,
  calculateExpectedTime: (lastCommitTime: Date) => Date | null
): Promise<{
  botTimings: BotResponseTiming[];
  expectedBotResponseTime: Date | null;
}> {
  const chalk = require('chalk');
  const { debug } = require('../logger.js');
  const { formatDuration } = require('../ui/reporter.js');
  
  let lastCommitTime: Date | null = null;
  let botTimings: BotResponseTiming[] = [];
  let expectedBotResponseTime: Date | null = null;
  
  try {
    spinner.start('Analyzing bot response timing...');
    
    // Get commits to find last commit time
    const commits = await github.getPRCommits(owner, repo, prNumber);
    if (commits.length > 0) {
      lastCommitTime = commits[commits.length - 1].committedDate;
    }
    
    botTimings = await github.analyzeBotResponseTiming(owner, repo, prNumber);
    spinner.stop();
    
    if (botTimings.length > 0) {
      console.log(chalk.cyan('\n📊 Bot Response Timing (observed on this PR):'));
      for (const timing of botTimings) {
        console.log(chalk.gray(
          `   ${timing.botName}: ${formatDuration(timing.minResponseMs)} / ${formatDuration(timing.avgResponseMs)} / ${formatDuration(timing.maxResponseMs)} (min/avg/max, n=${timing.responseCount})`
        ));
      }
      // Recommend wait time based on max observed
      const maxWait = Math.max(...botTimings.map(t => t.maxResponseMs));
      const recommendedWait = Math.ceil(maxWait / 1000 / 30) * 30; // Round up to nearest 30s
      console.log(chalk.gray(`   Recommended wait after push: ~${recommendedWait}s`));
      
      // Calculate when we expect bot reviews to arrive
      if (lastCommitTime) {
        expectedBotResponseTime = calculateExpectedTime(lastCommitTime);
        if (expectedBotResponseTime) {
          const now = new Date();
          const msUntilExpected = expectedBotResponseTime.getTime() - now.getTime();
          if (msUntilExpected > 0) {
            console.log(chalk.cyan(`   📅 Expecting new bot reviews in ~${formatDuration(msUntilExpected)}`));
            console.log(chalk.gray('      Will check for new issues while working...'));
          } else {
            console.log(chalk.cyan('   📅 Bot reviews may already be available'));
          }
        }
      }
    } else {
      console.log(chalk.gray('No bot response timing data available yet'));
    }
  } catch (err) {
    debug('Bot timing analysis failed (non-critical)', { error: err });
  }
  
  return { botTimings, expectedBotResponseTime };
}

/**
 * Check CodeRabbit status and trigger if needed
 */
export async function checkCodeRabbitStatus(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  branch: string,
  headSha: string,
  spinner: Ora
): Promise<void> {
  const chalk = require('chalk');
  const { debug, info } = require('../logger.js');
  
  try {
    spinner.start('Checking CodeRabbit status...');
    const crResult = await github.triggerCodeRabbitIfNeeded(
      owner, repo, prNumber, branch, headSha
    );
    
    if (crResult.mode === 'none') {
      spinner.info('CodeRabbit: not configured for this repo');
    } else if (crResult.reviewedCurrentCommit) {
      spinner.succeed(`CodeRabbit: already reviewed ${headSha.substring(0, 7)} ✓`);
    } else if (crResult.triggered) {
      spinner.succeed(`CodeRabbit: triggered review (${crResult.mode} mode)`);
      info('CodeRabbit review requested - it will analyze while we work');
    } else if (crResult.mode === 'auto') {
      spinner.info(`CodeRabbit: auto mode - will review automatically`);
    } else {
      spinner.info(`CodeRabbit: ${crResult.reason}`);
    }
    debug('CodeRabbit startup check', crResult);
  } catch (err) {
    spinner.warn('Could not check CodeRabbit status (continuing anyway)');
    debug('CodeRabbit startup check failed', { error: err });
  }
}

/**
 * Setup workdir and initialize all managers (state, lessons, lock)
 */
export async function setupWorkdirAndManagers(
  config: Config,
  options: CLIOptions,
  owner: string,
  repo: string,
  prNumber: number,
  prInfo: PRInfo
): Promise<{
  workdir: string;
  stateContext: StateContext;
  lessonsContext: LessonsContext;
  lockConfig: LockConfig;
}> {
  const chalk = require('chalk');
  const { debug } = require('../logger.js');
  const { debugStep } = require('../logger.js');
  const { getWorkdirInfo, ensureWorkdir } = require('../git/workdir.js');
  const { LessonsManager } = require('../state/lessons.js');
  
  // Setup workdir (includes branch in hash for repos with PRs on different target branches)
  debugStep('SETTING UP WORKDIR');
  const workdirInfo = getWorkdirInfo(config.workdirBase, owner, repo, prNumber, prInfo.branch);
  const workdir = workdirInfo.path;
  debug('Workdir info', workdirInfo);
  
  if (workdirInfo.exists) {
    console.log(chalk.gray(`Reusing existing workdir: ${workdir}`));
    console.log(chalk.gray(`  → ${workdirInfo.identifier}`));
  } else {
    console.log(chalk.gray(`Creating workdir: ${workdir}`));
    console.log(chalk.gray(`  → ${workdirInfo.identifier}`));
  }

  await ensureWorkdir(workdir);

  // Initialize state context
  debugStep('LOADING STATE');
  const stateContext = createStateContext(workdir);
  setPhase(stateContext, 'init');
  const state = await State.loadState(
    stateContext,
    `${owner}/${repo}#${prNumber}`, 
    prInfo.branch,
    prInfo.headSha
  );
  debug('Loaded state', {
    iterations: state.iterations.length,
    verifiedFixed: state.verifiedFixed.length,
  });

  // Initialize lessons manager (branch-permanent storage)
  // WHY: Lessons help the fixer avoid repeating mistakes
  const lessonsContext = new LessonsManager(owner, repo, prInfo.branch);
  if (options.noClaudeMd) {
    lessonsContext.setSkipClaudeMd(true);
  }
  lessonsContext.setWorkdir(workdir); // Enable repo-based lesson sharing
  await lessonsContext.load();
  
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
  const prunedDeletedFiles = lessonsContext.pruneDeletedFiles(workdir);
  if (prunedDeletedFiles > 0) {
    console.log(chalk.gray(`Pruned ${prunedDeletedFiles} lessons for deleted files`));
    await LessonsAPI.Save.save(lessonsContext);
  }
  
  const lessonCounts = LessonsAPI.Retrieve.getCounts(lessonsContext);
  debug('Loaded lessons', lessonCounts);
  
  return { workdir, stateContext, lessonsContext, lockConfig };
}
