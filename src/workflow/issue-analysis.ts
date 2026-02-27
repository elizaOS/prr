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
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as CommentStatusAPI from '../state/state-comment-status.js';
import * as State from '../state/state-core.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient, ModelRecommendationContext } from '../llm/client.js';
import type { Runner } from '../runners/types.js';
import {
  CODE_SNIPPET_CONTEXT_AFTER,
  CODE_SNIPPET_CONTEXT_BEFORE,
  LLM_DEDUP_MAX_CONCURRENT,
  MAX_SNIPPET_LINES,
  VERIFICATION_EXPIRY_ITERATIONS,
} from '../constants.js';
import { validateDismissalExplanation } from './utils.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, warn, formatNumber } from '../logger.js';
import { assessSolvability, SNIPPET_PLACEHOLDER } from './helpers/solvability.js';
import { sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';
import { hashFileContent } from '../utils/file-hash.js';

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

/**
 * Heuristic deduplication: filter obvious duplicates before batch analysis.
 * Phase 1: Zero LLM cost, uses deterministic logic.
 * 
 * Criteria for duplicates (stricter than Phase 0 candidates):
 * - Same file (exact path match)
 * - Lines within 10 of each other (both non-null), OR both null
 * - Same author (bots duplicate themselves, humans rarely do)
 * 
 * @param toCheck Array of issues with snippets
 * @returns DedupResult with filtered list, duplicate map, and duplicate items
 */
function heuristicDedup(
  toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
    contextHints?: string[];
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

        // Must have same author (key difference from Phase 0)
        if (author1 !== author2) continue;

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
  toCheck: Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[] }>,
  llm: LLMClient
): Promise<DedupResult> {
  // Find items that survived heuristic dedup — only compare within same file
  const byFile = new Map<string, Array<{ comment: ReviewComment; codeSnippet: string; contextHints?: string[] }>>();
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
    const prompt = `Below are ${items.length} review comments on the same file (${filePath}).
You must decide which comments describe the EXACT SAME underlying problem.

${summaries}

GROUPING RULES (be conservative — wrong merges cause missed fixes):
- Only group comments if they point to the SAME code location AND fix the SAME specific problem.
- Comments on DIFFERENT lines, DIFFERENT functions, or that require DIFFERENT fixes must NOT be grouped.
- "Related" or "thematically similar" is NOT enough — they must be describing the same bug/issue.
- When in doubt, do NOT group.

For each group of true duplicates, pick the most detailed comment as canonical.

Reply ONLY with lines like (one per group, no other text):
GROUP: 2,5,7 → canonical 5
GROUP: 1,3 → canonical 3

If no comments are duplicates, reply: NONE`;
    try {
      // Always use cheap model for dedup — fast and sufficient; avoids slow default (e.g. qwen-3-14b on ElizaCloud).
      const response = await llm.completeWithCheapModel(prompt);
      const content = response.content.trim();
      if (content.toUpperCase().includes('NONE')) {
        return { filePath, groups: [], error: undefined };
      }
      const groups: DedupTaskResult['groups'] = [];
      const groupPattern = /GROUP:\s*([\d,\s]+)\s*→\s*canonical\s*(\d+)/gi;
      let match;
      while ((match = groupPattern.exec(content)) !== null) {
        const indices = match[1].split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < items.length);
        const canonicalIdx = parseInt(match[2], 10) - 1;
        if (canonicalIdx < 0 || canonicalIdx >= items.length) continue;
        if (indices.length < 2) continue;
        const canonical = items[canonicalIdx];
        const dupes = indices.filter(i => i !== canonicalIdx).map(i => items[i]);
        groups.push({ canonical, dupes });
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

    if (startLine === null) {
      // No anchors: return first 50 lines
      return lines.slice(0, 50).join('\n');
    }

    // Use union of anchors for range when we have body-derived refs
    const minAnchor = anchors.size > 0 ? Math.min(...anchors) : startLine;
    const maxAnchor = anchors.size > 0 ? Math.max(...anchors) : (endLine ?? startLine);

    let start = Math.max(0, minAnchor - CODE_SNIPPET_CONTEXT_BEFORE - 1);
    let end = Math.min(lines.length, maxAnchor + CODE_SNIPPET_CONTEXT_AFTER);

    if (end - start > MAX_SNIPPET_LINES) {
      // WHY cap: A comment referencing "lines 1 to 400" plus 20/30 context would request 450 lines.
      // Multiple refs can push the range past 500. Capping and centering keeps the prompt bounded
      // while still including the anchor range so the fixer sees the relevant code.
      const center = Math.floor((minAnchor + maxAnchor) / 2);
      const half = Math.floor(MAX_SNIPPET_LINES / 2);
      start = Math.max(0, center - half - 1);
      end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
    }

    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '(file not found or unreadable)';
  }
}

