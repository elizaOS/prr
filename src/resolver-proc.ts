/**
 * Procedural implementation of PR resolution logic.
 * Extracted from PRResolver class to reduce file size and improve testability.
 * 
 * This file contains all the core logic, while resolver.ts is a thin wrapper class.
 */

import type { Config } from './config.js';
import type { CLIOptions } from './cli.js';
import type { ReviewComment, PRInfo, BotResponseTiming, PRStatus } from './github/types.js';
import type { UnresolvedIssue } from './analyzer/types.js';
import type { Runner } from './runners/types.js';
import type { GitHubAPI } from './github/api.js';
import type { LLMClient } from './llm/client.js';
import type { StateManager } from './state/manager.js';
import type { LessonsManager } from './state/lessons.js';
import type { LockManager } from './state/lock.js';

/**
 * Context object containing all state for PR resolution
 */
export interface ResolverContext {
  config: Config;
  options: CLIOptions;
  github: GitHubAPI;
  llm: LLMClient;
  stateManager: StateManager;
  lessonsManager: LessonsManager;
  lockManager: LockManager;
  runner: Runner;
  runners: Runner[];
  currentRunnerIndex: number;
  prInfo: PRInfo;
  workdir: string;
  isShuttingDown: boolean;
  consecutiveFailures: number;
  
  // Model rotation state
  modelIndices: Map<string, number>;
  modelFailuresInCycle: number;
  modelsTriedThisToolRound: number;
  
  // Smart model selection
  recommendedModels?: string[];
  recommendedModelIndex: number;
  modelRecommendationReasoning?: string;
  
  // Bail-out tracking
  progressThisCycle: number;
  bailedOut: boolean;
  
  // Bot timing tracking
  botTimings: BotResponseTiming[];
  expectedBotResponseTime: Date | null;
  lastCommentFetchTime: Date | null;
  
  // Exit tracking
  exitReason: string;
  exitDetails: string;
  
  // Final state
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: ReviewComment[];
  
  // Rapid failure tracking
  rapidFailureCount: number;
  lastFailureTime: number;
}

/**
 * Constants for PR resolution
 */
export const MAX_MODELS_PER_TOOL_ROUND = 2;
export const MAX_RAPID_FAILURES = 3;
export const RAPID_FAILURE_MS = 2000;
export const RAPID_FAILURE_WINDOW_MS = 10_000;

/**
 * Create a new resolver context
 */
export function createResolverContext(
  config: Config,
  options: CLIOptions,
  github: GitHubAPI,
  llm: LLMClient
): Partial<ResolverContext> {
  return {
    config,
    options,
    github,
    llm,
    currentRunnerIndex: 0,
    isShuttingDown: false,
    consecutiveFailures: 0,
    modelIndices: new Map(),
    modelFailuresInCycle: 0,
    modelsTriedThisToolRound: 0,
    recommendedModelIndex: 0,
    progressThisCycle: 0,
    bailedOut: false,
    botTimings: [],
    expectedBotResponseTime: null,
    lastCommentFetchTime: null,
    exitReason: 'unknown',
    exitDetails: '',
    finalUnresolvedIssues: [],
    finalComments: [],
    rapidFailureCount: 0,
    lastFailureTime: 0,
  };
}

/**
 * Ring terminal bell to notify user
 * WHY: Long-running processes need audio notification when complete
 */
export function ringBell(times: number = 3): void {
  for (let i = 0; i < times; i++) {
    process.stdout.write('\x07'); // BEL character (ASCII 7)
  }
}

/**
 * Parse fixer tool output to extract NO_CHANGES explanation.
 *
 * WHY: When the fixer makes zero changes, it MUST explain why.
 * This enables us to dismiss issues appropriately and document the reasoning.
 */
export function parseNoChangesExplanation(output: string): string | null {
  if (!output) {
    return null;
  }

  // Stage 1: Look for formal "NO_CHANGES:" line
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/NO_CHANGES:\s*(.+)/i);
    if (match && match[1]) {
      const explanation = match[1].trim();
      if (explanation.length >= 20) {
        return explanation;
      }
    }
  }

  // Stage 2: Infer explanation from common patterns
  const inferPatterns = [
    /(?:this|the|issue|code|fix|implementation)\s+(?:is\s+)?already\s+(?:fixed|implemented|handled|present|exists|correct)/i,
    /already\s+(?:has|have|contains?|includes?)\s+/i,
    /(?:null\s+check|validation|handling|guard)\s+(?:already\s+)?exists/i,
    /(?:the\s+)?(?:code|implementation)\s+already\s+/i,
    /no\s+(?:changes?|modifications?|updates?)\s+(?:are\s+)?(?:needed|required|necessary)/i,
    /(?:doesn't|does not|don't|do not)\s+(?:need|require)\s+(?:any\s+)?(?:changes?|fixes?)/i,
    /(?:code|implementation|current)\s+(?:is\s+)?(?:correct|fine|ok|appropriate)\s+(?:as\s+is|already)/i,
  ];

  for (const pattern of inferPatterns) {
    const match = output.match(pattern);
    if (match) {
      const sentenceMatch = output.match(new RegExp(`[^.!?]*${pattern.source}[^.!?]*[.!?]?`, 'i'));
      if (sentenceMatch && sentenceMatch[0].length >= 20) {
        return `(inferred) ${sentenceMatch[0].trim()}`;
      }
    }
  }

  return null;
}

