/**
 * Smart wait after push for bot re-review (timing, rate limits, early completion).
 * Extracted from resolver-proc.ts (structural refactor).
 */
import chalk from 'chalk';
import type { BotResponseTiming, PRStatus, ReviewComment } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { StateContext } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import { debug, formatDuration, formatNumber } from '../../../shared/logger.js';
import { sleep } from './utils.js';

/**
 * Calculate smart wait time based on bot timing data and PR status
 */
export async function calculateSmartWaitTime(
  botTimings: BotResponseTiming[],
  pollInterval: number,
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<{ waitSeconds: number; reason: string; skipWait: boolean }> {
  const defaultWait = pollInterval;

  let prStatus: PRStatus | undefined;
  try {
    prStatus = await github.getPRStatus(owner, repo, prNumber, headSha);
  } catch {
    // Ignore errors fetching status
  }

  const skipWait = !!(prStatus && prStatus.totalChecks === 0);

  const activelyReviewing = (prStatus?.activelyReviewingBots?.length ?? 0) > 0;

  const checksRunning = (prStatus?.inProgressChecks?.length ?? 0) > 0 ||
                        (prStatus?.pendingChecks?.length ?? 0) > 0;

  if (botTimings.length > 0) {
    const maxObserved = Math.max(...botTimings.map(t => t.maxResponseMs));
    const avgObserved = Math.round(
      botTimings.reduce((sum, t) => sum + t.avgResponseMs, 0) / botTimings.length
    );

    let waitMs: number;
    let reason: string;

    if (activelyReviewing) {
      waitMs = Math.ceil(maxObserved * 1.2);
      reason = `bot actively reviewing (max observed: ${formatDuration(maxObserved)})`;
    } else if (checksRunning) {
      waitMs = Math.ceil((avgObserved + maxObserved) / 2);
      reason = `CI checks running (avg: ${formatDuration(avgObserved)})`;
    } else {
      waitMs = Math.ceil(avgObserved * 1.1);
      reason = `based on avg response time (${formatDuration(avgObserved)})`;
    }

    const minWaitMs = 30 * 1000;
    const maxWaitMs = 5 * 60 * 1000;
    waitMs = Math.max(minWaitMs, Math.min(maxWaitMs, waitMs));

    return { waitSeconds: Math.ceil(waitMs / 1000), reason, skipWait };
  }

  if (activelyReviewing) {
    return { waitSeconds: Math.max(defaultWait, 90), reason: 'bot actively reviewing (no timing data)', skipWait };
  }

  if (checksRunning) {
    return { waitSeconds: Math.max(defaultWait, 60), reason: 'CI checks running (no timing data)', skipWait };
  }

  return { waitSeconds: defaultWait, reason: 'default poll interval (no timing data)', skipWait };
}

const BOT_RATE_LIMIT_PERSIST_MS = 15 * 60 * 1000;

/**
 * Wait for bot reviews after push with smart timing and progress feedback.
 */
export async function waitForBotReviews(
  botTimings: BotResponseTiming[],
  pollInterval: number,
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  stateContext?: StateContext
): Promise<void> {
  let { waitSeconds, reason, skipWait } = await calculateSmartWaitTime(
    botTimings,
    pollInterval,
    github,
    owner,
    repo,
    prNumber,
    headSha
  );

  if (skipWait) {
    return;
  }

  const now = Date.now();
  const persisted = stateContext?.state?.botRateLimitDetectedAt;
  if (persisted && typeof persisted === 'object') {
    for (const [bot, at] of Object.entries(persisted)) {
      const t = at ? new Date(at).getTime() : 0;
      if (Number.isFinite(t) && now - t < BOT_RATE_LIMIT_PERSIST_MS) {
        const capped = Math.min(waitSeconds, 60);
        if (waitSeconds > capped) {
          waitSeconds = capped;
          reason = `persisted ${bot} rate-limit — short wait`;
        }
        break;
      }
    }
  }

  try {
    const rateLimits = await github.checkBotRateLimits(owner, repo, prNumber);
    const limited = rateLimits.filter(r => r.rateLimited);
    if (limited.length > 0) {
      for (const rl of limited) {
        console.log(chalk.yellow(`\n  ⚠ ${rl.bot} appears rate-limited: ${rl.message ?? 'review paused/cancelled'}`));
      }
      const cappedWait = Math.min(waitSeconds, 60);
      if (waitSeconds > cappedWait) {
        console.log(chalk.yellow(`  Reducing wait from ${waitSeconds}s → ${cappedWait}s (bot rate-limited; full wait unlikely to help)`));
        waitSeconds = cappedWait;
        reason = `bot rate-limited (${limited.map(r => r.bot).join(', ')}) — short wait`;
      }
      if (stateContext?.state) {
        if (!stateContext.state.botRateLimitDetectedAt) stateContext.state.botRateLimitDetectedAt = {};
        const iso = new Date().toISOString();
        for (const rl of limited) {
          stateContext.state.botRateLimitDetectedAt[rl.bot] = iso;
        }
        await State.saveState(stateContext);
      }
    }
  } catch {
    // Non-fatal
  }

  console.log(chalk.gray(`\nWaiting ${waitSeconds}s for re-review (${reason})...`));

  const checkInterval = 15;
  let remaining = waitSeconds;
  let elapsedSinceLastCheck = 0;

  while (remaining > 0) {
    const sleepTime = Math.min(remaining, checkInterval);
    await sleep(sleepTime * 1000);
    remaining -= sleepTime;
    elapsedSinceLastCheck += sleepTime;

    if (remaining > 0 && elapsedSinceLastCheck >= 30) {
      elapsedSinceLastCheck = 0;
      try {
        const status = await github.getPRStatus(owner, repo, prNumber, headSha);
        const stillActive = (status.activelyReviewingBots?.length ?? 0) > 0 ||
                            (status.botsWithEyesReaction?.length ?? 0) > 0;

        if (!stillActive && status.ciState !== 'pending') {
          console.log(chalk.green('  Bot reviews appear complete, proceeding...'));
          return;
        } else {
          console.log(chalk.gray(`  Still waiting... (${remaining}s remaining)`));
        }
      } catch {
        // Ignore status check errors during wait
      }
    }
  }
}

export async function checkForNewBotReviews(
  _expectedBotResponseTime: Date | null,
  botTimings: BotResponseTiming[],
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  existingCommentIds: Set<string>
): Promise<{
  newComments: ReviewComment[] | null;
  message: string | null;
  lastCommentFetchTime: Date | null;
  updatedExpectedBotResponseTime: Date | null;
}> {
  try {
    const freshComments = await github.getReviewComments(owner, repo, prNumber);
    const newComments = freshComments.filter(c => !existingCommentIds.has(c.id));
    const now = new Date();

    if (newComments.length > 0) {
      debug('New bot review comments', { count: newComments.length });
      let nextExpectedTime: Date | null = null;
      if (botTimings.length > 0) {
        const maxResponseMs = Math.max(...botTimings.map(t => t.maxResponseMs));
        nextExpectedTime = new Date(Date.now() + maxResponseMs);
      }
      return {
        newComments,
        message: `Found ${formatNumber(newComments.length)} new review comment(s) (e.g. CodeRabbit) — added to queue`,
        lastCommentFetchTime: now,
        updatedExpectedBotResponseTime: nextExpectedTime,
      };
    }
    return {
      newComments: null,
      message: null,
      lastCommentFetchTime: now,
      updatedExpectedBotResponseTime: new Date(Date.now() + 30 * 1000),
    };
  } catch (err) {
    debug('Failed to check for new comments', { error: err });
    return {
      newComments: null,
      message: null,
      lastCommentFetchTime: null,
      updatedExpectedBotResponseTime: new Date(Date.now() + 30 * 1000),
    };
  }
}