/** Max size for full-file content in final audit (avoid huge prompts / context overflow). */
const MAX_FULL_FILE_AUDIT_CHARS = 50_000;

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
  getModelsForRunner: (runner: Runner) => string[]
): Promise<{
  unresolved: UnresolvedIssue[];
  recommendedModels?: string[];
  recommendedModelIndex: number;
  modelRecommendationReasoning?: string;
  duplicateMap: Map<string, string[]>;
}> {
  const unresolved: UnresolvedIssue[] = [];
  let alreadyResolved = 0;
  let skippedCache = 0;
  let staleRecheck = 0;
  let dismissedStaleFiles = 0;
  let dismissedExhausted = 0;
  let dismissedChronicFailure = 0;
  let dismissedNotAnIssue = 0;
  let dismissedPlaceholder = 0;

  // Verification expiry: re-check issues verified more than 5 iterations ago
  const staleVerifications = Verification.getStaleVerifications(stateContext, VERIFICATION_EXPIRY_ITERATIONS);
  
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
  }> = [];

  // Phase 1: Sync filtering (verified, solvability)
  const needSnippets: Array<{
    comment: ReviewComment;
    snippetLine: number | null;
    contextHints?: string[];
  }> = [];

  for (const comment of comments) {
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

    // Deterministic solvability check (zero LLM cost)
    const solvability = assessSolvability(workdir, comment, stateContext);
    if (!solvability.solvable) {
      // CRITICAL: dismissIssue ONLY — do NOT call markVerified.
      // If the file comes back (revert, re-add), we want to re-analyze it.
      Dismissed.dismissIssue(
        stateContext,
        comment.id,
        solvability.reason!,
        solvability.dismissCategory!,
        comment.path,
        comment.line,
        comment.body,
        solvability.remediationHint
      );
      if (solvability.dismissCategory === 'stale') {
        dismissedStaleFiles++;
      } else if (solvability.dismissCategory === 'exhausted') {
        dismissedExhausted++;
      } else if (solvability.dismissCategory === 'chronic-failure') {
        dismissedChronicFailure++;
      } else if (solvability.dismissCategory === 'not-an-issue') {
        dismissedNotAnIssue++;
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
    needSnippets.push({ comment, snippetLine, contextHints });
  }

  // Phase 2: Batch-fetch all code snippets concurrently
  // WHY parallel: Each snippet is an independent file read. With 30+ comments
  // surviving the solvability filter, sequential reads add ~1-2s of I/O latency.
  const snippetResults = await Promise.all(
    needSnippets.map(async ({ comment, snippetLine, contextHints }) => {
      const codeSnippet = await getCodeSnippetFn(comment.path, snippetLine, comment.body);
      return { comment, codeSnippet, contextHints };
    })
  );

  // Phase 3: Post-filter placeholder results
  for (const { comment, codeSnippet, contextHints } of snippetResults) {
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

    toCheck.push({ comment, codeSnippet, contextHints });
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

  // ── Dedup cache: skip LLM dedup when comment set is unchanged ─────────
  // HISTORY: Heuristic dedup is CPU-only (cheap), but LLM dedup costs tokens.
  // Dedup results are deterministic given the same set of comment IDs — if no
  // new comments appeared and no comments were removed, the dedup outcome is
  // identical. We persist the cache in state so it survives across runs.
  const sortedCommentIds = toCheck.map(item => item.comment.id).sort().join(',');
  const persisted = stateContext.state?.dedupCache;
  // WHY Array.isArray: Ensures persisted shape is valid (dedupedIds is an array); avoids using stale/malformed cache.
  const dedupCacheHit = persisted?.commentIds === sortedCommentIds && Array.isArray(persisted.dedupedIds);

  let dedupResult: DedupResult;

  if (dedupCacheHit && persisted) {
    // Reuse persisted dedup — rebuild dedupedToCheck and duplicateItems from state
    const dedupedIdSet = new Set(persisted.dedupedIds);
    const dedupedItems = toCheck.filter(item => dedupedIdSet.has(item.comment.id));
    const duplicateMap = new Map<string, string[]>(Object.entries(persisted.duplicateMap));
    const toCheckById = new Map(toCheck.map(item => [item.comment.id, item]));
    const reconstructedDuplicateItems = new Map<string, typeof toCheck[0]>();
    for (const dupeIds of duplicateMap.values()) {
      for (const dupeId of dupeIds) {
        const item = toCheckById.get(dupeId);
        if (item) reconstructedDuplicateItems.set(dupeId, item);
      }
    }
    dedupResult = {
      dedupedToCheck: dedupedItems,
      duplicateMap,
      duplicateItems: reconstructedDuplicateItems,
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

    // Persist dedup results so next run (or next iteration) can skip LLM when comment set unchanged.
    // WHY: Dedup is deterministic for the same comment IDs; state is saved by the orchestrator so cache survives across runs.
    if (stateContext.state) {
      stateContext.state.dedupCache = {
        commentIds: sortedCommentIds,
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
      });
    } else if (validStatus && validStatus.status === 'resolved') {
      // Resolved but not in verifiedFixed (stale dismissal) — re-dismiss preserving existing category
      const existing = Dismissed.getDismissedIssue(stateContext, item.comment.id);
      if (existing) {
        Dismissed.dismissIssue(stateContext, item.comment.id, existing.reason, existing.category,
          item.comment.path, item.comment.line, item.comment.body, existing.remediationHint);
      } else {
        Dismissed.dismissIssue(stateContext, item.comment.id, validStatus.explanation,
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
  const totalDismissed = dismissedStaleFiles + dismissedExhausted + dismissedChronicFailure + dismissedNotAnIssue + dismissedPlaceholder;
  if (totalDismissed > 0) {
    const parts: string[] = [];
    if (dismissedStaleFiles > 0) parts.push(`${dismissedStaleFiles} stale file(s)`);
    if (dismissedExhausted > 0) parts.push(`${dismissedExhausted} exhausted attempt(s)`);
    if (dismissedChronicFailure > 0) parts.push(`${dismissedChronicFailure} chronic failure(s)`);
    if (dismissedNotAnIssue > 0) parts.push(`${dismissedNotAnIssue} lockfile/not-an-issue`);
    if (dismissedPlaceholder > 0) parts.push(`${dismissedPlaceholder} unreadable file(s)`);
    console.log(chalk.gray(`  DISMISSED: ${totalDismissed} issue(s) removed from queue (${parts.join(', ')})`));
    if (dismissedChronicFailure > 0) {
      console.log(chalk.cyan(`  ↳ ${dismissedChronicFailure} chronic-failure dismissal(s) — token-saving (no LLM retries)`));
    }
  }

  if (options.reverify && skippedCache > 0) {
    console.log(chalk.yellow(`  --reverify: Re-checking ${skippedCache} previously cached as "fixed"`));
  } else if (alreadyResolved > 0) {
    console.log(chalk.gray(`  ${alreadyResolved} already verified as fixed (cached)`));
  }
  
  if (staleRecheck > 0) {
    console.log(chalk.yellow(`  ${staleRecheck} stale verifications (>${VERIFICATION_EXPIRY_ITERATIONS} iterations old) - re-checking`));
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
      const { comment, codeSnippet, contextHints } = freshToAnalyze[i];
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
          });
        }
      }
    }
  } else {
    // Batch mode - one LLM call for all comments
    console.log(chalk.gray(`  Batch analyzing ${formatNumber(freshToAnalyze.length)} comments with LLM...`));
    
    const batchInput = freshToAnalyze.map((item, index) => {
      const issueId = `issue_${index + 1}`;
      return {
        id: issueId,
        comment: sanitizeCommentForPrompt(item.comment.body),
        filePath: item.comment.path,
        line: item.comment.line,
        codeSnippet: item.codeSnippet,
        contextHints: item.contextHints,
      };
    });

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

    const results = batchResult.issues;
    debug('Batch analysis results', { count: results.size });

    // Store model recommendation for use in fix loop
    if (batchResult.recommendedModels?.length) {
      recommendedModels = batchResult.recommendedModels;
      recommendedModelIndex = 0;
      modelRecommendationReasoning = batchResult.modelRecommendationReasoning;
      console.log(chalk.cyan(`  📊 Model recommendation: ${recommendedModels.join(', ')}`));
      if (modelRecommendationReasoning) {
        console.log(chalk.gray(`     (${modelRecommendationReasoning})`));
      }
    }

    // Process results
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const { comment, codeSnippet, contextHints } = freshToAnalyze[i];
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
        });
        continue;
      }

      // Post-STALE grep: if LLM said STALE and named a symbol, check if that symbol is still in the file
      let effectiveResult = result;
      if (result.stale) {
        const symbols = extractSymbolsFromStaleExplanation(result.explanation);
        for (const sym of symbols) {
          if (await fileContainsSymbol(workdir, comment.path, sym)) {
            debug(`Post-STALE grep: "${sym}" found in ${comment.path}, overriding STALE→YES`);
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
  
  return {
    unresolved,
    recommendedModels,
    recommendedModelIndex,
    modelRecommendationReasoning,
    duplicateMap: dedupResult.duplicateMap,
  };
}
