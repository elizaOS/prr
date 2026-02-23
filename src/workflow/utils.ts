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
import type { ResultCode, Runner } from '../runners/types.js';
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
 * 
 * Skipped inside GNU Screen or tmux — bell characters cause visual
 * artifacts or get swallowed, and the user typically can't hear them.
 */
export function ringBell(times: number = 3): void {
  // STY is set by GNU Screen, TMUX is set by tmux
  if (process.env.STY || process.env.TMUX) {
    return;
  }
  for (let i = 0; i < times; i++) {
    process.stdout.write('\x07'); // BEL character (ASCII 7)
  }
}

/**
 * Known fragments from the prompt template's NO_CHANGES instruction section.
 * If the fixer output contains these, it regurgitated the prompt instead of
 * providing a real explanation.
 *
 * WHY: When models are overwhelmed (large prompts, many issues), they sometimes
 * echo the instruction template verbatim. Treating that as a genuine "already
 * fixed" claim triggers expensive re-verification of all issues for nothing.
 */
const PROMPT_REGURGITATION_MARKERS = [
  'Issue 1 is already fixed - Line 45 has null check',
  'Valid reasons include',
  'DO NOT make zero changes without this explanation',
  'The system requires documentation of why no changes were made',
  'Cannot determine correct fix (explain what is unclear)',
  'Code already handles this correctly (cite specific implementation)',
];

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
        // Reject prompt regurgitation: if the explanation matches template text,
        // the model echoed instructions instead of providing a real explanation.
        if (PROMPT_REGURGITATION_MARKERS.some(marker => explanation.includes(marker))) {
          continue; // Skip this match, try next line
        }
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
        const inferred = sentenceMatch[0].trim();
        // Reject prompt regurgitation in inferred explanations too
        if (PROMPT_REGURGITATION_MARKERS.some(marker => inferred.includes(marker))) {
          continue;
        }
        return `(inferred) ${inferred}`;
      }
    }
  }

  return null;
}

// WHY multiple delimiters: Models may output em dash (—), double hyphen (--), or single hyphen (-).
// Accepting all three avoids parse failures when the model doesn't match the prompt exactly.
const RESULT_CODE_REGEX =
  /^RESULT:\s*(FIXED|ALREADY_FIXED|NEEDS_DISCUSSION|UNCLEAR|WRONG_LOCATION|CANNOT_FIX|ATTEMPTED)\s*(?:—|--|-)\s*(.+)$/m;

/**
 * Parse structured RESULT line from fixer output (e.g. "RESULT: ALREADY_FIXED — line 45 has null check").
 * Returns null when no RESULT line is found; callers should fall back to parseNoChangesExplanation.
 * WHY separate from NO_CHANGES: RESULT codes drive specific follow-ups (e.g. WRONG_LOCATION → lesson
 * "provide wider code context"). Legacy NO_CHANGES is still supported so existing fixer output keeps working.
 */
export function parseResultCode(output: string): {
  resultCode: ResultCode;
  resultDetail: string;
  caveat?: string;
} | null {
  if (!output || !output.trim()) return null;
  const match = output.match(RESULT_CODE_REGEX);
  if (!match || !match[1] || !match[2]) return null;
  const resultCode = match[1] as ResultCode;
  const resultDetail = match[2].trim();
  const caveatMatch = output.match(/^CAVEAT:\s*(.+)$/m);
  const caveat = caveatMatch?.[1]?.trim();
  return { resultCode, resultDetail, ...(caveat ? { caveat } : {}) };
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
export function buildSingleIssuePrompt(
  issue: UnresolvedIssue,
  lessonsContext: LessonsContext,
  prInfo?: { title: string; body: string; baseBranch: string }
): string {
  // Get file-scoped lessons (automatically includes global + this file's lessons)
  const lessons = LessonsAPI.Retrieve.getLessonsForFiles(lessonsContext, [issue.comment.path])
    .slice(-5); // Last 5 relevant lessons
  
  let prompt = `# SINGLE ISSUE FIX

Focus on fixing ONLY this one issue. Make minimal, targeted changes.
`;

  // Add PR context if available.
  // WHY title only (no body): Single-issue mode is a focused fallback when
  // batch fixes fail. Including the full PR description would dilute the
  // signal. The title gives enough context about intent without the noise.
  if (prInfo?.title) {
    prompt += `
## PR Context
**Title:** ${prInfo.title}
**Base branch:** ${prInfo.baseBranch}

`;
  }

  prompt += `## Issue
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

  if (issue.verifierContradiction) {
    prompt += `**⚠ VERIFIER DISAGREES — issue NOT fixed:** ${issue.verifierContradiction}
The verifier checked the actual code and found the issue still exists. Treat the verifier's explanation above as the source of truth for what is still missing or wrong. Your fix must directly address that feedback (e.g. add the missing code or change the cited location) so the next verification passes.
Do NOT respond with RESULT: ALREADY_FIXED for this issue — the verifier has already rejected that. You must make a code change that addresses the verifier's citation above.

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
4. If the issue is ALREADY FIXED in the current code, do NOT make cosmetic changes. Instead respond with: RESULT: ALREADY_FIXED — <cite the specific code>
5. If the instructions are UNCLEAR or contradictory, respond with: RESULT: UNCLEAR — <explain what is ambiguous>
6. If the LINE NUMBERS in the review don't match the current code, respond with: RESULT: WRONG_LOCATION — <note the discrepancy>
7. If the issue needs DISCUSSION rather than a code fix, add one short comment: // Review: <durable explanation> (no line numbers, commit hashes, or tool names — it stays in the code long-term). Then respond with: RESULT: NEEDS_DISCUSSION — <brief explanation>
8. When using search/replace, copy the search text character-for-character from the ACTUAL FILE CONTENT (not from the review comment snippet, which may be stale)
9. Keep search blocks SHORT (3-10 lines) with at least one unique identifier (function name, variable, etc.)

IMPORTANT: Actually edit the file when a fix is possible. If it is not possible or not needed, use the RESULT codes above instead of forcing a change.`;

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
