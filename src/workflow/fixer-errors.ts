/**
 * Fixer error handling workflow functions
 * Handles various error types from fixer tools (permission, auth, environment, rapid failures)
 */

import type { Runner } from '../runners/types.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { LLMClient } from '../llm/client.js';

// Error type constants
const RAPID_FAILURE_MS = 2000;
const MAX_RAPID_FAILURES = 3;
const RAPID_FAILURE_WINDOW_MS = 10_000;

/**
 * Handle fixer tool errors (permission, auth, environment, rapid failures)
 * Returns whether to exit the run
 */
export function handleFixerError(
  result: { success: boolean; error?: string; errorType?: string; output?: string },
  runner: Runner,
  fixerTime: number,
  rapidFailureCount: number,
  lastFailureTime: number,
  stateManager: StateManager,
  getCurrentModel: () => string | null | undefined
): {
  shouldExit: boolean;
  rapidFailureCount: number;
  lastFailureTime: number;
} {
  const chalk = require('chalk');
  const { debug } = require('../logger.js');
  const { formatDuration } = require('../ui/reporter.js');
  
  console.log(chalk.red(`\n${runner.name} failed (${formatDuration(fixerTime)}):`, result.error));
  
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
    return { shouldExit: true, rapidFailureCount, lastFailureTime };
  }
  
  // AUTH ERRORS: Also bail out - retrying won't help
  if (result.errorType === 'auth') {
    console.log(chalk.red('\n⛔ AUTHENTICATION ERROR: API key or auth issue'));
    console.log(chalk.yellow('  Check your API keys and authentication.'));
    debug('Bailing out due to auth error', { tool: runner.name, error: result.error });
    return { shouldExit: true, rapidFailureCount, lastFailureTime };
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
    return { shouldExit: true, rapidFailureCount, lastFailureTime };
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
      return { shouldExit: true, rapidFailureCount: newRapidCount, lastFailureTime: newLastFailureTime };
    }
  } else {
    newRapidCount = 0;
  }
  
  // DON'T record transient tool failures as lessons
  // WHY: "connection stalled", "model unavailable" aren't actionable for future fixes
  // Only code-related lessons (fix rejected, wrong approach) are useful
  debug('Tool failure (not recorded as lesson)', { tool: runner.name, error: result.error });
  
  // Track model error for performance stats
  stateManager.recordModelError(runner.name, getCurrentModel() || undefined);
  
  return { 
    shouldExit: false, 
    rapidFailureCount: newRapidCount, 
    lastFailureTime: newLastFailureTime 
  };
}

/**
 * Handle "no changes" case from fixer - verify if issues are actually fixed
 */
