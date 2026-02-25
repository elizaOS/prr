/**
 * Fixer error handling workflow functions
 * Handles various error types from fixer tools (permission, auth, environment, rapid failures)
 */

import chalk from 'chalk';
import type { Runner } from '../runners/types.js';
import type { StateContext } from '../state/state-context.js';
import * as Performance from '../state/state-performance.js';
import { debug, formatDuration } from '../logger.js';

import { RAPID_FAILURE_THRESHOLD_MS, MAX_RAPID_FAILURES, RAPID_FAILURE_WINDOW_MS } from '../constants.js';
const RAPID_FAILURE_MS = RAPID_FAILURE_THRESHOLD_MS;

/**
 * Handle fixer tool errors (permission, auth, environment, rapid failures)
 * Returns whether to exit the run and whether to disable this runner for the rest of the run.
 */
export function handleFixerError(
  result: { success: boolean; error?: string; errorType?: string; output?: string },
  runner: Runner,
  fixerTime: number,
  rapidFailureCount: number,
  lastFailureTime: number,
  stateContext: StateContext,
  getCurrentModel: () => string | null | undefined
): {
  shouldExit: boolean;
  skipRunnerForRun: boolean;
  rapidFailureCount: number;
  lastFailureTime: number;
} {
  console.log(chalk.red(`\n${runner.name} failed (${formatDuration(fixerTime)}):`, result.error));

  // TOOL_CONFIG: CLI/version mismatch (e.g. unknown option) — skip this tool for rest of run
  // WHY: Rotating models won't help; the binary doesn't support the flag. Caller will disable runner and rotate.
  if (result.errorType === 'tool_config') {
    console.log(chalk.yellow(`\n⚠ TOOL CONFIG: ${runner.name} doesn't support this CLI (e.g. wrong version)`));
    console.log(chalk.gray('  Skipping this tool for the rest of the run.'));
    debug('Skipping runner for rest of run (tool_config)', { tool: runner.name, error: result.error });
    return { shouldExit: false, skipRunnerForRun: true, rapidFailureCount, lastFailureTime };
  }
  
  // PERMISSION ERRORS: Bail out immediately - don't waste tokens
  // WHY: If the tool can't write files, retrying won't help. User needs to fix permissions.
  if (result.errorType === 'permission') {
    console.log(chalk.red('\n⛔ PERMISSION ERROR: Fixer tool cannot write to files'));
    console.log(chalk.yellow('  Bailing out - retrying won\'t help.'));
    if (result.error) {
      console.log(chalk.cyan(`  ${result.error}`));
    }
    debug('Bailing out due to permission error', { tool: runner.name, error: result.error });
    // Don't record as lesson - this is an environment/config issue, not a code issue
    return { shouldExit: true, skipRunnerForRun: false, rapidFailureCount, lastFailureTime };
  }
  
  // AUTH ERRORS: Also bail out - retrying won't help
  if (result.errorType === 'auth') {
    console.log(chalk.red('\n⛔ AUTHENTICATION ERROR: API key or auth issue'));
    console.log(chalk.yellow('  Check your API keys and authentication.'));
    debug('Bailing out due to auth error', { tool: runner.name, error: result.error });
    return { shouldExit: true, skipRunnerForRun: false, rapidFailureCount, lastFailureTime };
  }
  
  // MODEL ERRORS: Wrong model for this runner — don't bail, just rotate
  // WHY: This happens when LLM-recommended models from a previous runner rotation
  // leak through to an incompatible runner (e.g., claude-sonnet → codex).
  // The runner's guard caught it; we should rotate to the next model, not exit.
  if (result.errorType === 'model') {
    console.log(chalk.yellow(`\n⚠ MODEL MISMATCH: ${result.error}`));
    console.log(chalk.gray('  Will rotate to next model...'));
    debug('Model mismatch - will rotate', { tool: runner.name, error: result.error });
    Performance.recordModelError(stateContext, runner.name, getCurrentModel() || undefined);
    return { shouldExit: false, skipRunnerForRun: false, rapidFailureCount, lastFailureTime };
  }
  
  // QUOTA/RATE-LIMIT ERRORS: Rotate to a different tool/model, don't bail
  // WHY: Quota exceeded means this specific API key hit its limit.
  // A different tool (e.g., codex → claude-code) uses a different API and may still work.
  if (result.errorType === 'quota') {
    console.log(chalk.yellow(`\n⚠ QUOTA/RATE LIMIT: ${result.error}`));
    console.log(chalk.gray('  Will rotate to next tool/model...'));
    debug('Quota exceeded - rotating', { tool: runner.name, error: result.error });
    Performance.recordModelError(stateContext, runner.name, getCurrentModel() || undefined);
    return { shouldExit: false, skipRunnerForRun: false, rapidFailureCount, lastFailureTime };
  }

  // 504/GATEWAY TIMEOUT: Rotate immediately; skip single-issue (same model would 504 again).
  // WHY: After retries exhausted, another attempt with same model burns ~10min with no gain.
  if (result.errorType === 'timeout') {
    console.log(chalk.yellow(`\n⚠ GATEWAY TIMEOUT (504): ${result.error}`));
    console.log(chalk.gray('  Will rotate to next model...'));
    debug('504/timeout - rotating', { tool: runner.name, error: result.error });
    Performance.recordModelError(stateContext, runner.name, getCurrentModel() || undefined);
    return { shouldExit: false, skipRunnerForRun: false, rapidFailureCount, lastFailureTime };
  }
  
  // ENVIRONMENT ERRORS: Tool environment issue (e.g., TTY/cursor position)
  // WHY: These are infrastructure issues that won't fix themselves with retries.
  // The tool needs a different environment (real TTY, GUI, etc.)
  if (result.errorType === 'environment') {
    console.log(chalk.red('\n⛔ ENVIRONMENT ERROR: Tool requires different runtime environment'));
    console.log(chalk.yellow('  This tool may require an interactive terminal or GUI.'));
    if (result.error) {
      console.log(chalk.cyan(`  ${result.error}`));
    }
    console.log(chalk.yellow('\n  Suggestions:'));
    console.log(chalk.yellow('    - Try a different tool: --tool cursor or --tool claude-code'));
    console.log(chalk.yellow('    - Run prr in an interactive terminal (not CI/cron)'));
    console.log(chalk.yellow('    - Use --tool llm-api as a fallback (direct LLM without TUI)'));
    debug('Bailing out due to environment error', { tool: runner.name, error: result.error });
    return { shouldExit: true, skipRunnerForRun: false, rapidFailureCount, lastFailureTime };
  }

  // RAPID FAILURE DETECTION: Bail out if tool fails multiple times rapidly
  const now = Date.now();
  const isRapidFailure = fixerTime > 0 && fixerTime <= RAPID_FAILURE_MS;
  let newRapidCount = rapidFailureCount;
  let newLastFailureTime = lastFailureTime;
  
  if (isRapidFailure) {
    if (now - lastFailureTime > RAPID_FAILURE_WINDOW_MS) {
      newRapidCount = 0;
    }
    newRapidCount++;
    newLastFailureTime = now;

    if (newRapidCount >= MAX_RAPID_FAILURES) {
      console.log(chalk.red('\n⛔ FAST-FAIL: Repeated rapid tool failures detected'));
      console.log(chalk.yellow(`  ${runner.name} failed ${newRapidCount} times within ${formatDuration(RAPID_FAILURE_WINDOW_MS)}.`));
      console.log(chalk.yellow('  Aborting to avoid a tight retry loop.'));
      debug('Bailing out due to rapid failures', { tool: runner.name, error: result.error, duration: fixerTime });
      return { shouldExit: true, skipRunnerForRun: false, rapidFailureCount: newRapidCount, lastFailureTime: newLastFailureTime };
    }
  } else {
    newRapidCount = 0;
  }
  
  // DON'T record transient tool failures as lessons
  // WHY: "connection stalled", "model unavailable" aren't actionable for future fixes
  // Only code-related lessons (fix rejected, wrong approach) are useful
  debug('Tool failure (not recorded as lesson)', { tool: runner.name, error: result.error });
  
  // Track model error for performance stats
  Performance.recordModelError(stateContext, runner.name, getCurrentModel() || undefined);
  
  return {
    shouldExit: false,
    skipRunnerForRun: false,
    rapidFailureCount: newRapidCount,
    lastFailureTime: newLastFailureTime,
  };
}

// NOTE: The "no changes" verification workflow is handled exclusively by
// handleNoChangesWithVerification in no-changes-verification.ts.
// A duplicate handleNoChanges function was removed from here to prevent
// divergent logic (the duplicate used broader "already fixed" detection).
