/**
 * Utility functions for PR resolution workflow
 */

import { resolve, sep, join } from 'path';
import * as fs from 'fs';
import { readFile } from 'fs/promises';
import type { Config } from '../../../shared/config.js';
import type { CLIOptions } from '../cli.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import { getConsolidateDuplicateTargetPath, getDocumentationPathFromComment, getImplPathForTestFileIssue, getMigrationJournalPath, getPathsToDeleteFromComment, getReferencedFullPathFromComment, getSiblingFilePathsFromComment, getTestPathForSourceFileIssue, issueRequiresRefactor, reviewSuggestsFixInTest, sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';
import { filterAllowedPathsForFix, isPathAllowedForFix } from '../../../shared/path-utils.js';
import type { BotResponseTiming, ReviewComment } from '../github/types.js';
import type { GitHubAPI } from '../github/api.js';
import type { LLMClient } from '../llm/client.js';
import type { StateContext } from '../state/state-context.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LockConfig } from '../state/lock-functions.js';
import type { ResultCode, Runner } from '../../../shared/runners/types.js';
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
 * Strip content inside XML blocks so we only parse the LLM's prose.
 * WHY: Output can contain <change>, <newfile>, <file> blocks with file/code content.
 * Matching inference patterns against that content produces false positives (e.g.
 * test fixtures containing "fixer made no changes" get reported as the explanation).
 */
function stripXmlBlockContentForExplanation(output: string): string {
  return output
    .replace(/<change[\s\S]*?<\/change>/gi, ' ')
    .replace(/<newfile[\s\S]*?<\/newfile>/gi, ' ')
    .replace(/<file\s+path="[^"]*"[\s\S]*?<\/file>/gi, ' ');
}

/**
 * Parse fixer tool output to extract NO_CHANGES explanation.
 * Only considers text outside <change>, <newfile>, <file> blocks to avoid
 * matching test fixtures or code content as the explanation.
 * WHY: Code/fixtures inside those blocks can contain phrases like "already fixed" or "no changes", producing false positives if we matched against raw output.
 */
