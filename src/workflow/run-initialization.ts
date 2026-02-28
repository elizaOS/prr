/**
 * Resolver run() initialization
 * 
 * Handles startup tasks:
 * 1. Parse PR URL
 * 2. Handle cleanup-only modes
 * 3. Show mode warnings (dry-run, no-commit, no-push)
 * 4. Fetch PR info
 * 5. Check PR status (CI/bots)
 * 6. Analyze bot response timing
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import type { GitHubAPI } from '../github/api.js';
import type { PRInfo, BotResponseTiming } from '../github/types.js';
import type { CLIOptions } from '../cli.js';
import { parsePRUrl } from '../github/types.js';
import { 
  debug,
  debugStep,
  warn, 
  info,
  startTimer, 
  endTimer,
  setVerbose, 
  resetTimings, 
  resetTokenUsage 
} from '../logger.js';
import * as ResolverProc from '../resolver-proc.js';

/**
 * Initialize the PR resolver run
 * 
 * WORKFLOW:
 * 1. Enable verbose logging
 * 2. Reset timings and token usage
 * 3. Parse PR URL
 * 4. Check for cleanup-only modes (exit early if cleanup)
 * 5. Show mode warnings
 * 6. Fetch PR info
 * 7. Check PR status (CI/bots)
 * 8. Analyze bot timing
 * 
 * @returns Parsed PR info and initialization results, or null if cleanup-only mode
 */
export async function initializeRun(
  prUrl: string,
  github: GitHubAPI,
  options: CLIOptions,
  spinner: Ora,
  runCleanupMode: (prUrl: string, owner: string, repo: string, number: number) => Promise<void>,
  calculateExpectedBotResponseTime: (lastCommitTime: Date) => Date | null
): Promise<{
  owner: string;
  repo: string;
  number: number;
  prInfo: PRInfo;
  botTimings: BotResponseTiming[];
  expectedBotResponseTime: Date | null;
  isCleanupMode: boolean;
} | null> {
  // Enable verbose logging if requested
  setVerbose(options.verbose);

  debugStep('INITIALIZATION');
  resetTimings();
  resetTokenUsage();
  startTimer('Total');
  
  // Parse PR URL
  debug('Parsing PR URL', prUrl);
  const { owner, repo, number } = parsePRUrl(prUrl);
  debug('Parsed PR info', { owner, repo, number });
  
  console.log(chalk.blue(`\nProcessing PR: ${owner}/${repo}#${number}\n`));
  
  // Handle cleanup-only modes
  const isCleanupMode = options.cleanClaudeMd || options.cleanAgentsMd || options.cleanState || options.cleanAll || options.clearLock;
  if (isCleanupMode) {
    await runCleanupMode(prUrl, owner, repo, number);
    return null;  // Signal cleanup-only mode
  }
  
  // Show mode warnings
  if (options.noCommit) {
    warn('NO-COMMIT MODE: Changes will be made but not committed');
  }
  if (options.noPush && !options.noCommit) {
    info('NO-PUSH MODE: Changes will be committed locally but not pushed');
  }
  if (options.dryRun) {
    info('DRY-RUN MODE: No changes will be made');
  }

  // Get PR info
  debugStep('FETCHING PR INFO');
  startTimer('Fetch PR info');
  spinner.start('Fetching PR information...');
  let prInfo;
  try {
    prInfo = await github.getPRInfo(owner, repo, number);
  } catch (err) {
    spinner.fail('Failed to fetch PR info');
    throw err;
  }
  spinner.succeed(`PR branch: ${prInfo.branch}`);
  debug('PR info', prInfo);
  endTimer('Fetch PR info');

  // Check PR status (are bots still running?)
  debugStep('CHECKING PR STATUS');
  spinner.start('Checking CI/bot status...');
  let prStatus;
  try {
    prStatus = await github.getPRStatus(owner, repo, number, prInfo.headSha);
  } catch (err) {
    spinner.warn('Failed to fetch PR status');
    throw err;
  }
  spinner.stop();
  
  // Display PR status
  ResolverProc.displayPRStatus(prStatus);

  // Analyze bot response timing
  // WHY: Helps user understand how long to wait for bot reviews after pushing
  // Also stored for smart wait scheduling after pushes
  debugStep('ANALYZING BOT TIMING');
  const timingResult = await ResolverProc.analyzeBotTimingAndDisplay(
    github,
    owner,
    repo,
    number,
    spinner,
    calculateExpectedBotResponseTime
  );

  return {
    owner,
    repo,
    number,
    prInfo,
    botTimings: timingResult.botTimings,
    expectedBotResponseTime: timingResult.expectedBotResponseTime,
    isCleanupMode: false,
  };
}
