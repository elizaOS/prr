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

// More functions will be added here as we extract methods from PRResolver
