/**
 * Issue analysis — determines which PR comments still need fixing.
 *
 * This is the "brain" of the fix loop. For each push iteration, it takes
 * the full set of review comments and produces the subset that still need
 * work (UnresolvedIssue[]).
 *
 * WHY this pipeline matters: Without careful filtering, the fixer would
 * receive 50+ comments every iteration — most already fixed or irrelevant.
 * Each unnecessary LLM analysis call costs tokens and time. The pipeline
 * filters aggressively before touching the LLM:
 *
 *   1. isVerified() gate     — skip comments already confirmed fixed
 *   2. Solvability check     — skip impossible issues (deleted files, stale refs)
 *   3. Heuristic dedup       — group obviously-duplicate comments (same file+line)
 *   4. LLM semantic dedup    — group semantically-duplicate comments (different lines, same issue)
 *   5. Comment status cache  — skip "open" comments on unmodified files
 *   6. LLM analysis          — only fresh/changed comments reach the LLM
 *
 * WHY the status cache is critical: Steps 1-4 are cheap (no LLM calls for
 * most). But step 6 sends each surviving comment to the LLM with its code
 * snippet. For 20 comments, that's 20 LLM calls (sequential) or 1 large
 * batch call. The status cache (step 5) prevents this for comments we've
 * already classified and whose target file hasn't changed.
 *
 * WHY forceReanalyze: The --reverify flag and stale verifications bypass
 * the status cache. Without this, sync hooks that flip status to "resolved"
 * would prevent re-analysis of comments that SHOULD be re-checked (stale
 * verifications exist specifically to catch regressions).
 */

import chalk from 'chalk';
import { join } from 'path';
import { readFile } from 'fs/promises';
import type { CLIOptions } from '../cli.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import { getMentionedTestFilePaths, getPathsToDeleteFromCommentBody, getRenameTargetPath, getTestPathForSourceFileIssue, isSnippetTooShort, reviewSuggestsFixInTest, sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as CommentStatusAPI from '../state/state-comment-status.js';
import * as State from '../state/state-core.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient, ModelRecommendationContext } from '../llm/client.js';
import type { Runner } from '../../../shared/runners/types.js';
import {
  CODE_SNIPPET_CONTEXT_AFTER,
  CODE_SNIPPET_CONTEXT_BEFORE,
  COULD_NOT_INJECT_DISMISS_THRESHOLD,
  getVerificationExpiryForIterationCount,
  LLM_DEDUP_MAX_CONCURRENT,
  MAX_SNIPPET_LINES,
  VERIFICATION_EXPIRY_ITERATIONS,
} from '../../../shared/constants.js';
import { filterAllowedPathsForFix } from '../../../shared/path-utils.js';
import { validateDismissalExplanation } from './utils.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, warn, formatNumber } from '../../../shared/logger.js';
import { assessSolvability, resolveTrackedPath, SNIPPET_PLACEHOLDER } from './helpers/solvability.js';
import { hashFileContent } from '../../../shared/utils/file-hash.js';
import { buildLifecycleAwareVerificationSnippet, commentNeedsLifecycleContext } from './fix-verification.js';
import { printDebugIssueTable } from './debug-issue-table.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Post-STALE symbol verification (override false STALE when symbol still in file)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Extract candidate symbols from a STALE explanation (e.g. "formatDuration no longer exists" → formatDuration). */
function extractSymbolsFromStaleExplanation(explanation: string): string[] {
  const symbols: string[] = [];
  // "X no longer exists" / "X does not exist" / "X do not exist"
  const noLonger = explanation.matchAll(/(\w+)\s+(?:no longer exists|does not exist|do not exist|does not appear)/gi);
  for (const m of noLonger) symbols.push(m[1]);
  // "The X function ... no longer exists" / "The X function ... does not exist"
  const theFunc = explanation.matchAll(/The\s+(\w+)\s+(?:function|method)\s+[^.]*(?:no longer exists|does not exist)/gi);
  for (const m of theFunc) symbols.push(m[1]);
  // "constants X, Y, Z are not visible" — split on comma, trim
  const constants = explanation.match(/(?:constants?\s+)([A-Z][A-Z0-9_,\s]+?)(?:\s+are not visible|\s+do not appear|\.)/i);
  if (constants) {
    for (const part of constants[1].split(/[\s,]+/)) {
      const s = part.trim();
      if (s.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) symbols.push(s);
    }
  }
  return [...new Set(symbols)];
}

/** Return true if file content contains the symbol as a word (identifier). */
async function fileContainsSymbol(workdir: string, filePath: string, symbol: string): Promise<boolean> {
  try {
    const content = await readFile(join(workdir, filePath), 'utf-8');
    const wordBoundary = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return wordBoundary.test(content);
  } catch {
    return false;
  }
}

/**
 * True when the comment is about ordering/retention semantics that often span
 * more than the anchored line (e.g. newest-first vs oldest-first trimming).
 */
export function commentNeedsOrderingContext(commentBody: string): boolean {
  const c = commentBody.toLowerCase();
  return (
    /\bfromend\b/.test(c) ||
    /\b(?:newest|oldest)-first\b/.test(c) ||
    /\bkeep(?:s|ing)?\s+(?:the\s+)?(?:newest|oldest)\b/.test(c) ||
    /\btrim(?:s|ming)?\s+the\s+wrong\s+side\b/.test(c) ||
    /\bdrops?\s+the\s+(?:newest|oldest)\b/.test(c) ||
    /\bpreserv(?:e|es|ing)\s+the\s+(?:newest|oldest)\b/.test(c) ||
    /\bslicetofitbudget\b/.test(c)
  );
}

export function commentNeedsConservativeAnalysisContext(commentBody: string): boolean {
  return (
    commentNeedsLifecycleContext({ comment: commentBody }) ||
    commentNeedsOrderingContext(commentBody)
  );
}

function buildNumberedFullFileSnippet(content: string, note?: string): string {
  const lines = content.split('\n');
  const body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return body + `\n(${note ?? `end of file — ${lines.length} lines total`})`;
}

function mergeAnalysisRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

/**
 * Pull likely ordering-related symbols out of the comment so we can stitch
 * together multiple relevant regions from a large file.
 *
 * WHY: "fromEnd keeps oldest runs" bugs are rarely local to the anchor line.
 * We usually need both the ordering source (`groupedByRun`, `getMemories`) and
 * the later trimming call (`sliceToFitBudget`, `reverse`) in one prompt.
 */
function extractOrderingCandidateSymbols(commentBody: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    if (!/^[A-Za-z_$][\w$]{2,}$/.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    symbols.push(value);
  };

  const backtick = /`([A-Za-z_$][\w$]{2,})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtick.exec(commentBody)) !== null) add(match[1]);

  const camelOrSnake = /\b([a-z]+_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
  while ((match = camelOrSnake.exec(commentBody)) !== null) add(match[1]);

  if (/\bfromend\b/i.test(commentBody)) add('fromEnd');
  if (/\bslicetofitbudget\b/i.test(commentBody)) add('sliceToFitBudget');
  if (/\bgroupedbyrun\b/i.test(commentBody)) add('groupedByRun');
  if (/\bgetmemories\b/i.test(commentBody)) add('getMemories');
  if (/\breverse\b/i.test(commentBody)) add('reverse');

  return symbols;
}

/**
 * Build a multi-range analysis snippet for ordering/history issues.
 *
 * WHY: For large files, sending one centered 80-line window reintroduced the
 * same blind spot this change set was meant to fix. Multi-range excerpts let
 * the model see both the "data order comes from here" site and the later
 * "selection/trimming happens here" site without needing the entire file.
 */
function buildOrderingAwareAnalysisSnippet(
  content: string,
  filePath: string,
  line: number | null,
  commentBody: string
): string | null {
  const lines = content.split('\n');
  const candidates = extractOrderingCandidateSymbols(commentBody);
  if (candidates.length === 0) return null;

  const ranges: Array<{ start: number; end: number }> = [];
  if (line != null) {
    ranges.push({
      start: Math.max(1, line - 10),
      end: Math.min(lines.length, line + 16),
    });
  }

  for (const symbol of candidates) {
    const rx = new RegExp(`\\b${escapeRegExpForSnippet(symbol)}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (!rx.test(lines[i]!)) continue;
      ranges.push({
        start: Math.max(1, i + 1 - 5),
        end: Math.min(lines.length, i + 1 + 8),
      });
    }
  }

  const merged = mergeAnalysisRanges(ranges);
  if (merged.length === 0) return null;

  const parts = [
    `Ordering excerpts for ${filePath} (relevant ordering/selection sites):`,
    '',
  ];
  const maxChars = 20_000;
  let usedChars = parts.join('\n').length;
  let included = 0;

  for (const range of merged) {
    const body = lines
      .slice(range.start - 1, range.end)
      .map((l, i) => `${range.start + i}: ${l}`)
      .join('\n');
    const block = `--- lines ${range.start}-${range.end} ---\n${body}\n`;
    if (usedChars + block.length > maxChars) break;
    parts.push(block);
    usedChars += block.length;
    included++;
  }

  if (included === 0) return null;
  if (included < merged.length) {
    parts.push(`... (${merged.length - included} additional ordering section(s) omitted; file has ${lines.length} lines total)`);
  } else {
    parts.push(`(full ordering excerpt set shown; file has ${lines.length} lines total)`);
  }
  return parts.join('\n');
}

function buildConservativeAnalysisSnippet(
  content: string,
  filePath: string,
  line: number | null,
  commentBody: string
): string | null {
  if (commentNeedsLifecycleContext({ comment: commentBody })) {
    const lifecycleSnippet = buildLifecycleAwareVerificationSnippet(content, filePath, line, commentBody);
    if (lifecycleSnippet) return lifecycleSnippet;
  }

  if (commentNeedsOrderingContext(commentBody)) {
    // WHY prefer targeted multi-range excerpts before full-file fallback: large
    // ordering bugs often need distant sites, but whole-file embedding would
    // waste prompt budget and still fail on very large files.
    const orderingSnippet = buildOrderingAwareAnalysisSnippet(content, filePath, line, commentBody);
    if (orderingSnippet) return orderingSnippet;
  }

  // Prefer the full numbered file for order/history issues when it fits.
  // WHY: The bug is often in collection ordering plus the later selection call.
  const fullFileSnippet = buildNumberedFullFileSnippet(content);
  const MAX_CONSERVATIVE_ANALYSIS_CHARS = 20_000;
  if (fullFileSnippet.length <= MAX_CONSERVATIVE_ANALYSIS_CHARS) {
    return fullFileSnippet;
  }

  const widened = buildWindowedSnippet(content, line, commentBody);
  return widened.length <= MAX_CONSERVATIVE_ANALYSIS_CHARS
    ? widened
    : widened.slice(0, MAX_CONSERVATIVE_ANALYSIS_CHARS) + '\n... (truncated)';
}

/**
 * Dedup cache is persisted in state (stateContext.state.dedupCache).
 * WHY: In-memory cache reset each run; audit showed all dedup LLM calls returning NONE on repeat runs.
 * Persisting keyed by sorted comment IDs makes the outcome deterministic for the same set, so we skip
 * the dedup LLM and save tokens/latency when the comment set is unchanged (e.g. re-run or next push iteration).
 */

/**
 * Result of the deduplication process
 */
