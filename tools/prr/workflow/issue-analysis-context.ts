/**
 * Ordering / conservative analysis snippets and post-STALE symbol checks.
 * Extracted from issue-analysis.ts (structural refactor).
 */
import { join } from 'path';
import { readFile } from 'fs/promises';
import {
  buildNumberedFullFileSnippet,
  buildWindowedSnippet,
  escapeRegExpForSnippet,
} from './issue-analysis-snippet-helpers.js';
import { buildLifecycleAwareVerificationSnippet, commentNeedsLifecycleContext } from './fix-verification.js';

export function extractSymbolsFromStaleExplanation(explanation: string): string[] {
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
export async function fileContainsSymbol(workdir: string, filePath: string, symbol: string): Promise<boolean> {
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

export function buildConservativeAnalysisSnippet(
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
