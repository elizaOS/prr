/**
 * Issue analysis and code snippet extraction functions
 */

import chalk from 'chalk';
import { createHash } from 'crypto';
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
import { VERIFICATION_EXPIRY_ITERATIONS } from '../constants.js';
import { validateDismissalExplanation } from './utils.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, warn } from '../logger.js';
import { assessSolvability, SNIPPET_PLACEHOLDER } from './helpers/solvability.js';
import { sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// File hashing for comment status invalidation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Compute a fast content hash for a file (for status invalidation). */
async function hashFileContent(workdir: string, filePath: string): Promise<string> {
  try {
    const content = await readFile(join(workdir, filePath), 'utf-8');
    return createHash('sha1').update(content).digest('hex').slice(0, 12);
  } catch {
    // File doesn't exist or unreadable — return a sentinel so status always invalidates
    return '__missing__';
  }
}

/** Module-level dedup cache (in-memory, session-scoped — not persisted). */
const _dedupCache: {
  commentIds?: string;
  result?: {
    duplicateMap: Map<string, string[]>;
    dedupedIds: Set<string>;
  };
} = {};

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
  console.log(chalk.gray(`\nDuplicate candidates: ${candidateGroups.length} group(s), ${totalComments} comments total`));
  
  // Use the shared idToDisplayNum map so "#7" means the same comment here
  // and in the dedup verdict log. Numbers come from toCheck array position
  // (1-indexed), so they're stable regardless of how groups are ordered.
  for (const group of candidateGroups) {
    const authorInfo = group.sameAuthor 
      ? `same author: ${[...group.authors][0]}`
      : 'different authors';
    
    console.log(chalk.gray(`  ${group.file}:${group.lineRange} (${group.items.length} comments, ${authorInfo})`));
    
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
      `  Dedup: ${duplicateMap.size} group(s) merged ` +
      `(${totalDupes + duplicateMap.size} comments -> ${duplicateMap.size} canonical)`
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

  // Only process files with 3+ remaining issues — high chance of semantic overlap
  const filesToCheck = [...byFile.entries()].filter(([, items]) => items.length >= 3);
  if (filesToCheck.length === 0) return dedupResult;

  debug(`LLM dedup: checking ${filesToCheck.length} file(s) with 3+ issues`);

  const newDuplicateMap = new Map(dedupResult.duplicateMap);
  const newDuplicateItems = new Map(dedupResult.duplicateItems);
  const newDuplicateIds = new Set<string>();

  for (const [filePath, items] of filesToCheck) {
    // Include enough of each comment for the LLM to detect true duplicates.
    // 150 chars was barely a title — bot comments need ~500 chars to capture
    // the core issue description (before examples and suggestions).
    const summaries = items.map((item, idx) => {
      const line = item.comment.line !== null ? `:${item.comment.line}` : '';
      const preview = sanitizeCommentForPrompt(item.comment.body).substring(0, 500).replace(/\n/g, ' ');
      return `[${idx + 1}] ${item.comment.author}${line}: ${preview}`;
    }).join('\n');

    const prompt = `Below are ${items.length} review comments on the same file (${filePath}).
Some may describe the SAME underlying problem from different angles.

${summaries}

Which comments describe the SAME underlying issue? Group them.
For each group, pick the most detailed comment as canonical.

Reply ONLY with lines like:
GROUP: 2,5,7 → canonical 5
GROUP: 1,3 → canonical 3

If no comments are duplicates, reply: NONE`;

    try {
      // Use the LLM client's default model (configured at init, typically haiku/sonnet).
      // WHY no override: 'fast' is not a valid Anthropic model name and causes 404s.
      // The default model is already appropriate for this lightweight dedup task.
      const response = await llm.complete(prompt);
      const content = response.content.trim();

      if (content.toUpperCase().includes('NONE')) continue;

      // Parse GROUP lines
      const groupPattern = /GROUP:\s*([\d,\s]+)\s*→\s*canonical\s*(\d+)/gi;
      let match;
      while ((match = groupPattern.exec(content)) !== null) {
        const indices = match[1].split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < items.length);
        const canonicalIdx = parseInt(match[2], 10) - 1;
        if (canonicalIdx < 0 || canonicalIdx >= items.length) continue;
        if (indices.length < 2) continue;

        const canonical = items[canonicalIdx];
        const dupes = indices.filter(i => i !== canonicalIdx).map(i => items[i]);

        // Merge into dedup result
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
    } catch (err) {
      debug(`LLM dedup failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      // Non-fatal — fall back to heuristic-only results
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

    // Determine the relevant line range.
    //
    // WHY prefer comment.line over LOCATIONS: The `line` parameter comes from
    // the GitHub review comment API — it's where the reviewer actually placed
    // the comment in the diff. LOCATIONS tags are embedded in bot comment HTML
    // and often point to a *related* but different part of the file (e.g. a
    // class definition when the comment is about a method). Using LOCATIONS
    // when we already have a precise line led to returning completely wrong
    // code snippets (e.g. showing getTokenPair for an API-key-reset issue).
    //
    // Only fall back to LOCATIONS when no line was attached to the comment.
    let startLine = line;
    let endLine = line;
    
    if (startLine === null && commentBody) {
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
  let dismissedPlaceholder = 0;

  // Verification expiry: re-check issues verified more than 5 iterations ago
  const staleVerifications = Verification.getStaleVerifications(stateContext, VERIFICATION_EXPIRY_ITERATIONS);
  
  // First pass: filter out already-verified issues and gather code snippets
  const toCheck: Array<{
    comment: ReviewComment;
    codeSnippet: string;
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

    // Phase 1: Deterministic solvability check (zero LLM cost)
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
        comment.body
      );
      if (solvability.dismissCategory === 'stale') {
        dismissedStaleFiles++;
      } else if (solvability.dismissCategory === 'exhausted') {
        dismissedExhausted++;
      }
      continue;
    }

    // Fetch snippet using retargeted line if available
    const snippetLine = solvability.retargetedLine ?? comment.line;
    const codeSnippet = await getCodeSnippetFn(comment.path, snippetLine, comment.body);

    // Belt-and-suspenders: catch placeholder after fetch (race or permission issue)
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

    toCheck.push({ comment, codeSnippet, contextHints: solvability.contextHints });
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
  // identical. We cache the result in-memory and reuse when the set matches.
  const sortedCommentIds = toCheck.map(item => item.comment.id).sort().join(',');
  const dedupCacheHit = _dedupCache.commentIds === sortedCommentIds && _dedupCache.result;

  let dedupResult: DedupResult;

  if (dedupCacheHit) {
    // Reuse cached dedup — rebuild dedupedToCheck from cached IDs + current toCheck items
    const cachedDedup = _dedupCache.result!;
    const dedupedItems = toCheck.filter(item => cachedDedup.dedupedIds.has(item.comment.id));
    const toCheckById = new Map(toCheck.map(item => [item.comment.id, item]));
    const reconstructedDuplicateItems = new Map<string, typeof toCheck[0]>();
    for (const dupeIds of cachedDedup.duplicateMap.values()) {
      for (const dupeId of dupeIds) {
        const item = toCheckById.get(dupeId);
        if (item) reconstructedDuplicateItems.set(dupeId, item);
      }
    }
    dedupResult = {
      dedupedToCheck: dedupedItems,
      duplicateMap: cachedDedup.duplicateMap,
      duplicateItems: reconstructedDuplicateItems,
    };
    console.log(chalk.gray(`  Dedup results reused (comment set unchanged, ${dedupResult.duplicateMap.size} canonical groups)`));
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
    // Only runs when files have 3+ remaining issues — lightweight, typically <2k tokens
    try {
      dedupResult = await llmDedup(dedupResult, toCheck, llm);
    } catch (err) {
      warn(`LLM dedup failed, proceeding with heuristic-only results: ${err}`);
    }

    // Cache dedup results for next iteration (in-memory only)
    _dedupCache.commentIds = sortedCommentIds;
    _dedupCache.result = {
      duplicateMap: dedupResult.duplicateMap,
      dedupedIds: new Set(dedupResult.dedupedToCheck.map(item => item.comment.id)),
    };
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
      // Resolved but not in verifiedFixed (stale dismissal) — re-dismiss
      Dismissed.dismissIssue(stateContext, item.comment.id, validStatus.explanation,
        validStatus.classification === 'stale' ? 'stale' : 'already-fixed',
        item.comment.path, item.comment.line, item.comment.body);
      statusHits++;
    } else {
      // No valid status: new comment, or file changed → need fresh LLM analysis
      freshToAnalyze.push(item);
    }
  }

  // Report solvability dismissals
  const totalDismissed = dismissedStaleFiles + dismissedExhausted + dismissedPlaceholder;
  if (totalDismissed > 0) {
    const parts: string[] = [];
    if (dismissedStaleFiles > 0) parts.push(`${dismissedStaleFiles} stale file(s)`);
    if (dismissedExhausted > 0) parts.push(`${dismissedExhausted} exhausted attempt(s)`);
    if (dismissedPlaceholder > 0) parts.push(`${dismissedPlaceholder} unreadable file(s)`);
    console.log(chalk.gray(`  ${totalDismissed} issue(s) dismissed as unsolvable (${parts.join(', ')})`));
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
    console.log(chalk.gray(`  ${statusHits} comment(s) skipped (status unchanged — open issues on unmodified files)`));
  }
  if (freshToAnalyze.length > 0 && statusHits > 0) {
    console.log(chalk.gray(`  ${freshToAnalyze.length} comment(s) need fresh LLM analysis (new or file changed)`));
  }

  if (freshToAnalyze.length === 0) {
    // All items served from persisted status — no LLM call needed
    if (statusHits > 0 && toAnalyze.length > 0) {
      console.log(chalk.green(`  ✓ All ${statusHits} issue(s) served from persisted status — skipping LLM analysis`));
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
    console.log(chalk.gray(`  Analyzing ${freshToAnalyze.length} comments sequentially...`));
    
    for (let i = 0; i < freshToAnalyze.length; i++) {
      const { comment, codeSnippet, contextHints } = freshToAnalyze[i];
      console.log(chalk.gray(`    [${i + 1}/${freshToAnalyze.length}] ${comment.path}:${comment.line || '?'}`));
      
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
    console.log(chalk.gray(`  Batch analyzing ${freshToAnalyze.length} comments with LLM...`));
    
    const batchInput = freshToAnalyze.map((item, index) => {
      const issueId = `issue_${index + 1}`;
      return {
        id: issueId,
        comment: item.comment.body,
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

    const batchResult = await llm.batchCheckIssuesExist(
      batchInput, 
      modelContext,
      options.maxContextChars
    );
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

      // Persist comment status
      const fHash = fileHashes.get(comment.path) || '__missing__';
      if (result.stale) {
        CommentStatusAPI.markResolved(stateContext, comment.id, 'stale', result.explanation, comment.path, fHash);
      } else if (result.exists) {
        CommentStatusAPI.markOpen(stateContext, comment.id, 'exists', result.explanation, result.importance ?? 3, result.ease ?? 3, comment.path, fHash);
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
            triage: { importance: result.importance, ease: result.ease },
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
          triage: { importance: result.importance, ease: result.ease },
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
            triage: { importance: result.importance, ease: result.ease },
            mergedDuplicates: mergedDuplicates && mergedDuplicates.length > 0 ? mergedDuplicates : undefined,
          });
        }
      }
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