interface DedupResult {
  /** Items to proceed with (canonicals + non-duplicates) */
  dedupedToCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
    resolvedPath?: string;
  }>;
  /** Maps canonical commentId -> duplicate commentIds */
  duplicateMap: Map<string, string[]>;
  /** Duplicate items keyed by commentId (for context merging) */
  duplicateItems: Map<string, {
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
  }>;
}

/**
 * Log duplicate candidate groups for analysis.
 * Phase 0: Observation only - no filtering or behavior change.
 * 
 * Groups issues by file path and line proximity to identify potential duplicates.
 * 
 * @param toCheck Array of issues with snippets to analyze
 */
function logDuplicateCandidates(
  toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
  }>,
  /** Stable commentId → display number mapping, built from toCheck order.
   *  HISTORY: Originally this function built its own `globalIdx` counter
   *  sequentially across groups. But heuristicDedup used `toCheck` array
   *  position for its verdict display — different ordering, different numbers.
   *  Now both functions share this single map so #7 means the same comment
   *  everywhere in the output. */
  idToDisplayNum: Map<string, number>,
): void {
  // Skip if too few issues to have meaningful duplicates
  if (toCheck.length <= 3) {
    return;
  }

  // Group by file path
  const byFile = new Map<string, typeof toCheck>();
  for (const item of toCheck) {
    const path = item.comment.path;
    if (!byFile.has(path)) {
      byFile.set(path, []);
    }
    byFile.get(path)!.push(item);
  }

  // Find candidate duplicate groups within each file
  const candidateGroups: Array<{
    file: string;
    lineRange: string;
    items: typeof toCheck;
    sameAuthor: boolean;
    authors: Set<string>;
  }> = [];

  for (const [file, items] of byFile.entries()) {
    if (items.length < 2) continue;

    // Cluster by line proximity (within 10 lines or both null)
    const clusters: typeof toCheck[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (processed.has(i)) continue;

      const cluster = [items[i]];
      processed.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(j)) continue;

        const line1 = items[i].comment.line;
        const line2 = items[j].comment.line;

        // Check if lines are close or both null
        const areClose = 
          (line1 !== null && line2 !== null && Math.abs(line1 - line2) <= 10) ||
          (line1 === null && line2 === null);

        if (areClose) {
          cluster.push(items[j]);
          processed.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      }
    }

    // Record clusters as candidate groups
    for (const cluster of clusters) {
      const authors = new Set(cluster.map(item => item.comment.author));
      const lines = cluster.map(item => item.comment.line).filter(l => l !== null) as number[];
      const hasNullLine = cluster.some(item => item.comment.line === null);
      
      let lineRange: string;
      if (lines.length === 0) {
        lineRange = '(both line:null -- may be unrelated)';
      } else if (lines.length === 1) {
        lineRange = hasNullLine ? `${lines[0]} + null` : `${lines[0]}`;
      } else {
        const min = Math.min(...lines);
        const max = Math.max(...lines);
        lineRange = hasNullLine ? `${min}-${max} + null` : `${min}-${max}`;
      }

      candidateGroups.push({
        file,
        lineRange,
        items: cluster,
        sameAuthor: authors.size === 1,
        authors,
      });
    }
  }

  // Log results
  if (candidateGroups.length === 0) {
    return; // No logging if no candidates found
  }

  const totalComments = candidateGroups.reduce((sum, g) => sum + g.items.length, 0);
  console.log(chalk.gray(`\nDuplicate candidates: ${formatNumber(candidateGroups.length)} group(s), ${formatNumber(totalComments)} comments total`));
  
  // Use the shared idToDisplayNum map so "#7" means the same comment here
  // and in the dedup verdict log. Numbers come from toCheck array position
  // (1-indexed), so they're stable regardless of how groups are ordered.
  for (const group of candidateGroups) {
    const authorInfo = group.sameAuthor 
      ? `same author: ${[...group.authors][0]}`
      : 'different authors';
    
    console.log(chalk.gray(`  ${group.file}:${group.lineRange} (${formatNumber(group.items.length)} comments, ${authorInfo})`));
    
    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const num = idToDisplayNum.get(item.comment.id) ?? '?';
      const author = item.comment.author || 'unknown';
      const preview = item.comment.body.substring(0, 80).replace(/\n/g, ' ');
      const suffix = item.comment.body.length > 80 ? '...' : '';
      console.log(chalk.gray(`    #${num} (${author}): "${preview}${suffix}"`));
    }
  }
  console.log(''); // Blank line after the report
}

/** Extract a primary symbol from comment body (method/function/test target) for same-requirement dedup. */
function primarySymbolFromBody(body: string): string | null {
  const backtick = body.match(/`([a-zA-Z_][a-zA-Z0-9_]*)`/);
  if (backtick) return backtick[1];
  const method = body.match(/(?:method|function|tests? for)\s+[`']?([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (method) return method[1];
  const has = body.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s+has\s+(?:zero|no)\s+/i);
  if (has) return has[1];
  return null;
}

/** True if both bodies share a same-requirement keyword (avoids merging e.g. "add tests" with "security bug" on same symbol). */
function bodySimilarityForDedup(body1: string, body2: string, symbol: string | null): boolean {
  const b1 = body1.toLowerCase();
  const b2 = body2.toLowerCase();
  const keywords = ['test', 'tests', 'coverage', 'missing test', 'add test', 'zero test', 'no test', 'patch', 'fix', 'implement'];
  for (const kw of keywords) {
    if (b1.includes(kw) && b2.includes(kw)) return true;
  }
  if (symbol && b1.includes(symbol.toLowerCase()) && b2.includes(symbol.toLowerCase())) return true;
  return false;
}

/** Extract caller/referenced file from comment body (e.g. "runner.py:146", "in runner.py", "callers in X"). Prompts.log audit: same method + same caller = same issue across authors. */
function callerFileFromBody(body: string): string | null {
  const m = body.match(/(?:calls?|caller|in|from)\s+[`']?([a-zA-Z0-9_/.()-]+\.(?:py|ts|tsx|js|jsx))[`']?(?::\d+)?/i)
    ?? body.match(/([a-zA-Z0-9_/.()-]+\.(?:py|ts|tsx|js|jsx))(?::\d+)/);
  return m ? m[1].trim() : null;
}

/**
 * Heuristic deduplication: filter obvious duplicates before batch analysis.
 * Phase 1: Zero LLM cost, uses deterministic logic.
 *
 * Criteria for duplicates (stricter than Phase 0 candidates):
 * - Same file (exact path match)
 * - Lines within 10 of each other (both non-null), OR both null
 * - Same author OR (same primary symbol + body similarity) OR (same symbol + same caller file)
 *
 * WHY same-caller: Prompts.log audit showed dedup returning NONE for four comments on the same file; cursor and claude both described the same async/caller mismatch (generate_report + runner.py) but different authors prevented merge. Same symbol + same caller file is a strong signal for "same issue" across bots.
 *
 * @param toCheck Array of issues with snippets
 * @returns DedupResult with filtered list, duplicate map, and duplicate items
 */
function heuristicDedup(
  toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
    resolvedPath?: string;
  }>,
  /** Shared commentId → display number mapping (same one used in candidate log). */
  idToDisplayNum: Map<string, number>,
): DedupResult {
  const duplicateMap = new Map<string, string[]>();
  const duplicateItems = new Map<string, typeof toCheck[0]>();
  const canonicalIds = new Set<string>();
  const duplicateIds = new Set<string>();

  // Group by file path
  const byFile = new Map<string, typeof toCheck>();
  for (const item of toCheck) {
    const path = item.comment.path;
    if (!byFile.has(path)) {
      byFile.set(path, []);
    }
    byFile.get(path)!.push(item);
  }

  // Find duplicate groups within each file
  for (const [, items] of byFile.entries()) {
    if (items.length < 2) continue;

    // Cluster by line proximity AND same author (stricter than Phase 0)
    const clusters: typeof toCheck[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (processed.has(i)) continue;

      const cluster = [items[i]];
      processed.add(i);

      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(j)) continue;

        const line1 = items[i].comment.line;
        const line2 = items[j].comment.line;
        const author1 = items[i].comment.author;
        const author2 = items[j].comment.author;
        const symbol1 = primarySymbolFromBody(items[i].comment.body);
        const symbol2 = primarySymbolFromBody(items[j].comment.body);
        const sameSymbol = symbol1 && symbol2 && symbol1 === symbol2;
        const bodySimilar = sameSymbol && bodySimilarityForDedup(items[i].comment.body, items[j].comment.body, symbol1);
        const caller1 = callerFileFromBody(items[i].comment.body);
        const caller2 = callerFileFromBody(items[j].comment.body);
        const sameCaller = caller1 && caller2 && caller1 === caller2;

        // Same author, or (same primary symbol + body similarity), or (same symbol + same caller file — prompts.log audit: async/caller mismatch from different authors)
        if (author1 !== author2 && !(sameSymbol && (bodySimilar || sameCaller))) continue;

        // Check if lines are close or both null
        const areClose =
          (line1 !== null && line2 !== null && Math.abs(line1 - line2) <= 10) ||
          (line1 === null && line2 === null);

        if (areClose) {
          cluster.push(items[j]);
          processed.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      }
    }

    // For each cluster, pick canonical and record duplicates
    for (const cluster of clusters) {
      // Pick canonical: longest body, most precise line, earliest createdAt
      const canonical = cluster.reduce((best, current) => {
        // 1. Longest comment body wins
        if (current.comment.body.length > best.comment.body.length) {
          return current;
        }
        if (current.comment.body.length < best.comment.body.length) {
          return best;
        }

        // 2. Most precise line reference wins (non-null beats null)
        if (current.comment.line !== null && best.comment.line === null) {
          return current;
        }
        if (current.comment.line === null && best.comment.line !== null) {
          return best;
        }

        // 3. Earliest createdAt wins (tiebreaker)
        if (current.comment.createdAt < best.comment.createdAt) {
          return current;
        }

        return best;
      });

      // Record canonical and duplicates
      canonicalIds.add(canonical.comment.id);
      const dupes = cluster
        .filter(item => item.comment.id !== canonical.comment.id)
        .map(item => item.comment.id);
      
      duplicateMap.set(canonical.comment.id, dupes);
      
      // Store duplicate items for context merging
      for (const item of cluster) {
        if (item.comment.id !== canonical.comment.id) {
          duplicateIds.add(item.comment.id);
          duplicateItems.set(item.comment.id, item);
        }
      }
    }
  }

  // Build dedupedToCheck: keep canonicals and non-duplicates
  const dedupedToCheck = toCheck.filter(item => !duplicateIds.has(item.comment.id));

  // Log results if any deduplication happened
  if (duplicateMap.size > 0) {
    const totalDupes = [...duplicateMap.values()].reduce((sum, dupes) => sum + dupes.length, 0);
    console.log(chalk.gray(
      `  Dedup: ${formatNumber(duplicateMap.size)} group(s) merged ` +
      `(${formatNumber(totalDupes + duplicateMap.size)} comments -> ${formatNumber(duplicateMap.size)} canonical)`
    ));
    
    // HISTORY: Previously built a local idToIndex from toCheck array order, but
    // logDuplicateCandidates used a different globalIdx. Numbers didn't match,
    // making cross-references impossible (e.g. verdict showed #47 but candidate
    // log only went to #43). Now both use the shared idToDisplayNum map.
    for (const [canonicalId, dupes] of duplicateMap.entries()) {
      const canonical = toCheck.find(item => item.comment.id === canonicalId);
      if (canonical) {
        const canonIdx = idToDisplayNum.get(canonicalId) ?? '?';
        const dupeIdxs = dupes.map(d => `#${idToDisplayNum.get(d) ?? '?'}`).join(', ');
        const lineInfo = canonical.comment.line !== null ? `:${canonical.comment.line}` : '';
        console.log(chalk.gray(
          `    #${canonIdx} [canonical] ${canonical.comment.path}${lineInfo} ← dupes: ${dupeIdxs}`
        ));
      }
    }
  }

  return {
    dedupedToCheck,
    duplicateMap,
    duplicateItems,
  };
}

