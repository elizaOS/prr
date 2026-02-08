/**
 * Utility functions for PR resolution workflow
 */

import type { Config } from '../config.js';
import type { CLIOptions } from '../cli.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { BotResponseTiming, ReviewComment } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { LLMClient } from '../llm/client.js';
import type { StateContext } from '../state/state-context.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import type { Runner } from '../runners/types.js';
import * as LessonsAPI from '../state/lessons-index.js';

/**
 * Context object containing all state for PR resolution
 */
export interface ResolverContext {
  config: Config;
  options: CLIOptions;
  github: GitHubAPI;
  llm: LLMClient;
  stateContext: StateContext;
  lessonsContext: LessonsContext;
  lockConfig: LockConfig;
  runner: Runner;
  runners: Runner[];
  currentRunnerIndex: number;
  prInfo: any; // PRInfo
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
  
  // Bot timing
  botTimings: BotResponseTiming[];
  expectedBotResponseTime: Date | null;
  lastCommentFetchTime: Date | null;
  
  // Exit tracking
  exitReason: string;
  exitDetails: string;
  finalUnresolvedIssues: UnresolvedIssue[];
  finalComments: any[]; // ReviewComment[]
  
  // Rapid failure tracking
  rapidFailureCount: number;
  lastFailureTime: number;
}

/**
 * Create initial resolver context
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
export function buildSingleIssuePrompt(issue: UnresolvedIssue, lessonsContext: LessonsContext): string {
  // Get file-scoped lessons (automatically includes global + this file's lessons)
  const lessons = LessonsAPI.Retrieve.getLessonsForFiles(lessonsContext, [issue.comment.path])
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