export async function handleNoChanges(
  unresolvedIssues: UnresolvedIssue[],
  runner: Runner,
  result: { output?: string },
  llm: LLMClient,
  stateManager: StateManager,
  lessonsManager: LessonsManager,
  verifiedThisSession: Set<string>,
  getCurrentModel: () => string | null | undefined,
  parseNoChangesExplanation: (output?: string) => string | null
): Promise<{
  shouldContinue: boolean;
  shouldBreak: boolean;
  progressMade: number;
  exitReason?: string;
  exitDetails?: string;
  consecutiveFailures: number;
}> {
  const chalk = require('chalk');
  const { debug } = require('../logger.js');
  const { formatNumber } = require('../ui/reporter.js');
  
  const currentModel = getCurrentModel();
  console.log(chalk.yellow(`\nNo changes made by ${runner.name}${currentModel ? ` (${currentModel})` : ''}`));

  // Parse fixer output for NO_CHANGES explanation
  const noChangesExplanation = parseNoChangesExplanation(result.output);

  if (noChangesExplanation) {
    // Fixer provided an explanation for why it made no changes
    console.log(chalk.cyan(`  Fixer's explanation: ${noChangesExplanation}`));
    // Note: Don't include tool/model names - that's tracked separately in modelStats
    lessonsManager.addGlobalLesson(`Fixer made no changes: ${noChangesExplanation}`);

    // Store this explanation with each issue (but don't necessarily dismiss - depends on the reason)
    const lowerExplanation = noChangesExplanation.toLowerCase();
    const isAlreadyFixed = lowerExplanation.includes('already') ||
                           lowerExplanation.includes('exists') ||
                           lowerExplanation.includes('has') ||
                           lowerExplanation.includes('implements');

    if (isAlreadyFixed) {
      // Fixer claims issues are already fixed - VERIFY the claim
      console.log(chalk.gray(`  → Fixer believes issues are already addressed - verifying...`));
      
      // Run verification on all unresolved issues to check fixer's claim
      const verifyResults = await llm.batchCheckIssuesExist(
        unresolvedIssues.map((issue, idx) => ({
          id: `issue_${idx + 1}`,
          comment: issue.comment.body,
          filePath: issue.comment.path,
          line: issue.comment.line,
          codeSnippet: issue.codeSnippet,
        }))
      );
      
      let verifiedAsFixed = 0;
      const stillUnresolved: typeof unresolvedIssues = [];
      
      for (let i = 0; i < unresolvedIssues.length; i++) {
        const issue = unresolvedIssues[i];
        const verifyResult = verifyResults.issues.get(`issue_${i + 1}`);
        
        if (verifyResult && !verifyResult.exists) {
          // Issue verified as fixed!
          verifiedAsFixed++;
          stateManager.markCommentVerifiedFixed(issue.comment.id);
          verifiedThisSession.add(issue.comment.id);
          console.log(chalk.green(`    ✓ Verified: ${issue.comment.path}:${issue.comment.line} - ${verifyResult.explanation}`));
        } else {
          // Issue still exists despite fixer's claim
          stillUnresolved.push(issue);
          if (verifyResult) {
            console.log(chalk.yellow(`    ○ Still exists: ${issue.comment.path}:${issue.comment.line} - ${verifyResult.explanation}`));
          }
        }
      }
      
      if (verifiedAsFixed > 0) {
        console.log(chalk.green(`  → Verified ${verifiedAsFixed}/${unresolvedIssues.length} issues as already fixed`));
        stateManager.recordModelFix(runner.name, currentModel || 'unknown', verifiedAsFixed);
        
        // Update unresolved list
        unresolvedIssues.splice(0, unresolvedIssues.length, ...stillUnresolved);
        
        if (unresolvedIssues.length === 0) {
          console.log(chalk.green('\n✓ All issues verified as already fixed'));
          return {
            shouldContinue: false,
            shouldBreak: true,
            progressMade: verifiedAsFixed,
            exitReason: 'all_fixed',
            exitDetails: 'All issues verified as already fixed',
            consecutiveFailures: 0,
          };
        }
        
        // Some verified, some remain - continue with remaining
        return {
          shouldContinue: true,
          shouldBreak: false,
          progressMade: verifiedAsFixed,
          consecutiveFailures: 0,
        };
      } else {
        // Verification REJECTED fixer's claim - none are actually fixed
        console.log(chalk.yellow(`  ✗ Verification rejected fixer's claim - issues still exist`));
      }
    }
    
    // Either not "already fixed" claim or verification rejected it
    // Record as lesson and continue with model rotation
    debug('No changes and not verified as fixed - recording as failure');
    stateManager.recordModelNoChanges(runner.name, currentModel || 'unknown');
    return {
      shouldContinue: false,
      shouldBreak: false,
      progressMade: 0,
      consecutiveFailures: 1, // Indicate failure for consecutive counter
    };
  } else {
    // No explanation provided - fixer just made zero changes
    console.log(chalk.yellow('  (No explanation provided for zero changes)'));
    debug('No changes and no explanation - recording as failure');
    stateManager.recordModelNoChanges(runner.name, currentModel || 'unknown');
    return {
      shouldContinue: false,
      shouldBreak: false,
      progressMade: 0,
      consecutiveFailures: 1,
    };
  }
}