/**
 * Phase 2: LLM-based semantic deduplication.
 *
 * Takes candidate groups from Phase 0 that heuristic dedup (Phase 1) didn't merge
 * — typically because authors differ or lines are too far apart — and asks the LLM
 * whether they describe the same underlying issue.
 *
 * This catches the pattern where 4 reviewers flag the same corrupted file from
 * different angles (line 50, 62, 440, null) — the heuristic can't see they're all
 * "one file is structurally broken."
 *
 * Cost: One lightweight LLM call with short summaries. Typically <2k tokens.
 */
async function llmDedup(
  dedupResult: DedupResult,
  toCheck: Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[]; resolvedPath?: string }>,
  llm: LLMClient
): Promise<DedupResult> {
  // Find items that survived heuristic dedup — only compare within same file
  const byFile = new Map<string, Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[]; resolvedPath?: string }>>();
  for (const item of dedupResult.dedupedToCheck) {
    const existing = byFile.get(item.comment.path) || [];
    existing.push(item);
    byFile.set(item.comment.path, existing);
  }

  // Process files with 3+ remaining issues. WHY skip LLM for 2: For exactly two comments on a file,
  // heuristic grouping (same file, line proximity, author) is usually sufficient; the LLM call adds cost with little gain.
  const filesToCheck = [...byFile.entries()].filter(([, items]) => items.length >= 3);
  if (filesToCheck.length === 0) return dedupResult;

  debug(`LLM dedup: checking ${filesToCheck.length} file(s) with 3+ issues`);

  const newDuplicateMap = new Map(dedupResult.duplicateMap);
  const newDuplicateItems = new Map(dedupResult.duplicateItems);
  const newDuplicateIds = new Set<string>();

  // Run dedup LLM calls in parallel (up to LLM_DEDUP_MAX_CONCURRENT) for speed.
  // WHY: One call per file; parallelizing cuts total time. ElizaCloud client still
  // serializes in-flight requests; direct providers get real parallelism.
  type DedupEntry = [string, Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[] }>];
  type DedupTaskResult = { filePath: string; groups: Array<{ canonical: DedupEntry[1][0]; dupes: DedupEntry[1] }>; error?: string };

  async function runOneDedupFile(entry: DedupEntry): Promise<DedupTaskResult> {
    const [filePath, items] = entry;
    const summaries = items.map((item, idx) => {
      const line = item.comment.line !== null ? ` (line ${item.comment.line})` : '';
      const preview = sanitizeCommentForPrompt(item.comment.body).substring(0, 400).replace(/\n/g, ' ');
      // Include a short code snippet so the model can see whether comments reference the same code.
      const hasSnippet = item.codeSnippet
        && item.codeSnippet.length > 0
        && !item.codeSnippet.startsWith('(file not found')
        && !item.codeSnippet.startsWith('(unreadable');
      const snippet = hasSnippet
        ? `\n   Code: ${item.codeSnippet.split('\n').slice(0, 4).join(' | ').substring(0, 200)}`
        : '';
      return `[${idx + 1}] ${item.comment.author}${line}: ${preview}${snippet}`;
    }).join('\n\n');
    // WHY "same method, different fix" rule: Audit found a bad merge — two comments about the same method required
    // different fixes (add method vs change call site). Grouping them lost nuance; the rule reduces false groupings.
    // WHY index-range rule: Cycle 16 returned GROUP lines like "2,5,7" for a 3-comment file; telling the model that
    // only 1..N are valid indices reduces malformed groups before they reach the parser.
    const prompt = `Below are ${items.length} review comments on the same file (${filePath}).
You must decide which comments describe the EXACT SAME underlying problem.

${summaries}

GROUPING RULES (be conservative — wrong merges cause missed fixes):
- CRITICAL: Only group comments that have the SAME line number. Each comment shows "(line N)" — every comment in a GROUP must share the same N. Comments on different lines must NOT be in the same GROUP. Before replying, verify: every index you put in one GROUP has the same (line N); if any two have different line numbers, do NOT put them in the same GROUP.
- Only group comments if they point to the SAME code location AND fix the SAME specific problem.
- Comments on DIFFERENT lines, DIFFERENT functions, or that require DIFFERENT fixes must NOT be grouped.
- "Related" or "thematically similar" is NOT enough — they must be describing the same bug/issue.
- Same method/symbol but DIFFERENT fix = do NOT group. Example: "Method X doesn't exist" (fix: add the method) and "Method X called with wrong cast" (fix: change the call site) are two different fixes — do not group.
- When in doubt, do NOT group.

For each group of true duplicates, pick the most detailed comment as canonical.

Valid comment indices in this prompt are 1 through ${items.length} only. Never reference an index outside that range.
The canonical index MUST be one of the indices listed in its GROUP line.

Before replying: For each GROUP line you write, verify that every index in that GROUP has the same (line N) in the comment text above. If any two indices have different line numbers, do NOT put them in the same GROUP.

Reply ONLY with lines like (one per group, no other text):
GROUP: 1,2 → canonical 2
GROUP: 1,3 → canonical 3

If no comments are duplicates, reply: NONE`;
    try {
      // Always use cheap model for dedup — fast and sufficient; avoids slow default (e.g. qwen-3-14b on ElizaCloud).
      const response = await llm.completeWithCheapModel(prompt);
      const content = response.content.trim();
      const groups: DedupTaskResult['groups'] = [];
      const groupPattern = /GROUP:\s*([\d,\s]+)\s*→\s*canonical\s*(\d+)/gi;
      let match;
      // WHY (Cycle 16): LLM sometimes returns GROUP lines with out-of-range indices (e.g. GROUP: 2,5,7 when only 3 comments).
      // Applying a filtered subset merges the wrong comments. Reject the entire line when any index is outside [1, N] or canonical not in group.
      const n = items.length;
      while ((match = groupPattern.exec(content)) !== null) {
        const rawIndices = match[1].split(',').map(s => parseInt(s.trim(), 10));
        const canonicalOneBased = parseInt(match[2], 10);
        if (canonicalOneBased < 1 || canonicalOneBased > n) continue;
        const allInRange = rawIndices.every((i) => i >= 1 && i <= n);
        if (!allInRange || rawIndices.length < 2) continue;
        if (!rawIndices.includes(canonicalOneBased)) continue;
        // Audit (prompts.log): model returned "GROUP: 1,2,5 → canonical 2" but [1],[5] were line 2531 and [2] was line 2493 — different lines must not be merged.
        const indices = rawIndices.map((i) => i - 1);
        const groupLines = indices.map((i) => items[i].comment.line);
        const sameLine = groupLines.every((l) => l === groupLines[0]);
        if (!sameLine) {
          // Re-split by line so we don't lose valid same-line merges (e.g. 1,5 same line; 2 different → keep group 1,5).
          const byLine = new Map<number | null, number[]>();
          for (let i = 0; i < indices.length; i++) {
            const line = items[indices[i]].comment.line;
            if (!byLine.has(line)) byLine.set(line, []);
            byLine.get(line)!.push(indices[i]);
          }
          let reSplitCount = 0;
          for (const [, lineIndices] of byLine) {
            if (lineIndices.length < 2) continue;
            reSplitCount++;
            // Pick canonical: longest comment body (same tiebreak as heuristic dedup).
            const canonicalIdx = lineIndices.reduce((best, i) =>
              (items[i].comment.body.length > items[best].comment.body.length ? i : best));
            const dupes = lineIndices.filter((i) => i !== canonicalIdx).map((i) => items[i]);
            groups.push({ canonical: items[canonicalIdx], dupes });
          }
          debug(`Dedup: GROUP ${rawIndices.join(',')} had mixed line numbers (${groupLines.map((l) => l ?? 'file').join(', ')}); re-split → ${reSplitCount} same-line group(s)`);
          continue;
        }
        const canonicalIdx = canonicalOneBased - 1;
        const canonical = items[canonicalIdx];
        const dupes = indices.filter((i) => i !== canonicalIdx).map((i) => items[i]);
        groups.push({ canonical, dupes });
      }
      // Only treat as NONE when no GROUP lines were parsed. Audit: response contained
      // both "GROUP: 1,2,3 → canonical 3" and "NONE" — the old check discarded valid groups.
      if (groups.length === 0 && content.toUpperCase().includes('NONE')) {
        return { filePath, groups: [], error: undefined };
      }
      return { filePath, groups };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`LLM dedup failed for ${filePath}: ${msg}`);
      return { filePath, groups: [], error: msg };
    }
  }

  async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let index = 0;
    async function worker(): Promise<void> {
      while (index < tasks.length) {
        const i = index++;
        results[i] = await tasks[i]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
  }

  const dedupTasks = filesToCheck.map(entry => () => runOneDedupFile(entry));
  const dedupResults = await runWithConcurrency(dedupTasks, LLM_DEDUP_MAX_CONCURRENT);

  const dedupFailures = dedupResults.filter((r): r is DedupTaskResult & { error: string } => !!r.error);
  if (dedupFailures.length > 0) {
    warn(`LLM dedup failed for ${dedupFailures.length}/${filesToCheck.length} file(s) — proceeding with heuristic-only dedup`);
    for (const { filePath, error } of dedupFailures) {
      warn(`  ${filePath}: ${error}`);
    }
  }

  // Merge all results into the dedup map
  for (const { filePath, groups } of dedupResults) {
    for (const { canonical, dupes } of groups) {
      const existingDupes = newDuplicateMap.get(canonical.comment.id) || [];
      for (const dupe of dupes) {
        if (!existingDupes.includes(dupe.comment.id) && !newDuplicateIds.has(dupe.comment.id)) {
          existingDupes.push(dupe.comment.id);
          newDuplicateIds.add(dupe.comment.id);
          newDuplicateItems.set(dupe.comment.id, dupe);
        }
      }
      newDuplicateMap.set(canonical.comment.id, existingDupes);

      debug(`LLM dedup: merged ${dupes.length} duplicate(s) for ${filePath}:${canonical.comment.line ?? '?'}`);
    }
  }

  if (newDuplicateIds.size === 0) return dedupResult;

  // Rebuild dedupedToCheck excluding newly identified duplicates
  const updatedDeduped = dedupResult.dedupedToCheck.filter(
    item => !newDuplicateIds.has(item.comment.id)
  );

  const totalNewDupes = newDuplicateIds.size;
  console.log(chalk.gray(
    `  LLM dedup: merged ${totalNewDupes} additional duplicate(s) across ${filesToCheck.length} file(s)`
  ));

  return {
    dedupedToCheck: updatedDeduped,
    duplicateMap: newDuplicateMap,
    duplicateItems: newDuplicateItems,
  };
}