/**
 * Sanitize tool output for debug logging.
 * WHY: Raw JSON output from tools is ugly and unhelpful in logs.
 */
export function sanitizeOutputForLog(output: string | undefined, maxLength: number = 500): string {
  if (!output) return '(no output)';
  
  if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
    try {
      const lines = output.split('\n').filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('{') && 
               !trimmed.startsWith('}') && 
               !trimmed.startsWith('[') &&
               !trimmed.startsWith(']') &&
               !trimmed.startsWith('"type"') &&
               !trimmed.startsWith('"subtype"') &&
               trimmed.length > 0;
      });
      if (lines.length > 0) {
        return lines.slice(0, 10).join('\n').substring(0, maxLength);
      }
    } catch {
      // Fall through
    }
    return '(JSON output - see verbose logs)';
  }
  
  return output.substring(0, maxLength) + (output.length > maxLength ? '...' : '');
}

/**
 * Validate that an explanation is meaningful enough to justify dismissing an issue.
 */
export function validateDismissalExplanation(
  explanation: string,
  commentPath: string,
  commentLine: number | null
): boolean {
  const MIN_EXPLANATION_LENGTH = 20;

  if (!explanation || explanation.trim().length === 0) {
    console.warn(`No explanation provided for dismissing ${commentPath}:${commentLine || '?'} - treating as unresolved`);
    return false;
  }

  if (explanation.length < MIN_EXPLANATION_LENGTH) {
    console.warn(`Explanation too short (${explanation.length} chars) for ${commentPath}:${commentLine || '?'}: "${explanation}" - treating as unresolved`);
    return false;
  }

  const vague = ['fixed', 'done', 'looks good', 'ok', 'resolved', 'already handled'];
  const lower = explanation.toLowerCase();
  if (vague.some(v => lower === v || lower === v + '.')) {
    console.warn(`Vague explanation for ${commentPath}:${commentLine || '?'}: "${explanation}" - treating as unresolved`);
    return false;
  }

  return true;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build prompt for fixing a single issue
 */
export function buildSingleIssuePrompt(issue: UnresolvedIssue, lessonsManager: LessonsManager): string {
  // Get file-scoped lessons (automatically includes global + this file's lessons)
  const lessons = lessonsManager.getLessonsForFiles([issue.comment.path])
    .slice(-5); // Last 5 relevant lessons
  
  let prompt = `# SINGLE ISSUE FIX

Focus on fixing ONLY this one issue. Make minimal, targeted changes.

## Issue
File: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}

Review Comment:
${issue.comment.body}

`;

  if (issue.codeSnippet) {
    prompt += `Current Code:
\`\`\`
${issue.codeSnippet}
\`\`\`

`;
  }

  if (lessons.length > 0) {
    prompt += `## Previous Failed Attempts (DO NOT REPEAT)
${lessons.map(l => `- ${l}`).join('\n')}

`;
  }

  prompt += `## Instructions
1. EDIT the file ${issue.comment.path} to fix this issue
2. Make the minimal change required - do NOT rewrite the whole file
3. Do not modify any other files
4. You MUST make a change - if unsure, make your best attempt

IMPORTANT: Actually edit the file. Do not just explain what to do.`;

  return prompt;
}

/**
 * Calculate expected bot response time based on historical timing data
 */
export function calculateExpectedBotResponseTime(
  botTimings: BotResponseTiming[],
  lastCommitTime: Date
): Date | null {
  if (botTimings.length === 0) {
    // No timing data - can't predict
    return null;
  }
  
  // Use average response time + 20% buffer
  const avgResponseMs = Math.round(
    botTimings.reduce((sum, t) => sum + t.avgResponseMs, 0) / botTimings.length
  );
  const bufferMs = Math.ceil(avgResponseMs * 0.2);
  const expectedMs = avgResponseMs + bufferMs;
  
  return new Date(lastCommitTime.getTime() + expectedMs);
}

/**
 * Check if it's time to re-fetch PR comments for new bot reviews.
 */
export function shouldCheckForNewComments(expectedBotResponseTime: Date | null): boolean {
  if (!expectedBotResponseTime) {
    return false;
  }
  
  const now = new Date();
  return now >= expectedBotResponseTime;
}

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
 * Get code snippet from file for context
 */
export async function getCodeSnippet(
  workdir: string,
  path: string,
  line: number | null,
  commentBody?: string
): Promise<string> {
  try {
    const { join } = await import('path');
    const { readFile } = await import('fs/promises');
    
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Try to extract line range from comment body (bugbot format)
    let startLine = line;
    let endLine = line;
    
    if (commentBody) {
      const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
      if (locationsMatch) {
        const locationLines = locationsMatch[1].trim().split('\n');
        for (const loc of locationLines) {
          const lineMatch = loc.match(/#L(\d+)(?:-L(\d+))?/);
          if (lineMatch) {
            startLine = parseInt(lineMatch[1], 10);
            endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : startLine + 20;
            break;
          }
        }
      }
    }

    if (startLine === null) {
      // Return first 50 lines if no specific line
      return lines.slice(0, 50).join('\n');
    }

    // Return code from startLine to endLine (with some context)
    const contextBefore = 5;
    const contextAfter = 10;
    const start = Math.max(0, startLine - contextBefore - 1);
    const end = Math.min(lines.length, (endLine || startLine) + contextAfter);
    
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '(file not found or unreadable)';
  }
}

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
): Promise<{ waitSeconds: number; reason: string }> {
  const defaultWait = pollInterval;
  
  // Check PR status to see what's pending
  let prStatus: PRStatus | undefined;
  try {
    prStatus = await github.getPRStatus(owner, repo, prNumber, headSha);
  } catch (err) {
    // Ignore errors fetching status
  }
  
  // If bots are actively reviewing (eyes reaction or in-progress), wait longer
  const activelyReviewing = (prStatus?.activelyReviewingBots?.length ?? 0) > 0 || 
                             (prStatus?.botsWithEyesReaction?.length ?? 0) > 0;
  
  // If checks are running, factor that in too
  const checksRunning = (prStatus?.inProgressChecks?.length ?? 0) > 0 ||
                        (prStatus?.pendingChecks?.length ?? 0) > 0;
  
  // Use bot timing data if available
  if (botTimings.length > 0) {
    const { formatDuration } = await import('./logger.js');
    
    // Use max observed + 20% buffer for safety
    const maxObserved = Math.max(...botTimings.map(t => t.maxResponseMs));
    const avgObserved = Math.round(
      botTimings.reduce((sum, t) => sum + t.avgResponseMs, 0) / botTimings.length
    );
    
    // If actively reviewing, use max + buffer
    // Otherwise use average + smaller buffer
    let waitMs: number;
    let reason: string;
    
    if (activelyReviewing) {
      waitMs = Math.ceil(maxObserved * 1.2);  // Max + 20% buffer
      reason = `bot actively reviewing (max observed: ${formatDuration(maxObserved)})`;
    } else if (checksRunning) {
      waitMs = Math.ceil((avgObserved + maxObserved) / 2);  // Midpoint of avg and max
      reason = `CI checks running (avg: ${formatDuration(avgObserved)})`;
    } else {
      waitMs = Math.ceil(avgObserved * 1.1);  // Avg + 10% buffer
      reason = `based on avg response time (${formatDuration(avgObserved)})`;
    }
    
    // Clamp to reasonable bounds (min 30s, max 5 min)
    const minWaitMs = 30 * 1000;
    const maxWaitMs = 5 * 60 * 1000;
    waitMs = Math.max(minWaitMs, Math.min(maxWaitMs, waitMs));
    
    return { waitSeconds: Math.ceil(waitMs / 1000), reason };
  }
  
  // No timing data - use status-based heuristics
  if (activelyReviewing) {
    return { waitSeconds: Math.max(defaultWait, 90), reason: 'bot actively reviewing (no timing data)' };
  }
  
  if (checksRunning) {
    return { waitSeconds: Math.max(defaultWait, 60), reason: 'CI checks running (no timing data)' };
  }
  
  // Default: use configured poll interval
  return { waitSeconds: defaultWait, reason: 'default poll interval (no timing data)' };
}

/**
 * Wait for bot reviews after push with smart timing and progress feedback
 */
export async function waitForBotReviews(
  botTimings: BotResponseTiming[],
  pollInterval: number,
  github: GitHubAPI,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<void> {
  const chalk = (await import('chalk')).default;
  
  const { waitSeconds, reason } = await calculateSmartWaitTime(
    botTimings,
    pollInterval,
    github,
    owner,
    repo,
    prNumber,
    headSha
  );
  
  console.log(chalk.gray(`\nWaiting ${waitSeconds}s for re-review (${reason})...`));
  
  // Show countdown with periodic status checks
  const checkInterval = 15;  // Check every 15 seconds
  let remaining = waitSeconds;
  
  while (remaining > 0) {
    const sleepTime = Math.min(remaining, checkInterval);
    await sleep(sleepTime * 1000);
    remaining -= sleepTime;
    
    if (remaining > 0 && remaining % 30 === 0) {
      // Every 30s, check if bot has responded early
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

// More functions will be added here as we extract methods from PRResolver
