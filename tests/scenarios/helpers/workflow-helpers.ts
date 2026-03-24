/**
 * Workflow execution helpers for scenario tests
 */

import type { ScenarioContext } from '../../test-utils/scenario-builder.js';
import type { ScenarioResult } from './assertions.js';
import { loadConfig } from '../../../shared/config.js';
import { PRResolver } from '../../../tools/prr/resolver.js';
import { initOutputLog, closeOutputLog } from '../../../shared/logger.js';
import type { CLIOptions } from '../../../tools/prr/cli.js';

/**
 * Run PRR scenario
 * 
 * Executes PRR workflow with mocked GitHub API and LLM client from the scenario context.
 * This allows scenario tests to verify PRR behavior with controlled inputs.
 */
export async function runPRRScenario(
  context: ScenarioContext,
  options: {
    autoPush?: boolean;
    maxFixIterations?: number;
    [key: string]: any;
  } = {}
): Promise<ScenarioResult> {
  // Initialize output logging (scenario tests may want to capture this)
  initOutputLog({});

  try {
    const config = loadConfig();
    const cliOptions: CLIOptions = {
      autoPush: options.autoPush || false,
      noCommit: false,
      noPush: true, // Never push in scenario tests
      dryRun: false,
      verbose: false,
      maxFixIterations: options.maxFixIterations || 3,
      maxPushIterations: 1,
      maxStaleCycles: 2,
      noWaitBot: true, // Skip bot waiting in tests
      noHandoffPrompt: true,
      noAfterAction: false,
      pill: false,
    };

    // Create PRResolver
    const resolver = new PRResolver(config, cliOptions);

    // Override with mocked dependencies from context
    // Note: This requires accessing private properties, which is acceptable for tests
    (resolver as any).github = context.github;
    (resolver as any).llm = context.llm;

    // If context has a repo, we could use it, but PRResolver will clone its own
    // For scenario tests, the mock GitHub API should return the PR info

    // Execute PRR
    const prUrl = `https://github.com/${context.pr.owner}/${context.pr.repo}/pull/${context.pr.number}`;
    await resolver.run(prUrl);

    // Extract results from resolver state
    const stateContext = (resolver as any).stateContext;
    const state = stateContext?.state;
    const finalUnresolvedIssues = (resolver as any).finalUnresolvedIssues || [];

    // Extract fixed, dismissed, and remaining issues
    const verifiedFixed = state?.verifiedFixed || [];
    const verifiedComments = state?.verifiedComments || [];
    const dismissedIssues = state?.dismissedIssues || [];

    // Get committed files from git status (if repo exists)
    const committedFiles: string[] = [];
    if (context.repo) {
      try {
        const status = await context.repo.git.status();
        // Files that were modified and committed
        const allFiles = [
          ...(status.created || []),
          ...(status.modified || []),
          ...(status.deleted || []),
        ];
        committedFiles.push(...allFiles);
      } catch {
        // Git status might fail, ignore
      }
    }

    return {
      success: true,
      outputs: {
        state: {
          verifiedFixed,
          verifiedComments,
          dismissedIssues,
          finalUnresolvedIssues: finalUnresolvedIssues.map((issue: any) => ({
            commentId: issue.comment?.id,
            path: issue.resolvedPath || issue.comment?.path,
            line: issue.comment?.line,
            summary: issue.comment?.body?.split('\n')[0] || '',
          })),
          committedFiles,
        },
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
      outputs: {
        state: {
          verifiedFixed: [],
          dismissedIssues: [],
          committedFiles: [],
        },
      },
    };
  } finally {
    closeOutputLog();
  }
}

/**
 * Run setup phase only
 * 
 * NOTE: This is a placeholder. Full setup phase execution would require
 * more complex integration with PRR's internal workflow functions.
 * For now, scenario tests should use runPRRScenario() for full execution.
 */
export async function runSetupPhase(
  context: ScenarioContext,
  options: any = {}
): Promise<any> {
  // TODO: Execute only setup phase
  // This would call ResolverProc.executeSetupPhase() with mocked dependencies
  return {
    workdir: context.repo?.workdir || '',
    stateContext: null,
  };
}

/**
 * Run analysis phase only
 * 
 * NOTE: This is a placeholder. Full analysis phase execution would require
 * integration with PRR's issue analysis functions.
 */
export async function runAnalysisPhase(
  context: ScenarioContext,
  options: any = {}
): Promise<any> {
  // TODO: Execute only analysis phase
  // This would call findUnresolvedIssues() with mocked dependencies
  return {
    unresolvedIssues: [],
    duplicateMap: new Map(),
  };
}

/**
 * Run single fix iteration
 * 
 * NOTE: This is a placeholder. Full fix iteration execution would require
 * integration with PRR's fix loop functions.
 */
export async function runFixIteration(
  context: ScenarioContext,
  options: any = {}
): Promise<any> {
  // TODO: Execute single fix iteration
  // This would call executeFixIteration() with mocked dependencies
  return {
    fixed: false,
    issuesFixed: [],
  };
}