/**
 * Parse line references from a review comment body.
 * Used to expand the code snippet range so the fixer sees all referenced lines.
 *
 * WHY: Review bots (e.g. CodeRabbit) often anchor the comment at line 1 but say "around lines 52 - 93"
 * in the body. getCodeSnippet previously used only comment.line, so the fixer received 15 lines
 * around line 1 and never saw the actual code in question. Parsing refs and merging with the
 * anchor yields a snippet that includes every referenced range.
 *
 * Only matches high-confidence patterns (e.g. "around lines 52 - 93", "at line 128") to avoid
 * false positives like "HTTP 404" or "port 8080". Skips lines that look like shell commands
 * (sed -n, cat -n) from CodeRabbit analysis chains — those contain line numbers from the bot's
 * investigation, not the issue location.
 */
export function parseLineReferencesFromBody(commentBody: string): number[] {
  if (!commentBody || !commentBody.trim()) return [];

  const lines = commentBody.split('\n');
  const collected: number[] = [];

  for (const raw of lines) {
    // WHY skip: CodeRabbit embeds "Script executed: sed -n '225,245p'" in the comment. Matching
    // those numbers would add 225–245 to the snippet range even though they refer to the bot's
    // script output, not the file lines the reviewer is talking about.
    if (/sed\s+-n|cat\s+-n|head\s+-n|grep\s+-n/.test(raw)) continue;

    // Around lines N - M (CodeRabbit "Prompt for AI Agents" format)
    const aroundMatch = raw.match(/around\s+lines\s+(\d+)\s*-\s*(\d+)/gi);
    if (aroundMatch) {
      for (const m of aroundMatch) {
        const parts = m.match(/(\d+)\s*-\s*(\d+)/);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }

    // lines N-M or lines N - M
    const linesDashMatch = raw.match(/\blines\s+(\d+)\s*[-–]\s*(\d+)/gi);
    if (linesDashMatch) {
      for (const m of linesDashMatch) {
        const parts = m.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }

    // lines N to M / lines N through M
    const linesToMatch = raw.match(/\blines\s+(\d+)\s+to\s+(\d+)/gi);
    if (linesToMatch) {
      for (const m of linesToMatch) {
        const parts = m.match(/(\d+)\s+to\s+(\d+)/i);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }
    const linesThroughMatch = raw.match(/\blines\s+(\d+)\s+through\s+(\d+)/gi);
    if (linesThroughMatch) {
      for (const m of linesThroughMatch) {
        const parts = m.match(/(\d+)\s+through\s+(\d+)/i);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }

    // at line N / on line N
    const atOnMatch = raw.match(/(?:at|on)\s+line\s+(\d+)/gi);
    if (atOnMatch) {
      for (const m of atOnMatch) {
        const n = m.match(/(\d+)/);
        if (n) collected.push(parseInt(n[1], 10));
      }
    }

    // Line N (capital L, e.g. "Line 128 calls")
    const lineCapMatch = raw.match(/\bLine\s+(\d+)/g);
    if (lineCapMatch) {
      for (const m of lineCapMatch) {
        const n = m.match(/(\d+)/);
        if (n) collected.push(parseInt(n[1], 10));
      }
    }

    // line N (word boundary avoids "pipeline", "deadline")
    const lineMatch = raw.match(/\bline\s+(\d+)/gi);
    if (lineMatch) {
      for (const m of lineMatch) {
        const n = m.match(/(\d+)/);
        if (n) collected.push(parseInt(n[1], 10));
      }
    }

    // #LN or #LN-LM (LOCATIONS-style)
    const hashMatch = raw.match(/#L(\d+)(?:-L(\d+))?/g);
    if (hashMatch) {
      for (const m of hashMatch) {
        const parts = m.match(/#L(\d+)(?:-L(\d+))?/);
        if (parts) {
          collected.push(parseInt(parts[1], 10));
          if (parts[2]) collected.push(parseInt(parts[2], 10));
        }
      }
    }
  }

  const unique = [...new Set(collected)].filter((n) => n > 0);
  unique.sort((a, b) => a - b);
  return unique;
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
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // WHY unified anchors: A comment may have comment.line=11 (GitHub API) and body text
    // "around lines 52 - 93". Using only one or the other would show the wrong code. Merging
    // all sources and taking min/max yields one contiguous range that includes every referenced line.
    const anchors = new Set<number>();
    if (line !== null) anchors.add(line);

    let startLine: number | null = line;
    let endLine: number | null = line;

    if (startLine === null && commentBody) {
      const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
      if (locationsMatch) {
        const locationLines = locationsMatch[1].trim().split('\n');
        for (const loc of locationLines) {
          const lineMatch = loc.match(/#L(\d+)(?:-L(\d+))?/);
          if (lineMatch) {
            startLine = parseInt(lineMatch[1], 10);
            endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : startLine + 20;
            anchors.add(startLine);
            if (endLine !== null) anchors.add(endLine);
            break;
          }
        }
      }
    }

    if (commentBody) {
      const fromBody = parseLineReferencesFromBody(commentBody);
      fromBody.forEach((n) => anchors.add(n));
      if (fromBody.length > 0 && startLine === null) {
        startLine = fromBody[0]!;
        endLine = fromBody[fromBody.length - 1]!;
      }
    }

    if (startLine === null && commentBody) {
      const keywordLine = findAnchorLineFromCommentKeywords(lines, commentBody);
      if (keywordLine !== null) {
        anchors.add(keywordLine);
        startLine = keywordLine;
        endLine = keywordLine;
      }
    }

    // When the comment references lines beyond the file length, the file was likely
    // shortened/rewritten and the comment is stale. Provide the full file (if small)
    // so the verifier can see the code is gone rather than defaulting to YES.
    const maxAnchorAll = anchors.size > 0 ? Math.max(...anchors) : null;
    const commentRefsBeyondFile = maxAnchorAll !== null && maxAnchorAll > lines.length;

    // Small file or stale-reference: return entire file with (end of file) marker
    const SMALL_FILE_FULL_THRESHOLD = 250;
    if (lines.length <= SMALL_FILE_FULL_THRESHOLD || commentRefsBeyondFile) {
      const note = commentRefsBeyondFile
        ? `end of file — ${lines.length} lines total; comment references line ${maxAnchorAll} which no longer exists`
        : `end of file — ${lines.length} lines total`;
      return buildNumberedFullFileSnippet(content, note);
    }

    // Cycle 27: reply.ts gets broader snippet so judge sees enough of reply action handler (avoids STALE).
    if (path.endsWith('reply.ts') || (commentBody && commentNeedsConservativeAnalysisContext(commentBody))) {
      const conservativeSnippet = buildConservativeAnalysisSnippet(content, path, line, commentBody ?? '');
      if (conservativeSnippet) return conservativeSnippet;
    }

    if (startLine === null) {
      // No anchors: return first 50 lines
      return lines.slice(0, 50).join('\n') + `\n... (${lines.length - 50} more lines)`;
    }

    // Use union of anchors for range when we have body-derived refs
    const minAnchor = anchors.size > 0 ? Math.min(...anchors) : startLine;
    const maxAnchor = anchors.size > 0 ? Math.max(...anchors) : (endLine ?? startLine);

    let start = Math.max(0, minAnchor - CODE_SNIPPET_CONTEXT_BEFORE - 1);
    let end = Math.min(lines.length, maxAnchor + CODE_SNIPPET_CONTEXT_AFTER);

    if (end - start > MAX_SNIPPET_LINES) {
      const center = Math.floor((minAnchor + maxAnchor) / 2);
      const half = Math.floor(MAX_SNIPPET_LINES / 2);
      start = Math.max(0, center - half - 1);
      end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
    }

    const snippet = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');

    // Append (end of file) when snippet reaches the last line, or truncation marker otherwise
    if (end >= lines.length) {
      return snippet + `\n(end of file — ${lines.length} lines total)`;
    }
    return snippet + `\n... (truncated — file has ${lines.length} lines total)`;
  } catch {
    const createFileSnippet = await buildMissingCreateFileSnippet(workdir, path, commentBody);
    if (createFileSnippet) return createFileSnippet;
    return '(file not found or unreadable)';
  }
}

/** Max size for full-file content in final audit (avoid huge prompts / context overflow). */
const MAX_FULL_FILE_AUDIT_CHARS = 50_000;

/** Max chars for wider snippet in batch analysis when initial snippet is too short (prompts.log audit: verifier said "snippet truncated"). */
const MAX_WIDER_SNIPPET_ANALYSIS_CHARS = 12_000;

const WIDER_SNIPPET_LINES = 80;

/** Extract code-like tokens from comment body to anchor snippet when no line number. Prompts.log audit: first 80 lines showed only imports/class header; buggy code was deeper. */
function findAnchorLineFromCommentKeywords(lines: string[], commentBody: string | undefined): number | null {
  if (!commentBody || lines.length === 0) return null;
  const tokens: string[] = [];
  const backtickRe = /`([a-zA-Z_][a-zA-Z0-9_.]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(commentBody)) !== null) {
    if (m[1].length > 2) tokens.push(m[1]);
  }
  const snakeCamelRe = /\b([a-z]+_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
  while ((m = snakeCamelRe.exec(commentBody)) !== null) {
    if (m[1].length > 3) tokens.push(m[1]);
  }
  const seen = new Set<string>();
  const unique = tokens.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const token of unique) {
      if (token.length < 4) continue;
      const re = new RegExp(`\\b${escapeRegExpForSnippet(token)}\\b`);
      if (re.test(line)) return i + 1;
    }
  }
  return null;
}

function escapeRegExpForSnippet(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shared windowing: parse anchors from line + commentBody, center an 80-line window, cap at MAX_WIDER_SNIPPET_ANALYSIS_CHARS. */
function buildWindowedSnippet(
  fileContent: string,
  line: number | null,
  commentBody?: string
): string {
  const lines = fileContent.split('\n');
  const anchors = new Set<number>();
  if (line !== null) anchors.add(line);
  let startLine: number | null = line;
  let endLine: number | null = line;
  if (startLine === null && commentBody) {
    const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
    if (locationsMatch) {
      const locationLines = locationsMatch[1].trim().split('\n');
      for (const loc of locationLines) {
        const lineMatch = loc.match(/#L(\d+)(?:-L(\d+))?/);
        if (lineMatch) {
          startLine = parseInt(lineMatch[1], 10);
          endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : startLine + 20;
          anchors.add(startLine);
          if (endLine !== null) anchors.add(endLine);
          break;
        }
      }
    }
  }
  if (commentBody) {
    const fromBody = parseLineReferencesFromBody(commentBody);
    fromBody.forEach((n) => anchors.add(n));
    if (fromBody.length > 0 && startLine === null) {
      startLine = fromBody[0]!;
      endLine = fromBody[fromBody.length - 1]!;
    }
  }
  if (startLine === null && anchors.size === 0 && commentBody) {
    const keywordLine = findAnchorLineFromCommentKeywords(lines, commentBody);
    if (keywordLine !== null) {
      anchors.add(keywordLine);
      startLine = keywordLine;
      endLine = keywordLine;
    }
  }
  const halfWindow = Math.floor(WIDER_SNIPPET_LINES / 2);
  let start: number;
  let end: number;
  if (startLine !== null || anchors.size > 0) {
    const minAnchor = anchors.size > 0 ? Math.min(...anchors) : startLine!;
    const maxAnchor = anchors.size > 0 ? Math.max(...anchors) : (endLine ?? startLine!);
    const center = Math.floor((minAnchor + maxAnchor) / 2);
    start = Math.max(0, center - 1 - halfWindow);
    end = Math.min(lines.length, start + WIDER_SNIPPET_LINES);
  } else {
    start = 0;
    end = Math.min(lines.length, WIDER_SNIPPET_LINES);
  }
  const slice = lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join('\n');
  return slice.length > MAX_WIDER_SNIPPET_ANALYSIS_CHARS
    ? slice.substring(0, MAX_WIDER_SNIPPET_ANALYSIS_CHARS) + '\n... (truncated)'
    : slice;
}

/**
 * Return a wider file excerpt for batch analysis when the normal snippet is too short.
 * Gives the verifier enough context to avoid "snippet truncated; cannot verify" YES responses.
 * Uses same anchor logic as getCodeSnippet (line + commentBody LOCATIONS + parseLineReferencesFromBody) so the window is centered on the relevant range.
 */
export async function getWiderSnippetForAnalysis(
  workdir: string,
  path: string,
  line: number | null,
  commentBody?: string
): Promise<string> {
  try {
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    return buildWindowedSnippet(content, line, commentBody);
  } catch {
    return '(file not found or unreadable)';
  }
}

/** Build a snippet from raw file content. Used when file is not in workdir but we have content from git show. */
function buildSnippetFromRepoContent(
  content: string,
  line: number | null,
  commentBody?: string,
  filePath = '(repo content)'
): string {
  if (commentBody && commentNeedsConservativeAnalysisContext(commentBody)) {
    const conservativeSnippet = buildConservativeAnalysisSnippet(content, filePath, line, commentBody);
    if (conservativeSnippet) return conservativeSnippet;
  }
  return buildWindowedSnippet(content, line, commentBody);
}

function isLikelyCreateFilePath(path: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i.test(path);
}

function inferSourceCandidatesFromMissingTestPath(testPath: string, commentBody?: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  add(testPath.replace(/\/__tests__\//g, '/').replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/i, '.$2'));
  add(testPath.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/i, '.$2'));

  const referencedPaths = commentBody?.match(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx))`/g) ?? [];
  for (const ref of referencedPaths) add(ref.replace(/`/g, ''));

  return candidates;
}

/**
 * Build context for issues whose target file does not exist yet.
 *
 * WHY: Missing test/spec files should not degrade to the generic unreadable-file
 * placeholder. The fixer needs to see that the correct action is "create this
 * file", ideally with nearby source context when we can infer it.
 */
async function buildMissingCreateFileSnippet(
  workdir: string,
  missingPath: string,
  commentBody?: string
): Promise<string | null> {
  if (!isLikelyCreateFilePath(missingPath)) return null;

  const intro = [
    `Requested new file \`${missingPath}\` does not exist yet.`,
    'Treat this as a create-file issue and add the missing test/spec file.',
  ];

  for (const candidate of inferSourceCandidatesFromMissingTestPath(missingPath, commentBody)) {
    try {
      const content = await readFile(join(workdir, candidate), 'utf-8');
      return [
        ...intro,
        '',
        `Nearby source context from \`${candidate}\`:`,
        '',
        buildSnippetFromRepoContent(content, null, commentBody, candidate),
      ].join('\n');
    } catch {
      // Try the next candidate.
    }
  }

  if (commentBody?.trim()) {
    return [...intro, '', 'Review comment:', sanitizeCommentForPrompt(commentBody)].join('\n');
  }
  return intro.join('\n');
}

/**
 * Get full file content for final audit so the LLM sees complete context
 * instead of truncated snippets that can cause false "UNFIXED" verdicts.
 */
export async function getFullFileForAudit(workdir: string, path: string): Promise<string> {
  try {
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    if (content.length > MAX_FULL_FILE_AUDIT_CHARS) {
      const lines = content.split('\n');
      const keep = Math.floor(MAX_FULL_FILE_AUDIT_CHARS / 80);
      return lines
        .slice(0, keep)
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n')
        + `\n... (${lines.length - keep} more lines omitted for size)`;
    }
    return content
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '(file not found or unreadable)';
  }
}

/**
 * Find which review comments still represent unresolved issues
 */
/** Optional options for findUnresolvedIssues (e.g. line map from git diff for post-push). */
export type FindUnresolvedIssuesOptions = {
  /** Map path -> (oldLine -> newLine) from git diff base..HEAD. Use when code moved so comment line refs stay valid. */
  lineMap?: Map<string, Map<number, number>>;
  /** When file is not in workdir, try to read from repo (e.g. git show HEAD:path). Used when snippet is "(file not found or unreadable)". */
  getFileContentFromRepo?: (path: string) => Promise<string | null>;
  /** Files changed in the PR (e.g. from git diff --name-only). When comment.path is a basename, prefer matching full path so issue targets the correct file. */
  changedFiles?: string[];
};

/** If the issue requests tests or review suggests fix-in-test (e.g. "fix mocks in tests"), return [primaryPath, testPath] so allowedPaths is set at issue build. */
function getAllowedPathsForNewIssue(comment: ReviewComment, primaryPath: string, codeSnippet: string, explanation: string | undefined): string[] | undefined {
  const issueLike = { comment: { ...comment, path: primaryPath }, codeSnippet, stillExists: true, explanation: explanation ?? '' };
  const testPath = getTestPathForSourceFileIssue(issueLike, { forceTestPath: reviewSuggestsFixInTest(comment.body ?? '') });
  const renameTarget = getRenameTargetPath(issueLike);
  const hiddenTestTargets = getMentionedTestFilePaths(issueLike);
  const extraPaths = [testPath, renameTarget, ...hiddenTestTargets].filter((p): p is string => Boolean(p));
  if (extraPaths.length === 0) return undefined;
  return filterAllowedPathsForFix([primaryPath, ...extraPaths]);
}

/** Allowed paths for a new issue: test path when relevant, plus any paths listed in "delete/remove these files" body. */
function getEffectiveAllowedPathsForNewIssue(comment: ReviewComment, primaryPath: string, codeSnippet: string, explanation: string | undefined): string[] {
  const base = getAllowedPathsForNewIssue(comment, primaryPath, codeSnippet, explanation) ?? [primaryPath];
  const deletePaths = getPathsToDeleteFromCommentBody(comment.body ?? '');
  if (deletePaths.length === 0) return base;
  return filterAllowedPathsForFix([...base, ...deletePaths]);
}

/** When comment.path is a basename (no directory), resolve to full path from diff if present. Prompts.log audit: fixer was sent wrong file (root reporting.py) when issue was about benchmarks/bfcl/reporting.py. */
function resolvePathFromDiff(commentPath: string, changedFiles: string[] | undefined): string | undefined {
  if (!changedFiles?.length || commentPath.includes('/')) return undefined;
  const base = commentPath;
  const full = changedFiles.find((f) => f.endsWith('/' + base) || f === base);
  return full && full !== base ? full : undefined;
}

/** True if the comment is purely positive (e.g. "What's Good", praise only). Prompts.log audit: such comments were sent to fixer 4× with every model saying nothing to fix. */
function isCommentPositiveOnly(body: string): boolean {
  if (!body || body.length > 2000) return false;
  const trimmed = body.trim();
  if (!/(?:^|\n)#*\s*✅\s*What's Good|Documentation:.*are now accurate|only contains positive feedback|looks clean and follows .*spec|nice work on the frontmatter structure|no hardcoded credentials|doesn'?t expose any sensitive APIs|no security (?:issues|concerns) identified/i.test(trimmed)) return false;
  if (/\b(?:fix|change|should|incorrect|missing|add|remove|update|⚠️|❌|issue\s+(is|with)|bug|error)\b/i.test(trimmed)) return false;
  return true;
}

/** True if the comment is a Vercel bot deployment status or team-permissions notification, not a code review. output.log audit: such comments burned 10 fix iterations. */
function isVercelDeploymentOrTeamComment(comment: { author: string; body: string }): boolean {
  if (comment.author !== 'vercel[bot]') return false;
  const b = (comment.body ?? '').trim();
  if (/\[vc\]:\s*#?[A-Za-z0-9=]+/.test(b)) return true;
  if (/must be a member of the \*\*[^*]+\*\* team on Vercel to deploy/i.test(b)) return true;
  return false;
}

export async function findUnresolvedIssues(
  comments: ReviewComment[],
  totalCount: number,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  runner: Runner,
  options: CLIOptions,
  workdir: string,
  getCodeSnippetFn: (path: string, line: number | null, commentBody?: string) => Promise<string>,
  getModelsForRunner: (runner: Runner) => string[],
  findUnresolvedIssuesOptions?: FindUnresolvedIssuesOptions
): Promise<{
  unresolved: UnresolvedIssue[];
  recommendedModels?: string[];
  recommendedModelIndex: number;
  modelRecommendationReasoning?: string;
  duplicateMap: Map<string, string[]>;
}> {
  const lineMap = findUnresolvedIssuesOptions?.lineMap;
  const getSnippet = lineMap
    ? (path: string, line: number | null, body?: string) => {
        const L = (line != null && path) ? (lineMap.get(path)?.get(line) ?? line) : line;
        return getCodeSnippetFn(path, L, body);
      }
    : getCodeSnippetFn;

  const unresolved: UnresolvedIssue[] = [];
  let alreadyResolved = 0;
  let skippedCache = 0;
  let staleRecheck = 0;
  let dismissedStaleFiles = 0;
  let dismissedChronicFailure = 0;
  let dismissedNotAnIssue = 0;
  let dismissedPlaceholder = 0;
  let dismissedRemaining = 0;

  const iterationCount = stateContext.state?.iterations?.length ?? 0;
  const effectiveExpiry = getVerificationExpiryForIterationCount(iterationCount);
  const staleVerifications = Verification.getStaleVerifications(stateContext, effectiveExpiry);
  
  // First pass: filter out already-verified issues, run solvability checks (sync),
  // then batch-fetch all code snippets concurrently.
  // WHY two-phase: Solvability checks are synchronous (file existence, attempt counts)
  // and filter out ~30-50% of comments. By running them first, we avoid fetching
  // snippets for issues we'll immediately dismiss. Then we fetch all remaining
  // snippets in parallel instead of one-at-a-time.
  const toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
    resolvedPath?: string;
  }> = [];

  // Phase 1: Sync filtering (verified, solvability)
  const changedFiles = findUnresolvedIssuesOptions?.changedFiles;
  const needSnippets: Array<{
    comment: ReviewComment;
    snippetLine: number | null;
    contextHints?: string[];
    resolvedPath?: string;
  }> = [];

  for (const comment of comments) {
    // GitHub marks threads as outdated when the commented line no longer exists in the current diff.
    // Treat them as not unaddressed so PRR's list matches the PR conversation view.
    if (comment.outdated) {
      continue;
    }

    const isStale = staleVerifications.includes(comment.id);
    
    // If --reverify flag is set, ignore the cache and re-check everything
    if (!options.reverify && !isStale && Verification.isVerified(stateContext, comment.id)) {
      alreadyResolved++;
      continue;
    }
    
    if (options.reverify && Verification.isVerified(stateContext, comment.id)) {
      skippedCache++;
    }
    
    if (isStale) {
      staleRecheck++;
    }

    if (isCommentPositiveOnly(comment.body ?? '')) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'Comment is purely positive (e.g. What\'s Good) with no actionable issue — dismissing',
        'not-an-issue',
        comment.path,
        comment.line,
        comment.body,
        undefined
      );
      dismissedNotAnIssue++;
      continue;
    }

    if (isVercelDeploymentOrTeamComment(comment)) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'Vercel deployment/team notification — not a code review; fix via Vercel dashboard',
        'not-an-issue',
        comment.path,
        comment.line,
        comment.body,
        undefined
      );
      dismissedNotAnIssue++;
      continue;
    }

    if ((stateContext.state?.couldNotInjectCountByCommentId?.[comment.id] ?? 0) >= COULD_NOT_INJECT_DISMISS_THRESHOLD) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'Target file could not be resolved in the repository (repeated could-not-inject + no-change cycles)',
        'file-unchanged',
        comment.path,
        comment.line,
        comment.body,
        undefined
      );
      continue;
    }

    // Deterministic solvability check (zero LLM cost)
    const solvability = assessSolvability(workdir, comment, stateContext);
    if (!solvability.solvable) {
      // CRITICAL: dismissIssue ONLY — do NOT call markVerified.
      // If the file comes back (revert, re-add), we want to re-analyze it.
      const reason = solvability.reason ?? `Issue not solvable (${solvability.dismissCategory ?? 'unknown'})`;
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        reason,
        solvability.dismissCategory!,
        comment.path,
        comment.line,
        comment.body,
        solvability.remediationHint
      );
      if (solvability.dismissCategory === 'stale') {
        dismissedStaleFiles++;
      } else if (solvability.dismissCategory === 'chronic-failure') {
        dismissedChronicFailure++;
      } else if (solvability.dismissCategory === 'not-an-issue') {
        dismissedNotAnIssue++;
      } else if (solvability.dismissCategory === 'remaining') {
        dismissedRemaining++;
      }
      continue;
    }

    const snippetLine = solvability.retargetedLine ?? comment.line;
    let contextHints = solvability.contextHints;
    // WHY: PRR appends "✅ Addressed in commits X to Y" after pushing a fix. When that comment
    // is still open (e.g. bot hasn't re-reviewed), the analysis LLM should verify that the
    // current code actually resolves the issue instead of assuming the prior fix is still valid.
    if (/✅\s*Addressed in commits?\s+\w+/i.test(comment.body)) {
      contextHints = [
        ...(contextHints || []),
        'A previous fix attempt claimed to address this issue. Verify whether the current code actually resolves it before making new changes.',
      ];
    }
    if (commentNeedsConservativeAnalysisContext(comment.body ?? '')) {
      contextHints = [
        ...(contextHints || []),
        'This is a lifecycle/order-sensitive issue. Answer NO only if the shown code provides concrete evidence that the full behavior is now correct.',
      ];
    }
    const resolvedPath = solvability.resolvedPath
      ?? resolvePathFromDiff(comment.path, changedFiles)
      ?? resolveTrackedPath(workdir, comment.path, comment.body)
      ?? undefined;
    needSnippets.push({ comment, snippetLine, contextHints, resolvedPath });
  }

  // Phase 2: Batch-fetch all code snippets concurrently
  // WHY parallel: Each snippet is an independent file read. With 30+ comments
  // surviving the solvability filter, sequential reads add ~1-2s of I/O latency.
  const snippetResults = await Promise.all(
    needSnippets.map(async ({ comment, snippetLine, contextHints, resolvedPath }) => {
      const pathForSnippet = resolvedPath ?? comment.path;
      const codeSnippet = await getSnippet(pathForSnippet, snippetLine, comment.body);
      return { comment, codeSnippet, contextHints, resolvedPath };
    })
  );

  // Phase 3: Post-filter placeholder results
  for (const { comment, codeSnippet, contextHints, resolvedPath } of snippetResults) {
    if (codeSnippet === SNIPPET_PLACEHOLDER) {
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        'File not found or unreadable after existence check passed',
        'stale',
        comment.path,
        comment.line,
        comment.body
      );
      dismissedPlaceholder++;
      continue;
    }

    toCheck.push({ comment, codeSnippet, contextHints, resolvedPath });
  }

  // Build stable commentId → display number mapping ONCE.
  // Used by candidate log (Phase 0) AND dedup verdicts (Phase 1) so that
  // "#7" means the same comment everywhere in the output.
  const idToDisplayNum = new Map<string, number>();
  for (let i = 0; i < toCheck.length; i++) {
    idToDisplayNum.set(toCheck[i].comment.id, i + 1);
  }

  // Phase 0: Log duplicate candidates (observation only, no filtering)
  logDuplicateCandidates(toCheck, idToDisplayNum);

  // ── Dedup cache: skip LLM dedup when full comment set is unchanged ─────────
  // Key by ALL comment IDs (from API), not toCheck. WHY: Push iteration 2+ often has same
  // comments but toCheck shrinks (some resolved), so keying by toCheck caused cache miss and
  // re-ran LLM dedup (~200k chars wasted). Reuse grouping for full set and filter to current toCheck.
  const allCommentIds = comments.map(c => c.id).sort().join(',');
  const persisted = stateContext.state?.dedupCache;
  const dedupCacheHit = persisted?.commentIds === allCommentIds && Array.isArray(persisted.dedupedIds) && persisted.duplicateMap && typeof persisted.duplicateMap === 'object';

  let dedupResult: DedupResult;

  if (dedupCacheHit && persisted) {
    const toCheckById = new Map(toCheck.map(item => [item.comment.id, item]));
    const persistedMap = new Map<string, string[]>(Object.entries(persisted.duplicateMap));
    const newDuplicateMap = new Map<string, string[]>();
    const newDuplicateItems = new Map<string, typeof toCheck[0]>();
    const repIds = new Set<string>();
    const inSomeGroup = new Set<string>();

    for (const [canonicalId, dupeIds] of persistedMap) {
      const allInGroup = [canonicalId, ...dupeIds];
      const inToCheck = allInGroup.filter(id => toCheckById.has(id));
      if (inToCheck.length === 0) continue;
      const repId = inToCheck[0];
      repIds.add(repId);
      for (const id of inToCheck) inSomeGroup.add(id);
      const otherIds = inToCheck.filter(id => id !== repId);
      if (otherIds.length > 0) {
        newDuplicateMap.set(repId, otherIds);
        for (const otherId of otherIds) {
          const otherItem = toCheckById.get(otherId);
          if (otherItem) newDuplicateItems.set(otherId, otherItem);
        }
      }
    }
    const dedupedToCheck = [
      ...repIds,
      ...toCheck.filter(i => !inSomeGroup.has(i.comment.id)).map(i => i.comment.id),
    ].map(id => toCheckById.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
    dedupResult = {
      dedupedToCheck,
      duplicateMap: newDuplicateMap,
      duplicateItems: newDuplicateItems,
    };
    console.log(chalk.gray(`  Dedup results reused (comment set unchanged, ${formatNumber(dedupResult.duplicateMap.size)} canonical groups)`));
  } else {
    // Phase 1: Heuristic deduplication (zero LLM cost)
    try {
      dedupResult = heuristicDedup(toCheck, idToDisplayNum);
    } catch (err) {
      warn(`Dedup failed, proceeding without dedup: ${err}`);
      dedupResult = {
        dedupedToCheck: toCheck,
        duplicateMap: new Map(),
        duplicateItems: new Map(),
      };
    }

    // Phase 2: LLM semantic deduplication (catches what heuristics miss)
    // Only runs when files have 3+ remaining issues — lightweight, typically <2k tokens.
    // Rate limits: global 1 concurrent + 6s delay + 429 retry backoff keep us under 10/min.
    try {
      dedupResult = await llmDedup(dedupResult, toCheck, llm);
    } catch (err) {
      warn(`LLM dedup failed, proceeding with heuristic-only results: ${err}`);
    }

    // Persist dedup results keyed by full comment set so next run (or push iteration) can skip LLM when comments unchanged.
    if (stateContext.state) {
      stateContext.state.dedupCache = {
        commentIds: allCommentIds,
        duplicateMap: Object.fromEntries(dedupResult.duplicateMap),
        dedupedIds: dedupResult.dedupedToCheck.map(item => item.comment.id),
      };
    }
  }

  // Use deduplicated list for analysis
  const toAnalyze = dedupResult.dedupedToCheck;

  // ── Comment status: skip LLM for open comments on unchanged files ─────
  //
  // HISTORY: Every push iteration sent ALL unresolved comments to the LLM
  // for classification, even when neither the comment body nor its target
  // file had changed. For 20+ issues this burned 5-15s and thousands of
  // tokens on identical "still exists" results. Now each comment has an
  // explicit open/resolved status in the persisted state. "Open" comments
  // whose target file hasn't been modified are skipped — we already know
  // the issue exists. Only new comments and comments on modified files
  // (where our fixes may have resolved them) go through the LLM.

  // Compute file content hashes (batched by unique path)
  const uniqueAnalyzePaths = new Set(toAnalyze.map(item => item.comment.path));
  const fileHashes = new Map<string, string>();
  await Promise.all(
    Array.from(uniqueAnalyzePaths).map(async (p) => {
      fileHashes.set(p, await hashFileContent(workdir, p));
    })
  );

  // Build a set for fast lookup in the status check loop (after dedup, before status split).
  // HISTORY: staleVerifications forces re-check of comments verified 5+ iterations ago.
  // Without this bypass, Phase 0 hooks would mark them 'resolved', Phase 2 hash relaxation
  // would return the status, and line 774 would re-dismiss them — defeating stale re-check.
  const staleVerificationSet = new Set(staleVerifications);

  // Split toAnalyze into status hits (reuse) and fresh items (need LLM)
  const freshToAnalyze: typeof toAnalyze = [];
  let statusHits = 0;

  for (const item of toAnalyze) {
    const fileHash = fileHashes.get(item.comment.path) || '__missing__';
    
    // Both --reverify and stale verifications force fresh LLM analysis.
    // --reverify: user explicitly wants to re-check everything.
    // staleVerifications: comment was verified 5+ iterations ago, fix may have regressed.
    // Without this, Phase 0 hooks + Phase 2 hash relaxation would make these
    // bypass the LLM entirely, defeating the purpose of stale verification.
    const forceReanalyze = options.reverify || staleVerificationSet.has(item.comment.id);
    const validStatus = forceReanalyze
      ? undefined
      : CommentStatusAPI.getValidStatus(stateContext, item.comment.id, fileHash);

    if (validStatus && validStatus.status === 'open') {
      // Status hit: comment is "open" and file hasn't changed since classification
      statusHits++;

      // Issue still exists — reuse persisted classification
      const duplicates = dedupResult.duplicateMap.get(item.comment.id);
      const mergedDuplicates = duplicates?.map(dupId => {
        const dupItem = dedupResult.duplicateItems.get(dupId);
        return dupItem ? {
          commentId: dupItem.comment.id,
          author: dupItem.comment.author,
          body: dupItem.comment.body,
          path: dupItem.comment.path,
          line: dupItem.comment.line,
        } : null;
      }).filter((d): d is NonNullable<typeof d> => d !== null);

      unresolved.push({
        comment: item.comment,
        codeSnippet: item.codeSnippet,
        stillExists: true,
        explanation: validStatus.explanation,
        triage: { importance: validStatus.importance, ease: validStatus.ease },
        mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
        allowedPaths: getEffectiveAllowedPathsForNewIssue(item.comment, item.resolvedPath ?? item.comment.path, item.codeSnippet, validStatus.explanation),
        resolvedPath: item.resolvedPath,
      });
    } else if (validStatus && validStatus.status === 'resolved') {
      // Resolved but not in verifiedFixed (stale dismissal) — re-dismiss preserving existing category
      const existing = Dismissed.getDismissedIssue(stateContext, item.comment.id);
      if (existing) {
        Dismissed.dismissIssue(stateContext, item.comment.id, existing.reason ?? 'Previously dismissed', existing.category,
          item.comment.path, item.comment.line, item.comment.body, existing.remediationHint);
      } else {
        Dismissed.dismissIssue(stateContext, item.comment.id, validStatus.explanation ?? 'Resolved (no explanation recorded)',
          validStatus.classification === 'stale' ? 'stale' : 'already-fixed',
          item.comment.path, item.comment.line, item.comment.body);
      }
      statusHits++;
    } else {
      // No valid status: new comment, or file changed → need fresh LLM analysis
      freshToAnalyze.push(item);
    }
  }

  // Report solvability dismissals — issues leaving the queue before fix attempt
  const totalDismissed = dismissedStaleFiles + dismissedChronicFailure + dismissedNotAnIssue + dismissedPlaceholder + dismissedRemaining;
  if (totalDismissed > 0) {
    const parts: string[] = [];
    if (dismissedStaleFiles > 0) parts.push(`${formatNumber(dismissedStaleFiles)} stale file(s)`);
    if (dismissedChronicFailure > 0) parts.push(`${formatNumber(dismissedChronicFailure)} chronic failure(s)`);
    if (dismissedNotAnIssue > 0) parts.push(`${formatNumber(dismissedNotAnIssue)} lockfile/not-an-issue`);
    if (dismissedPlaceholder > 0) parts.push(`${formatNumber(dismissedPlaceholder)} unreadable file(s)`);
    if (dismissedRemaining > 0) parts.push(`${formatNumber(dismissedRemaining)} remaining (verifier/wrong-file exhaust)`);
    console.log(chalk.gray(`  DISMISSED: ${formatNumber(totalDismissed)} issue(s) removed from queue (${parts.join(', ')})`));
    if (dismissedChronicFailure > 0) {
      console.log(chalk.cyan(`  ↳ ${formatNumber(dismissedChronicFailure)} chronic-failure dismissal(s) — token-saving (no LLM retries)`));
    }
  }

  if (options.reverify && skippedCache > 0) {
    console.log(chalk.yellow(`  --reverify: Re-checking ${skippedCache} previously cached as "fixed"`));
  } else if (alreadyResolved > 0) {
    console.log(chalk.gray(`  ${alreadyResolved} already verified as fixed (cached)`));
  }
  
  if (staleRecheck > 0) {
    console.log(chalk.yellow(`  ${staleRecheck} stale verifications (>${effectiveExpiry} iterations old) - re-checking`));
  }

  // Report comment status stats
  if (statusHits > 0) {
    console.log(chalk.gray(`  ${formatNumber(statusHits)} comment(s) skipped (status unchanged — open issues on unmodified files)`));
  }
  if (freshToAnalyze.length > 0 && statusHits > 0) {
    console.log(chalk.gray(`  ${formatNumber(freshToAnalyze.length)} comment(s) need fresh LLM analysis (new or file changed)`));
  }

  if (freshToAnalyze.length === 0) {
    // All items served from persisted status — no LLM call needed
    if (statusHits > 0 && toAnalyze.length > 0) {
      console.log(chalk.green(`  ✓ All ${formatNumber(statusHits)} issue(s) served from persisted status — skipping LLM analysis`));
    }
    if (options.verbose) {
      printDebugIssueTable('after analysis', comments, stateContext, unresolved);
    }
    return {
      unresolved,
      recommendedModelIndex: 0,
      duplicateMap: dedupResult.duplicateMap,
    };
  }

  let recommendedModels: string[] | undefined;
  let recommendedModelIndex = 0;
  let modelRecommendationReasoning: string | undefined;

  if (options.noBatch) {
    // Sequential mode - one LLM call per comment
    console.log(chalk.gray(`  Analyzing ${formatNumber(freshToAnalyze.length)} comments sequentially...`));
    
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const { comment, codeSnippet, contextHints, resolvedPath } = freshToAnalyze[i];
      console.log(chalk.gray(`    [${formatNumber(i + 1)}/${formatNumber(freshToAnalyze.length)}] ${comment.path}:${comment.line || '?'}`));
      
      const result = await llm.checkIssueExists(
        comment.body,
        comment.path,
        comment.line,
        codeSnippet,
        contextHints
      );

      // Persist comment status
      const fHash = fileHashes.get(comment.path) || '__missing__';
      if (result.stale) {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'stale', result.explanation, comment.path, fHash);
      } else if (result.exists) {
        CommentStatusAPI.markOpen(stateContext, comment.id, 'exists', result.explanation, 3, 3, comment.path, fHash);
      } else {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'fixed', result.explanation, comment.path, fHash);
      }

      if (result.stale) {
        // Issue is stale (code fundamentally restructured) - dismiss without marking verified
        if (validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            result.explanation,
            'stale',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          warn(`Stale issue missing valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue is stale, but provided insufficient explanation',
            triage: { importance: 3, ease: 3 },  // Default: sequential mode has no triage
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, undefined),
            resolvedPath,
          });
        }
      } else if (result.exists) {
        // Check if this is a canonical issue with duplicates
        const duplicates = dedupResult.duplicateMap.get(comment.id);
        const mergedDuplicates = duplicates?.map(dupId => {
          const dupItem = dedupResult.duplicateItems.get(dupId);
          return dupItem ? {
            commentId: dupItem.comment.id,
            author: dupItem.comment.author,
            body: dupItem.comment.body,
            path: dupItem.comment.path,
            line: dupItem.comment.line,
          } : null;
        }).filter((d): d is NonNullable<typeof d> => d !== null);

        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: result.explanation,
          triage: { importance: 3, ease: 3 },  // Default: sequential mode has no triage
          mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, result.explanation),
          resolvedPath,
        });
      } else {
        // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
        if (validateDismissalExplanation(result.explanation, comment.path, comment.line)) {
          // Valid explanation - document why it doesn't need fixing
          Verification.markVerified(stateContext, comment.id);
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            result.explanation,
            'already-fixed',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          // Invalid/missing explanation - treat as unresolved (potential bug)
          warn(`Cannot dismiss without valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
            triage: { importance: 3, ease: 3 },  // Default: sequential mode has no triage
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, undefined),
            resolvedPath,
          });
        }
      }
    }
  } else {
    // Batch mode - one LLM call for all comments
    console.log(chalk.gray(`  Batch analyzing ${formatNumber(freshToAnalyze.length)} comments with LLM...`));
    // Prompts.log audit: when snippet is too short, verifier returns "snippet truncated; cannot verify". Expand once before sending.
    const batchInput = await Promise.all(
      freshToAnalyze.map(async (item, index) => {
        let codeSnippet = item.codeSnippet;
        const primaryPath = item.resolvedPath ?? item.comment.path;
        if (isSnippetTooShort(codeSnippet)) {
          codeSnippet = await getWiderSnippetForAnalysis(workdir, primaryPath, item.comment.line, item.comment.body);
        }
        // When file was not in workdir, try reading from repo (e.g. git show HEAD:path) so verifier has context.
        if (codeSnippet === '(file not found or unreadable)' && findUnresolvedIssuesOptions?.getFileContentFromRepo) {
          const content = await findUnresolvedIssuesOptions.getFileContentFromRepo(primaryPath);
          if (content) {
            codeSnippet = buildSnippetFromRepoContent(content, item.comment.line, item.comment.body, primaryPath);
          }
        }
        return {
          id: `issue_${index + 1}`,
          comment: sanitizeCommentForPrompt(item.comment.body),
          filePath: primaryPath,
          line: item.comment.line,
          codeSnippet,
          contextHints: item.contextHints,
        };
      })
    );

    // Build model context for smart model selection (unless --model-rotation is set)
    let modelContext: ModelRecommendationContext | undefined;
    if (!options.modelRotation) {
      const availableModels = getModelsForRunner(runner);
      // Get attempt history for these specific issues
      const commentIds = freshToAnalyze.map(item => item.comment.id);
      modelContext = {
        availableModels,
        modelHistory: Performance.getModelHistorySummary(stateContext) || undefined,
        attemptHistory: Performance.getAttemptHistoryForIssues(stateContext, commentIds),
        // WHY false: Verification only judges issues; model recommendation block wasted ~60k chars/run (audit). Recommendation is not used for verify path.
        includeModelRecommendation: false,
      };
    }

    type BatchInputItem = Parameters<LLMClient['batchCheckIssuesExist']>[0][number];
    type BatchCheckResultType = Awaited<ReturnType<LLMClient['batchCheckIssuesExist']>>;

    const MAX_ANALYSIS_RETRIES = 2;
    const ANALYSIS_RETRY_DELAY_MS = [15_000, 30_000];
    const MIN_BATCH_SIZE_TO_SPLIT = 2;
    /** Reduced batch limits for retry after 500 — must be strictly smaller than initial (fewer issues + lower context cap) so prompt size never increases on retry. */
    const REDUCED_MAX_CONTEXT_CHARS = 50_000;
    const REDUCED_MAX_ISSUES_PER_BATCH = 5;

    type BatchOverrides = { maxContextChars?: number; maxIssuesPerBatch?: number };

    async function runBatchWithRetry(input: BatchInputItem[], overrides?: BatchOverrides): Promise<BatchCheckResultType> {
      const maxContextChars = overrides?.maxContextChars ?? options.maxContextChars;
      const maxIssuesPerBatch = overrides?.maxIssuesPerBatch;
      for (let attempt = 0; ; attempt++) {
        try {
          return await llm.batchCheckIssuesExist(input, modelContext, maxContextChars, maxIssuesPerBatch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isTransient = /500|502|504|timeout|gateway|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
          if (isTransient && attempt < MAX_ANALYSIS_RETRIES) {
            const delay = ANALYSIS_RETRY_DELAY_MS[attempt] ?? 30_000;
            warn(`Batch analysis failed (attempt ${attempt + 1}/${MAX_ANALYSIS_RETRIES + 1}): ${msg} — retrying in ${delay / 1000}s`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw err;
        }
      }
    }

    function mergeBatchResults(a: BatchCheckResultType, b: BatchCheckResultType): BatchCheckResultType {
      const issues = new Map(a.issues);
      for (const [k, v] of b.issues) issues.set(k, v);
      return {
        issues,
        recommendedModels: a.recommendedModels?.length ? a.recommendedModels : b.recommendedModels,
        modelRecommendationReasoning: a.modelRecommendationReasoning ?? b.modelRecommendationReasoning,
        partial: a.partial || b.partial,
      };
    }

    let batchResult: BatchCheckResultType;
    const reducedOverrides: BatchOverrides = { maxContextChars: REDUCED_MAX_CONTEXT_CHARS, maxIssuesPerBatch: REDUCED_MAX_ISSUES_PER_BATCH };
    try {
      batchResult = await runBatchWithRetry(batchInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /500|502|504|timeout|gateway|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (isTransient && batchInput.length >= MIN_BATCH_SIZE_TO_SPLIT) {
        // First retry with smaller per-batch size (avoids 200k-char prompts that 500)
        try {
          warn(`Batch analysis failed after retries — retrying with smaller batches (max ${REDUCED_MAX_ISSUES_PER_BATCH} issues, ${REDUCED_MAX_CONTEXT_CHARS / 1000}k chars)`);
          batchResult = await runBatchWithRetry(batchInput, reducedOverrides);
        } catch (reduceErr) {
          // Then split input in half and run each with reduced limits
          const mid = Math.ceil(batchInput.length / 2);
          const firstBatchInput = batchInput.slice(0, mid);
          const secondBatchInput = batchInput.slice(mid).map((item, index) => ({
            ...item,
            id: `issue_${mid + index + 1}`,
          }));
          warn(`Batch analysis failed with reduced size — splitting into ${formatNumber(firstBatchInput.length)} + ${formatNumber(secondBatchInput.length)} issues and retrying`);
          let firstResult: BatchCheckResultType;
          try {
            firstResult = await runBatchWithRetry(firstBatchInput, reducedOverrides);
          } catch (firstErr) {
            warn(`Batch analysis failed: ${msg}`);
            throw new Error(`Batch analysis failed (${formatNumber(freshToAnalyze.length)} issues): ${msg}`);
          }
          try {
            const secondResult = await runBatchWithRetry(secondBatchInput, reducedOverrides);
            batchResult = mergeBatchResults(firstResult, secondResult);
          } catch (secondErr) {
            warn(`Second half failed after split — saving partial results (${formatNumber(firstResult.issues.size)}/${formatNumber(freshToAnalyze.length)} issues)`);
            batchResult = { ...firstResult, partial: true };
          }
        }
      } else {
        warn(`Batch analysis failed: ${msg}`);
        throw new Error(`Batch analysis failed (${formatNumber(freshToAnalyze.length)} issues): ${msg}`);
      }
    }

    // Separate model recommendation call after all verification batches (saves tokens vs baking into first batch).
    // Skip when 0 or 1 issue actually to fix — use default rotation; saves ~4s and tokens (output.log audit).
    // WHY: For a single fixable issue the recommendation adds little value; default rotation is sufficient.
    const analyzedIds = new Set(freshToAnalyze.map((item) => item.comment.id));
    const cachedOpenNotInBatch = comments.filter(
      (c) =>
        !Verification.isVerified(stateContext, c.id)
        && !Dismissed.isCommentDismissed(stateContext, c.id)
        && !analyzedIds.has(c.id)
    ).length;
    let toFixFromBatch = 0;
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const r = batchResult.issues.get(batchInput[i].id);
      if (r?.exists && !Verification.isVerified(stateContext, freshToAnalyze[i].comment.id)) toFixFromBatch++;
    }
    const toFixCount = toFixFromBatch + cachedOpenNotInBatch;
    if (toFixCount >= 5 && modelContext?.availableModels?.length) {
      const summaryLines = [...batchResult.issues.entries()].map(([id, r]) => {
        const triage = r.exists ? ` I${r.importance} D${r.ease}` : '';
        const snippet = r.explanation.slice(0, 200).replace(/\n/g, ' ');
        return `${id}: ${r.exists ? 'YES' : r.stale ? 'STALE' : 'NO'}${triage} | ${snippet}`;
      });
      // Audit: recommender didn't account for prompt size; 94k prompt timed out. Rough estimate: ~5k chars per issue + header.
      const estimatedFixPromptChars = toFixCount * 5000 + 20000;
      const modelContextWithEstimate = { ...modelContext, estimatedFixPromptChars };
      try {
        const rec = await llm.getModelRecommendationOnly(summaryLines.join('\n'), modelContextWithEstimate);
        if (rec.recommendedModels?.length) {
          batchResult = {
            ...batchResult,
            recommendedModels: rec.recommendedModels,
            modelRecommendationReasoning: rec.reasoning,
          };
        }
      } catch (recErr) {
        debug('Model recommendation call failed', recErr);
      }
    }

    const results = batchResult.issues;
    debug('Batch analysis results', { count: results.size });

    // Store model recommendation for use in fix loop
    if (batchResult.recommendedModels?.length) {
      recommendedModels = batchResult.recommendedModels;
      recommendedModelIndex = 0;
      modelRecommendationReasoning = batchResult.modelRecommendationReasoning;
      console.log(chalk.cyan(`  📊 Model recommendation: ${recommendedModels.join(', ')}`));
      // Only show reasoning when it looks like real explanation, not the literal prompt phrase
      const reasoning = modelRecommendationReasoning?.trim();
      if (reasoning && reasoning.length > 40 && !/explain why these models in this order/i.test(reasoning)) {
        console.log(chalk.gray(`     (${reasoning})`));
      }
    }

    // Process results
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const { comment, codeSnippet, contextHints, resolvedPath } = freshToAnalyze[i];
      const issueId = batchInput[i].id.toLowerCase();
      const result = results.get(issueId);

      if (!result) {
        // If LLM didn't return a result for this, assume it still exists
        warn(`No result for comment ${issueId}, assuming unresolved`);
        
        // Don't cache: LLM failure, next iteration should retry
        
        // Check if this is a canonical issue with duplicates
        const duplicates = dedupResult.duplicateMap.get(comment.id);
        const mergedDuplicates = duplicates?.map(dupId => {
          const dupItem = dedupResult.duplicateItems.get(dupId);
          return dupItem ? {
            commentId: dupItem.comment.id,
            author: dupItem.comment.author,
            body: dupItem.comment.body,
            path: dupItem.comment.path,
            line: dupItem.comment.line,
          } : null;
        }).filter((d): d is NonNullable<typeof d> => d !== null);

        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: 'Unable to determine status',
          triage: { importance: 3, ease: 3 },  // Default: fallback path
          mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, undefined),
          resolvedPath,
        });
        continue;
      }

      // Post-STALE grep: if LLM said STALE and named a symbol, check if that symbol is still in the file
      let effectiveResult = result;
      if (result.stale) {
        const symbols = extractSymbolsFromStaleExplanation(result.explanation);
        const primaryPath = resolvedPath ?? comment.path;
        for (const sym of symbols) {
          if (await fileContainsSymbol(workdir, primaryPath, sym)) {
            debug(`Post-STALE grep: "${sym}" found in ${primaryPath}, overriding STALE→YES`);
            effectiveResult = {
              ...result,
              stale: false,
              exists: true,
              explanation: `${result.explanation} [Override: symbol "${sym}" still present in file]`,
            };
            break;
          }
        }
      }

      // Persist comment status
      const fHash = fileHashes.get(comment.path) || '__missing__';
      if (effectiveResult.stale) {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'stale', effectiveResult.explanation, comment.path, fHash);
      } else if (effectiveResult.exists) {
        CommentStatusAPI.markOpen(stateContext, comment.id, 'exists', effectiveResult.explanation, effectiveResult.importance ?? 3, effectiveResult.ease ?? 3, comment.path, fHash);
      } else {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'fixed', effectiveResult.explanation, comment.path, fHash);
      }

      if (effectiveResult.stale) {
        // Issue is stale (code fundamentally restructured) - dismiss without marking verified
        if (validateDismissalExplanation(effectiveResult.explanation, comment.path, comment.line)) {
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            effectiveResult.explanation,
            'stale',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          warn(`Stale issue missing valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue is stale, but provided insufficient explanation',
            triage: { importance: effectiveResult.importance, ease: effectiveResult.ease },
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, effectiveResult.explanation),
            resolvedPath,
          });
        }
      } else if (effectiveResult.exists) {
        // Check if this is a canonical issue with duplicates
        const duplicates = dedupResult.duplicateMap.get(comment.id);
        const mergedDuplicates = duplicates?.map(dupId => {
          const dupItem = dedupResult.duplicateItems.get(dupId);
          return dupItem ? {
            commentId: dupItem.comment.id,
            author: dupItem.comment.author,
            body: dupItem.comment.body,
            path: dupItem.comment.path,
            line: dupItem.comment.line,
          } : null;
        }).filter((d): d is NonNullable<typeof d> => d !== null);

        unresolved.push({
          comment,
          codeSnippet,
          stillExists: true,
          explanation: effectiveResult.explanation,
          triage: { importance: effectiveResult.importance, ease: effectiveResult.ease },
          mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, effectiveResult.explanation),
          resolvedPath,
        });
      } else {
        // Issue appears to be already fixed - but we can ONLY dismiss if we have a valid explanation
        if (validateDismissalExplanation(effectiveResult.explanation, comment.path, comment.line)) {
          // Valid explanation - document why it doesn't need fixing
          Verification.markVerified(stateContext, comment.id);
          Dismissed.dismissIssue(
            stateContext,
            comment.id,
            effectiveResult.explanation,
            'already-fixed',
            comment.path,
            comment.line,
            comment.body
          );
        } else {
          // Invalid/missing explanation - treat as unresolved (potential bug)
          warn(`Cannot dismiss without valid explanation - marking as unresolved`);
          
          // Check if this is a canonical issue with duplicates
          const duplicates = dedupResult.duplicateMap.get(comment.id);
          const mergedDuplicates = duplicates?.map(dupId => {
            const dupItem = dedupResult.duplicateItems.get(dupId);
            return dupItem ? {
              commentId: dupItem.comment.id,
              author: dupItem.comment.author,
              body: dupItem.comment.body,
              path: dupItem.comment.path,
              line: dupItem.comment.line,
            } : null;
          }).filter((d): d is NonNullable<typeof d> => d !== null);

          unresolved.push({
            comment,
            codeSnippet,
            stillExists: true,
            explanation: 'LLM indicated issue does not exist, but provided insufficient explanation to dismiss',
            triage: { importance: effectiveResult.importance, ease: effectiveResult.ease },
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
            allowedPaths: getEffectiveAllowedPathsForNewIssue(comment, resolvedPath ?? comment.path, codeSnippet, effectiveResult.explanation),
            resolvedPath,
          });
        }
      }
    }

    if (batchResult.partial) {
      await State.saveState(stateContext);
      await LessonsAPI.Save.save(lessonsContext);
      throw new Error(
        `Batch analysis incomplete: ${formatNumber(results.size)}/${formatNumber(freshToAnalyze.length)} issues analyzed (partial results saved - re-run to continue)`
      );
    }
  }

  await State.saveState(stateContext);
  await LessonsAPI.Save.save(lessonsContext);
  if (options.verbose) {
    printDebugIssueTable('after analysis', comments, stateContext, unresolved);
  }
  
  return {
    unresolved,
    recommendedModels,
    recommendedModelIndex,
    modelRecommendationReasoning,
    duplicateMap: dedupResult.duplicateMap,
  };
}
