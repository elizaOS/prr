/**
 * Startup workflow functions for PR processing
 * Handles initialization, PR status checks, bot timing analysis, etc.
 */

import type { Ora } from 'ora';
import type { GitHubAPI } from '../github/api.js';
import type { PRInfo, BotResponseTiming, PRStatus, ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { createStateContext, setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import * as Lock from '../state/lock-functions.js';
import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import * as LessonsAPI from '../state/lessons-index.js';
import chalk from 'chalk';
import { warn, info, debug, debugStep, formatDuration } from '../logger.js';
import { getWorkdirInfo, ensureWorkdir } from '../git/workdir.js';

/**
 * Display PR status including CI checks, bot reviews, and overall activity
 */
export function displayPRStatus(prStatus: PRStatus): void {
  
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
      // Recommend wait time based on 75th percentile (not max — outliers waste time).
      // Cap at 5 minutes: any bot that takes longer will be caught by the early-exit
      // polling in waitForBotReviews, so waiting the full max is wasteful.
      const MAX_RECOMMENDED_WAIT_S = 300; // 5 minutes
      const allDelays = botTimings.flatMap(t => t.responseTimes?.map(r => r.delayMs) ?? [t.avgResponseMs]);
      allDelays.sort((a, b) => a - b);
      const p75Index = Math.floor(allDelays.length * 0.75);
      const p75Wait = allDelays[p75Index] ?? allDelays[allDelays.length - 1] ?? 120_000;
      const recommendedWait = Math.min(
        Math.ceil(p75Wait / 1000 / 30) * 30, // Round up to nearest 30s
        MAX_RECOMMENDED_WAIT_S
      );
      console.log(chalk.gray(`   Recommended wait after push: ~${recommendedWait}s (p75, capped at ${MAX_RECOMMENDED_WAIT_S}s)`));
      
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
    spinner.warn('Bot timing analysis failed (non-critical)');
    debug('Bot timing analysis failed (non-critical)', { error: err });
  }
  
  return { botTimings, expectedBotResponseTime };
}

/**
 * Check CodeRabbit status and trigger if needed
 */
/**
 * Check CodeRabbit status and trigger review if needed.
 *
 * WHY prefetchedComments in return: When we wait for CodeRabbit, the polling loop
 * already fetches the full review comment list. Returning it here lets the caller
 * skip the identical fetch in the "FETCHING REVIEW COMMENTS" phase — saving ~3 API
 * pages and several seconds on a 200+ comment PR.
 */
export async function checkCodeRabbitStatus(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  branch: string,
  headSha: string,
  spinner: Ora
): Promise<{ triggered: boolean; reviewedCurrentCommit: boolean; prefetchedComments?: ReviewComment[] }> {
  try {
    spinner.start('Checking CodeRabbit status...');
    const crResult = await github.triggerCodeRabbitIfNeeded(
      owner, repo, prNumber, branch, headSha
    );
    
    let prefetchedComments: ReviewComment[] | undefined;
    
    if (crResult.mode === 'none') {
      spinner.info('CodeRabbit: not configured for this repo');
    } else if (crResult.reviewedCurrentCommit) {
      spinner.succeed(`CodeRabbit: already reviewed ${headSha.substring(0, 7)} ✓`);
    } else if (crResult.triggered) {
      spinner.succeed(`CodeRabbit: triggered review (${crResult.mode} mode)`);
      info('CodeRabbit review requested - waiting for review to complete');
      
      // Wait for CodeRabbit to finish reviewing before proceeding.
      // The polling loop fetches comments anyway; capture them for reuse.
      prefetchedComments = await waitForCodeRabbitReview(github, owner, repo, prNumber, headSha, spinner);
    } else if (crResult.mode === 'auto') {
      spinner.info(`CodeRabbit: auto mode - will review automatically`);
    } else {
      spinner.info(`CodeRabbit: ${crResult.reason}`);
    }

    // Check for bot rate-limit signals (e.g. CodeRabbit posting "review paused")
    try {
      const rateLimits = await github.checkBotRateLimits(owner, repo, prNumber);
      const limited = rateLimits.filter(r => r.rateLimited);
      if (limited.length > 0) {
        for (const rl of limited) {
          console.log(chalk.yellow(`  ⚠ ${rl.bot} rate-limited: ${rl.message ?? 'review paused/cancelled'}`));
        }
        console.log(chalk.yellow('  Will extend wait times after pushes to let bots recover.'));
      }
    } catch {
      // Non-fatal
    }

    debug('CodeRabbit startup check', crResult);
    return { triggered: crResult.triggered ?? false, reviewedCurrentCommit: crResult.reviewedCurrentCommit ?? false, prefetchedComments };
  } catch (err) {
    spinner.warn('Could not check CodeRabbit status (continuing anyway)');
    debug('CodeRabbit startup check failed', { error: err });
    return { triggered: false, reviewedCurrentCommit: false };
  }
}

/**
 * Wait for CodeRabbit to complete its review by polling for new review comments.
 * Polls every 15s for up to 5 minutes.
 * Captures the baseline comment count before waiting to detect *new* comments only.
 *
 * WHY return the comments: The polling loop already fetches the full comment list from
 * GitHub (3+ GraphQL pages). The caller immediately fetches them again in the "FETCHING
 * REVIEW COMMENTS" phase. Returning the last-fetched set avoids a redundant API call.
 */
async function waitForCodeRabbitReview(
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  spinner: Ora
): Promise<ReviewComment[]> {
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes
  const pollIntervalMs = 15_000; // 15 seconds
  const startTime = Date.now();
  
  // Snapshot comment count before waiting so we detect *new* comments
  let lastFetchedComments: ReviewComment[] = [];
  try {
    lastFetchedComments = await github.getReviewComments(owner, repo, prNumber);
  } catch {
    // Ignore baseline failures; fall back to empty
  }
  const baselineCount = lastFetchedComments.length;
  
  spinner.start(`Waiting for CodeRabbit review of ${headSha.substring(0, 7)}...`);
  
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    
    try {
      // Check if CodeRabbit has posted a review for this commit
      const status = await github.getPRStatus(owner, repo, prNumber, headSha);
      const stillReviewing = (status.activelyReviewingBots?.length ?? 0) > 0 ||
                              (status.botsWithEyesReaction?.length ?? 0) > 0;
      
      if (!stillReviewing) {
        // Check if there are any new review comments (CodeRabbit may have finished)
        const comments = await github.getReviewComments(owner, repo, prNumber);
        lastFetchedComments = comments;
        if (comments.length > baselineCount) {
          spinner.succeed(`CodeRabbit review received (${elapsed}s)`);
          return lastFetchedComments;
        }
      }
      
      spinner.text = `Waiting for CodeRabbit review of ${headSha.substring(0, 7)}... (${elapsed}s)`;
    } catch (err) {
      debug('Error polling for CodeRabbit review', { error: err });
      // Continue polling on errors
    }
  }
  
  // Timed out - proceed anyway, return last fetched comments
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  spinner.warn(`CodeRabbit review not received after ${elapsed}s, proceeding anyway`);
  return lastFetchedComments;
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
  const localStorePath = LessonsAPI.Paths.getLocalLessonsPath(owner, repo, prInfo.branch);
  const lessonsContext = LessonsAPI.createLessonsContext(owner, repo, prInfo.branch, localStorePath);
  if (options.noClaudeMd) {
    LessonsAPI.setSkipClaudeMd(lessonsContext, true);
  }
  if (options.noAgentsMd) {
    LessonsAPI.setSkipAgentsMd(lessonsContext, true);
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
  
  return { workdir, stateContext, lessonsContext, lockConfig };
}