export function parseNoChangesExplanation(output: string): string | null {
  if (!output) {
    return null;
  }

  const proseOnly = stripXmlBlockContentForExplanation(output);

  // Stage 1: Look for formal "NO_CHANGES:" line
  const lines = proseOnly.split('\n');
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
    const match = proseOnly.match(pattern);
    if (match) {
      const sentenceMatch = proseOnly.match(new RegExp(`[^.!?]*${pattern.source}[^.!?]*[.!?]?`, 'i'));
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

/** Match path-like tokens (e.g. "build.ts", "src/service.ts") in CANNOT_FIX/WRONG_LOCATION detail text. */
const OTHER_FILE_PATTERN = /\b([a-zA-Z0-9_][a-zA-Z0-9_.\/-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt))\b/g;

/**
 * True when the review comment suggests that `filePath` is only a REFERENCE (e.g. "duplicates … in user-service.ts",
 * "existing in X"). In that case the fix belongs in the TARGET file (remove duplicate / use shared), not in filePath.
 * WHY: When we would add filePath to wrongFileAllowedPathsByCommentId, we must not do so for reference-only paths,
 * or the fixer will keep editing user-service.ts for signup-code/db-errors issues.
 */
export function isReferencePathInComment(commentBody: string, filePath: string): boolean {
  const lower = commentBody.toLowerCase();
  const pathLower = filePath.toLowerCase();
  const base = filePath.split('/').pop() ?? filePath;
  const baseLower = base.toLowerCase();
  // Comment must mention this path (or basename)
  if (!lower.includes(baseLower) && !lower.includes(pathLower)) return false;
  // Reference-style: "in X", "duplicate(s) ... in X", "existing in X", "same as in X"
  if (/\b(?:duplicat(?:e|es|ing)|existing|same\s+as|already\s+(?:exists?|defined))\b/.test(lower) && /\bin\s+[\w./-]+/.test(lower)) return true;
  if (new RegExp(`\\bin\\s+${escapeRe(baseLower)}`, 'i').test(lower)) return true;
  if (new RegExp(`\\bin\\s+[\\w./-]*${escapeRe(baseLower)}`, 'i').test(lower)) return true;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * If CANNOT_FIX or WRONG_LOCATION explanation mentions another file path (e.g. "fix is in commit.ts"),
 * return that file's repo-relative path when it exists under workdir.
 * WHY: Fixer may correctly refuse to edit the commented file when the fix belongs elsewhere; persisting
 * the path and allowing it on retry (wrongFileAllowedPathsByCommentId) lets the next attempt succeed.
 */
export function parseOtherFileFromResultDetail(
  detail: string,
  currentPath: string,
  workdir: string
): string | null {
  const resolvedWorkdir = resolve(workdir);
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  OTHER_FILE_PATTERN.lastIndex = 0;
  while ((m = OTHER_FILE_PATTERN.exec(detail)) !== null) {
    const raw = m[1];
    const normalized = raw.replace(/^\.\//, '');
    if (normalized === currentPath || seen.has(normalized)) continue;
    seen.add(normalized);
    const abs = resolve(workdir, normalized);
    if (!abs.startsWith(resolvedWorkdir + sep) && abs !== resolvedWorkdir) continue;
    try {
      if (fs.statSync(abs).isFile()) return normalized;
    } catch {
      // not found or not a file
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

/** M3 (output.log audit): Normalize comment body for dedupe (trim + collapse whitespace). */
function normalizeCommentBodyForDedupe(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}

/**
 * M3 (output.log audit): Deduplicate new comments against current queue by file + similar comment text.
 * Returns only new comments that do not duplicate an existing issue (same path + same normalized body).
 */
export function dedupeNewCommentsByQueue<T extends { path: string; body: string }>(
  newComments: T[],
  queue: UnresolvedIssue[]
): T[] {
  const queueKeys = new Set(
    queue.map((i) => `${i.comment.path}\n${normalizeCommentBodyForDedupe(i.comment.body)}`)
  );
  return newComments.filter(
    (c) => !queueKeys.has(`${c.path}\n${normalizeCommentBodyForDedupe(c.body)}`)
  );
}

/**
 * Read full file content for single-issue fix prompts.
 *
 * WHY full file instead of snippet: Single-issue prompts previously sent only 15-30 lines
 * around the issue line. Models frequently responded INCOMPLETE_FILE or UNCLEAR because they
 * couldn't see imports, type definitions, or the broader function context. Sending the full
 * file gives enough context for correct fixes.
 *
 * WHY cap at 600 lines: Very large files (e.g. 3000+ line generated code) would blow the
 * prompt budget. 600 lines covers most source files entirely; for larger files the first
 * 600 lines typically include the issue area (issues are usually in the first half of a file).
 */
export async function getFullFileContentForSingleIssue(workdir: string, path: string, maxLines = 600): Promise<string | undefined> {
  try {
    const fullPath = join(workdir, path);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n');
  } catch {
    return undefined;
  }
}

/**
 * Build prompt for fixing a single issue
 */
export function buildSingleIssuePrompt(
  issue: UnresolvedIssue,
  lessonsContext: LessonsContext,
  prInfo?: { title: string; body: string; baseBranch: string },
  /** When set, use this instead of issue.codeSnippet (e.g. wider snippet after WRONG_LOCATION). */
  codeSnippetOverride?: string | null,
  options?: { pathExists?: (path: string) => boolean }
): string {
  const primaryPath = issue.resolvedPath ?? issue.comment.path;
  // Get lessons relevant to this issue only (file-scoped + path-relevant global; audit M2).
  const lessons = LessonsAPI.Retrieve.getLessonsForSingleIssue(lessonsContext, primaryPath)
    .slice(-5); // Last 5 relevant lessons
  
  let prompt = `# SINGLE ISSUE FIX

Focus on fixing ONLY this one issue. Make targeted changes that fully address the issue.
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

  let basePaths = issue.allowedPaths?.length ? filterAllowedPathsForFix(issue.allowedPaths) : [primaryPath];
  const journalPath = getMigrationJournalPath(issue);
  if (journalPath && isPathAllowedForFix(journalPath) && !basePaths.includes(journalPath)) basePaths = [...basePaths, journalPath];
  const consolidatePath = getConsolidateDuplicateTargetPath(issue);
  if (consolidatePath && isPathAllowedForFix(consolidatePath) && !basePaths.includes(consolidatePath)) basePaths = [...basePaths, consolidatePath];
  const referencedFull = getReferencedFullPathFromComment(issue);
  if (referencedFull && isPathAllowedForFix(referencedFull) && !basePaths.includes(referencedFull)) basePaths = [...basePaths, referencedFull];
  const docPath = getDocumentationPathFromComment(issue);
  if (docPath && isPathAllowedForFix(docPath) && !basePaths.includes(docPath)) basePaths = [...basePaths, docPath];
  for (const sibling of getSiblingFilePathsFromComment(issue)) {
    if (!basePaths.includes(sibling)) basePaths = [...basePaths, sibling];
  }
  for (const p of getPathsToDeleteFromComment(issue)) {
    if (!basePaths.includes(p)) basePaths = [...basePaths, p];
  }
  const implPath = getImplPathForTestFileIssue(issue, lessons);
  let allowedPaths = implPath && isPathAllowedForFix(implPath) && !basePaths.includes(implPath) ? [...basePaths, implPath] : basePaths;
  const testPath = getTestPathForSourceFileIssue(issue, {
    pathExists: options?.pathExists,
    forceTestPath: reviewSuggestsFixInTest(issue.comment.body ?? ''),
  });
  if (testPath && isPathAllowedForFix(testPath) && !allowedPaths.includes(testPath)) allowedPaths = [...allowedPaths, testPath];
  allowedPaths = filterAllowedPathsForFix(allowedPaths);
  prompt += `## Issue
**TARGET FILE(S) (you MAY edit only these files):** ${allowedPaths.join(', ')}${issue.comment.line ? ` (primary: ${primaryPath}:${issue.comment.line})` : ''}
Any change to a different file will be reverted and will not fix this issue.
If the review mentions another file (e.g. "duplicates … in X" or "existing in X"), that file is only a reference — fix the issue in the TARGET file(s) above (e.g. remove the duplicate here and use the shared one). Do NOT edit the referenced file unless it is listed in TARGET FILE(S).
${journalPath ? `Drizzle's migration journal is the JSON file \`db/migrations/meta/_journal.json\`; add an entry there. Do not add SQL (e.g. INSERT INTO __journal) or table-based journal logic.\n` : ''}
${allowedPaths.length > 1 ? '\n' + allowedPaths.map(p => `File: ${p}`).join('\n') + '\n' : ''}
Review Comment:
${sanitizeCommentForPrompt(issue.comment.body)}

`;

  const snippet = codeSnippetOverride !== undefined && codeSnippetOverride !== null ? codeSnippetOverride : issue.codeSnippet;
  if (snippet) {
    prompt += `Current Code:
\`\`\`
${snippet}
\`\`\`

`;
  }

  if ((issue.verifierFeedbackHistory?.length ?? 0) > 0 || issue.verifierContradiction) {
    const history = issue.verifierFeedbackHistory ?? [];
    if (history.length > 0) {
      prompt += '**Verifier feedback (previous rounds — do not repeat the same fix):**\n';
      history.forEach((msg, idx) => {
        prompt += `  • Round ${idx + 1}: ${msg}\n`;
      });
      const lastInHistory = history[history.length - 1];
      if (issue.verifierContradiction && issue.verifierContradiction !== lastInHistory) {
        prompt += `**⚠ Latest — address this:** ${issue.verifierContradiction}\n`;
      } else {
        prompt += '**⚠ Address the latest feedback above.**\n';
      }
      prompt += '\n';
    } else if (issue.verifierContradiction) {
      prompt += `**⚠ Latest — address this:** ${issue.verifierContradiction}\n`;
    }
    prompt += `The verifier checked the actual code and found the issue still exists. Treat the latest feedback above as the source of truth. Your fix must directly address it so the next verification passes.
If the current file content below already contains the fix (e.g. the code the verifier said was missing is now present), you may respond RESULT: ALREADY_FIXED and cite the exact lines that resolve the issue. Only do this if the evidence is unambiguous; otherwise make the requested change.
If the verifier suggested a more robust or structural approach (e.g. "restructure", "use X instead", "a more robust fix would be"), prefer that over a minimal workaround — the verifier will reject fragile heuristics.
Re-check the current file content at the lines the verifier cited — the snippet above may be stale or partial; the verifier saw the actual file.

`;
  }

  if (lessons.length > 0) {
    prompt += `## Previous Failed Attempts (DO NOT REPEAT)
${lessons.map(l => `- ${l}`).join('\n')}

`;
  }

  prompt += `## Instructions
1. EDIT ONLY the file(s) **${allowedPaths.join(', ')}** to fix this issue. Do not edit any other file — changes to other files are reverted and do not count.
2. Change only what's needed to fix the issue — do NOT rewrite the whole file${issueRequiresRefactor(issue) ? '\n   Exception: This issue requests removing duplication or sharing logic. You may make broader changes in this file to consolidate code.' : ''}
3. Do not modify any other files (this issue is only about ${allowedPaths.join(' and ')})
4. If the issue is ALREADY FIXED in the current code, do NOT make cosmetic changes. Instead respond with: RESULT: ALREADY_FIXED — <cite the specific code>
5. If the instructions are UNCLEAR or contradictory, respond with: RESULT: UNCLEAR — <explain what is ambiguous>
6. If the LINE NUMBERS in the review don't match the current code, respond with: RESULT: WRONG_LOCATION — <note the discrepancy>
7. If the issue needs DISCUSSION rather than a code fix, add one short comment: // Note: <durable explanation> (no line numbers, commit hashes, or tool names — it stays in the code long-term). Then respond with: RESULT: NEEDS_DISCUSSION — <brief explanation>
   NEVER add comments (// or #) to .json files — JSON has no comment syntax and it will break parsing. For JSON issues, use RESULT: NEEDS_DISCUSSION without adding an inline comment.
8. When using search/replace, copy the search text character-for-character from the ACTUAL FILE CONTENT (not from the review comment snippet, which may be stale)
9. Keep search blocks SHORT (3-10 lines) with at least one unique identifier (function name, variable, etc.)
10. Do not output <change> blocks where <search> and <replace> are identical (no-op); they are skipped and waste verification.
11. For new files use <file path="path/to/file.ts">content</file>; do not use <newfile>.

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
