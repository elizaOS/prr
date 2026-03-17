/**
 * Fix verification: after the fixer runs, confirm which issues were actually fixed.
 *
 * WHY verify at all: Fixers can claim "fixed" but miss the issue or change the
 * wrong thing. We send the fixer output and code snippet to the LLM and ask
 * "does this code now address the concern?" — only then do we mark verified.
 * WHY batch verify: One LLM call can check many issues at once (e.g. 50) with
 * a structured prompt; we fall back to spot-check then full batch to avoid
 * trusting a single "all fixed" claim without sampling.
 */

import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'fs/promises';
import { getIssuePrimaryPath, type UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateContext } from '../state/state-context.js';
import { setPhase, getState } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import { isInfrastructureFailure } from './helpers/recovery.js';
import { isEmptyDiffVerdict } from './utils.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, debugStep, startTimer, endTimer, setTokenPhase, formatDuration, formatNumber, pluralize } from '../../../shared/logger.js';
import { VERIFIER_FEEDBACK_HISTORY_MAX } from '../../../shared/constants.js';
import { getChangedFiles, getDiffForFile, detectFileCorruption, filterUnifiedDiffByLineRange } from '../../../shared/git/git-clone-index.js';
import { basename, dirname, extname, join } from 'path';
import { VERIFIER_ESCALATION_THRESHOLD, AUTO_VERIFY_PATTERN_ABSENT_THRESHOLD, FILE_UNCHANGED_DISMISS_THRESHOLD } from '../../../shared/constants.js';

/** True when verifier explanation says the file must be deleted (not just emptied). Cycle 13 M2. */
function isDeleteEntirelyVerdict(explanation: string): boolean {
  return (
    /delete (?:the )?file entirely|remove (?:the )?file (?:from the repo)?|file (?:must be |needs to be )?deleted|git rm|should be (?:completely )?removed|delete (?:those?|these?|stray) files?/i.test(explanation) ||
    /(?:stray|garbage) file.*(?:delete|remove)/i.test(explanation)
  );
}

import { isModelProviderCompatible, getModelsForRunner } from '../models/rotation.js';
import type { Runner } from '../../../shared/runners/types.js';

/** Deterministic verifier strength order (strongest first). Used for escalation so we pick a capable model, not the current fixer model. */
const VERIFIER_STRENGTH_ORDER = [
  'anthropic/claude-opus-4.5',
  'anthropic/claude-opus-4-5',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-sonnet-4-5-20250929',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'alibaba/qwen-3-14b',
  'Qwen/Qwen3-14B',
];

function getStrongerVerifierModel(runner: Runner, preferredVerifierModel: string | undefined, currentModel: string | undefined): string | undefined {
  if (preferredVerifierModel && isModelProviderCompatible(runner, preferredVerifierModel)) return preferredVerifierModel;
  const available = new Set(getModelsForRunner(runner));
  for (const model of VERIFIER_STRENGTH_ORDER) {
    if (available.has(model) && isModelProviderCompatible(runner, model)) return model;
  }
  return currentModel && isModelProviderCompatible(runner, currentModel) ? currentModel : undefined;
}

/**
 * True when the review comment describes an API/signature or caller mismatch.
 * WHY: Prompts.log audit showed the default verifier (e.g. qwen-3-14b) approved a fix that made generate_report async and added a required argument, but missed that print_results still called it without await/args. Weak verifiers are more likely to miss call-site bugs; we verify these fixes with a stronger model when available.
 */
function commentMentionsApiOrSignature(fix: { comment: string }): boolean {
  const c = fix.comment.toLowerCase();
  return (
    /\b(?:async|await)\b/.test(c) ||
    /\b(?:signature|typeerror|argument\s+mismatch|caller|calls?\s+)/.test(c) ||
    /\b(?:def\s+\w+\s*\(|method\s+(?:accepts|takes)\s+(?:no\s+)?arguments?)/.test(c) ||
    /\.(?:py|ts|js):\d+.*call/i.test(c)
  );
}

/**
 * True when the review comment is about cache/state lifecycle behavior rather than
 * a single local line. These issues need broader verification context so the model
 * can inspect creation, replacement, pruning, and cleanup paths together.
 * Cycle 27: Added reply/action-state patterns so judge gets lifecycle-aware snippet
 * (avoids STALE when "truncated code doesn't show enough of the reply action handler").
 */
export function commentNeedsLifecycleContext(fix: { comment: string }): boolean {
  const c = fix.comment.toLowerCase();
  return (
    /\bmemory leak\b/.test(c) ||
    /\b(?:potential )?leak\b/.test(c) ||
    /\bgrows?\s+unbounded/i.test(c) ||
    /\bnever\s+(?:cleared|cleaned|pruned|deleted|evicted|removed)\b/.test(c) ||
    /\b(?:cleanup|clean up|prune|evict|ttl|lru)\b/.test(c) ||
    /\b(?:stale|orphaned|dangling)\s+(?:entry|entries|state|map|set|cache)\b/.test(c) ||
    /\b(?:map|set|weakmap|weakset|cache)\s+potential\s+(?:memory\s+)?leak\b/.test(c) ||
    /\bhasrequestedinstate\b/.test(c) ||
    /\brecent_messages\b/.test(c) ||
    /\baction_state\b/.test(c) ||
    /\breply\s+(?:action\s+)?handler\b/.test(c)
  );
}

/**
 * Extract likely bug-indicating code from the review comment (backtick blocks or
 * common patterns like enumerate(), range()). If any such pattern appears in the
 * comment but NONE appear in currentCode, the bug may be fixed and the verifier
 * is matching the review text instead of the code (audit: reporting.py enumerate).
 */
function bugPatternAbsentInCode(commentBody: string, currentCode: string): boolean {
  const patterns: string[] = [];
  // Inline code in backticks
  const inlineBacktick = /`([^`\n]{2,80})`/g;
  let m;
  while ((m = inlineBacktick.exec(commentBody)) !== null) {
    const t = m[1].trim();
    if (t.length >= 2 && !/^(the|use|e\.g|i\.e|see|add|fix|change|should|don't|doesn't)$/i.test(t)) {
      patterns.push(t);
    }
  }
  // Common bug indicators mentioned in reviews (e.g. "use enumerate instead of range")
  const bugKeywords = ['enumerate(', 'range(', '.index(', 'for i in range', 'for (let i = 0', 'indexOf('];
  for (const kw of bugKeywords) {
    if (commentBody.includes(kw)) patterns.push(kw);
  }
  if (patterns.length === 0) return false;
  const codeNorm = currentCode.replace(/\s+/g, ' ');
  for (const p of patterns) {
    if (codeNorm.includes(p.replace(/\s+/g, ' '))) return false;
  }
  return true;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeLineRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
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

function extractCandidateSymbols(commentBody: string, anchorLine: string | undefined): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    if (!/^[A-Za-z_$][\w$]{2,}$/.test(value)) return;
    if (/^(Map|Set|WeakMap|WeakSet|LRU|TTL|code|file|line|memory|cache|cleanup|comment)$/i.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    symbols.push(value);
  };

  const backtick = /`([A-Za-z_$][\w$]{2,})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtick.exec(commentBody)) !== null) {
    add(match[1]);
  }

  const declared = anchorLine?.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
  add(declared?.[1]);

  return symbols;
}

/**
 * Build a lifecycle-aware verification snippet that includes the tracked symbol's
 * declaration plus its key read/write/cleanup sites across the file.
 */
export function buildLifecycleAwareVerificationSnippet(
  content: string,
  filePath: string,
  line: number | null,
  commentBody: string
): string | null {
  const lines = content.split('\n');
  const anchorLine = line != null && line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
  const candidates = extractCandidateSymbols(commentBody, anchorLine);
  if (candidates.length === 0) return null;

  let bestSymbol: string | null = null;
  let bestOccurrences: number[] = [];
  for (const symbol of candidates) {
    const rx = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const occurrences: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i]!)) occurrences.push(i + 1);
    }
    if (occurrences.length > bestOccurrences.length) {
      bestSymbol = symbol;
      bestOccurrences = occurrences;
    }
  }
  if (!bestSymbol || bestOccurrences.length < 2) return null;

  const ranges: Array<{ start: number; end: number }> = [];
  if (line != null) {
    ranges.push({
      start: Math.max(1, line - 12),
      end: Math.min(lines.length, line + 20),
    });
  }
  for (const occurrence of bestOccurrences) {
    ranges.push({
      start: Math.max(1, occurrence - 4),
      end: Math.min(lines.length, occurrence + 6),
    });
  }

  const merged = mergeLineRanges(ranges);
  const parts = [
    `Lifecycle excerpts for \`${bestSymbol}\` in ${filePath} (declaration + usage/cleanup sites):`,
    '',
  ];
  const maxChars = 7000;
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
    parts.push(`... (${merged.length - included} additional lifecycle section(s) omitted; file has ${lines.length} lines total)`);
  } else {
    parts.push(`(full lifecycle excerpt set shown; file has ${lines.length} lines total)`);
  }
  return parts.join('\n');
}

/**
 * Find changed files that relate to an issue's target path.
 *
 * Returns the target itself (if changed) PLUS any test/spec files that correspond
 * to it. This solves the long-standing problem where "add tests for route.ts"
 * creates `route.test.ts` but verification only checks if `route.ts` was modified.
 *
 * Test file patterns matched:
 *   foo/bar.ts  →  foo/bar.test.ts, foo/bar.spec.ts
 *   foo/bar.ts  →  foo/__tests__/bar.ts, foo/__tests__/bar.test.ts, foo/__tests__/bar.spec.ts
 *   foo/bar.ts  →  __tests__/foo/bar.ts, __tests__/.../bar.test.ts  (any __tests__ ancestor)
 */
function findRelatedChangedFiles(targetPath: string, changedFiles: string[]): string[] {
  const related: string[] = [];

  const dir = dirname(targetPath);                     // app/api/auth/siwe/verify
  const ext = extname(targetPath);                     // .ts
  const base = basename(targetPath, ext);              // route
  const baseLower = base.toLowerCase();

  // For Next.js route handlers (route.ts, page.tsx, layout.tsx, etc.), the
  // meaningful name is the DIRECTORY, not the file. Tests for
  // app/api/auth/siwe/verify/route.ts are typically named verify.test.ts,
  // not route.test.ts.
  //
  // HISTORY: Originally only matched on basename ("route"), which missed
  // test files named after the directory ("verify.test.ts"). This caused
  // iteration 4 to create verify.test.ts and nonce.test.ts but verification
  // saw 0 matches → "0 issues fixed". Now we also match on the parent
  // directory name for these conventional filenames.
  const NEXTJS_CONVENTIONAL_NAMES = new Set(['route', 'page', 'layout', 'loading', 'error', 'not-found', 'template', 'default', 'middleware', 'index']);
  const dirName = basename(dir);                       // verify
  const dirNameLower = dirName.toLowerCase();
  const useDirectoryName = NEXTJS_CONVENTIONAL_NAMES.has(baseLower);

  // Extensions that are plausible test files for the target
  const testExts = new Set([ext, '.ts', '.tsx', '.js', '.jsx'].map(e => e.toLowerCase()));

  /** Check if a test file basename matches our target (by file name or directory name) */
  const matchesTarget = (fBaseLower: string): boolean => {
    // Match on the actual file basename: route.test, route.spec
    if (fBaseLower === `${baseLower}.test` || fBaseLower === `${baseLower}.spec`) return true;
    if (fBaseLower === baseLower) return true;
    // For Next.js conventional names, also match on directory name: verify.test, verify.spec
    if (useDirectoryName) {
      if (fBaseLower === `${dirNameLower}.test` || fBaseLower === `${dirNameLower}.spec`) return true;
      if (fBaseLower === dirNameLower) return true;
    }
    return false;
  };

  for (const file of changedFiles) {
    // Direct match: the target file itself
    if (file === targetPath) {
      related.push(file);
      continue;
    }

    const fDir = dirname(file);
    const fExt = extname(file);
    const fBase = basename(file, fExt);
    const fBaseLower = fBase.toLowerCase();

    if (!testExts.has(fExt.toLowerCase())) continue;

    // Pattern 1: sibling test file — foo/bar.test.ts, foo/bar.spec.ts
    if (fDir === dir && matchesTarget(fBaseLower)) {
      related.push(file);
      continue;
    }

    // Pattern 2: __tests__ subdirectory — foo/__tests__/bar.ts, foo/__tests__/bar.test.ts
    if (fDir === `${dir}/__tests__` && matchesTarget(fBaseLower)) {
      related.push(file);
      continue;
    }

    // Pattern 3: parent's __tests__ — foo/__tests__/verify.test.ts for foo/verify/route.ts
    if (useDirectoryName) {
      const parentDir = dirname(dir);  // app/api/auth/siwe
      if (fDir === `${parentDir}/__tests__` && matchesTarget(fBaseLower)) {
        related.push(file);
        continue;
      }
    }

    // Pattern 4: root-relative __tests__ — __tests__/foo/bar.ts, __tests__/.../bar.test.ts
    // Match any file under a __tests__ directory whose base name matches
    if ((file.includes('__tests__/') || file.includes('__test__/')) && matchesTarget(fBaseLower)) {
      related.push(file);
      continue;
    }
  }

  return related;
}

/**
 * Read the current code around an issue's specific line(s) AFTER the fixer has run.
 *
 * WHY: The batch verifier receives the full file diff, but when multiple issues
 * target the same file, they all get the same diff. The verifier can't reliably
 * determine which diff hunks address which issue — especially in large diffs.
 * Including the current code at the issue's location lets the verifier check
 * whether the problematic pattern described in the review comment still exists.
 */
/** Max lines for "small file" — return full content so verifier sees whole file (avoids false negatives). */
const MAX_LINES_FULL_FILE_VERIFY = 200;
/**
 * For type/signature issues, verifier needs a larger window to see function bodies and call sites.
 * WHY 500 (not 200): Type/signature fixes often span the function definition plus its callers.
 * With 200 lines, the verifier said "role never assigned" or "method not found" because the
 * relevant code was outside the window. 500 covers most function bodies and immediate call sites.
 */
const MAX_LINES_FULL_FILE_VERIFY_TYPE_SIGNATURE = 500;

type CurrentCodeAtLineOptions = {
  expandForTypeSignature?: boolean;
  expandForLifecycle?: boolean;
  commentBody?: string;
};

/**
 * Get current code at (or around) the issue line for verification.
 * WHY anchor + size: Audit (prompts.log) showed verifier received first 2000 chars only; for a 204-line
 * file the models array at line 169 was never seen, so verifier wrongly said "still present". We now
 * return full file when small, or a larger anchored window (30/70 lines), and client uses 8k char limit.
 * When expandForTypeSignature, return full file up to MAX_LINES_FULL_FILE_VERIFY_TYPE_SIGNATURE so verifier
 * can see function body and call sites (avoids false "role never assigned" etc.).
 */
async function getCurrentCodeAtLine(
  workdir: string,
  filePath: string,
  line: number | null,
  options?: CurrentCodeAtLineOptions
): Promise<string> {
  try {
    const fullPath = join(workdir, filePath);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const expandForTypeSignature = options?.expandForTypeSignature === true;
    const expandForLifecycle = options?.expandForLifecycle === true;

    const fullFileLimit = expandForTypeSignature ? MAX_LINES_FULL_FILE_VERIFY_TYPE_SIGNATURE : MAX_LINES_FULL_FILE_VERIFY;
    if (lines.length <= fullFileLimit) {
      return lines.map((l, i) => `${i + 1}: ${l}`).join('\n')
        + `\n(end of file — ${lines.length} lines total)`;
    }

    if (expandForTypeSignature) {
      return lines
        .slice(0, fullFileLimit)
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n') + `\n... (truncated — file has ${lines.length} lines total)`;
    }

    if (expandForLifecycle && options?.commentBody) {
      const lifecycleSnippet = buildLifecycleAwareVerificationSnippet(content, filePath, line, options.commentBody);
      if (lifecycleSnippet) return lifecycleSnippet;
    }

    if (line === null) {
      return lines.slice(0, 50).map((l, i) => `${i + 1}: ${l}`).join('\n')
        + `\n... (truncated — file has ${lines.length} lines total)`;
    }

    const contextBefore = 30;
    const contextAfter = 70;
    const start = Math.max(0, line - contextBefore - 1);
    const end = Math.min(lines.length, line + contextAfter);

    const snippet = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');

    if (end >= lines.length) {
      return snippet + `\n(end of file — ${lines.length} lines total)`;
    }
    return snippet + `\n... (truncated — file has ${lines.length} lines total)`;
  } catch {
    return '(file not found or unreadable)';
  }
}

/**
 * Verify fixes after fixer completes
 * Separates changed/unchanged files, verifies changed files, records results
 */
export async function verifyFixes(
  git: SimpleGit,
  unresolvedIssues: UnresolvedIssue[],
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  verifiedThisSession: Set<string>,
  noBatch: boolean,
  duplicateMap?: Map<string, string[]>,
  workdir?: string,
  getCurrentModel?: () => string | undefined,
  getRunner?: () => Runner,
  /** Files modified in any previous push iteration this run. WHY: pill-output — iteration 2 dismissed as file-unchanged issues whose file was fixed in iteration 1. */
  filesModifiedInPreviousIterations?: Set<string>
): Promise<{
  verifiedCount: number;
  failedCount: number;
  changedIssues: UnresolvedIssue[];
  unchangedIssues: UnresolvedIssue[];
  changedFiles: string[];
}> {
  const spinner = ora();
  let verifiedCount = 0;
  let failedCount = 0;
  let autoVerifiedCount = 0;
  const unchangedIssues: typeof unresolvedIssues = [];
  const changedIssues: typeof unresolvedIssues = [];
  let changedFiles: string[] = [];

  debugStep('VERIFYING FIXES');
  setPhase(stateContext, 'verifying');
  setTokenPhase('Verify fixes');
  startTimer('Verify fixes');

  // Map from issue target path → all related changed files (target + test files).
  // WHY: When a reviewer says "add tests for route.ts", the fixer creates route.test.ts.
  // Without this mapping, verification sees "route.ts not modified" and rejects the fix.
  // With it, we send the test file's diff to the verifier so it can judge the test content.
  const relatedFilesMap = new Map<string, string[]>();

  try {
    spinner.start('Verifying fixes...');
    changedFiles = await getChangedFiles(git);
    debug('Changed files', changedFiles);
    const effectiveChangedSet = new Set(changedFiles);
    if (filesModifiedInPreviousIterations?.size) {
      for (const p of filesModifiedInPreviousIterations) effectiveChangedSet.add(p);
    }
    const effectiveChangedFiles = [...effectiveChangedSet];

    for (const issue of unresolvedIssues) {
      // WHY skip: Recovery phases (trySingleIssueFix, tryDirectLLMFix) verify
      // their own fixes inline — if successful, they call markVerified(). Without
      // this check, those same issues would be re-verified here: each a separate
      // verifyFix LLM call (or batch slot) confirming what we already know. Skipping
      // saves one verification call per issue resolved during recovery.
      // Audit: When the fixer modified this issue's file this iteration, re-verify
      // even if previously verified — cache may be stale and we must not commit without re-check.
      const primaryPath = issue.resolvedPath ?? issue.comment.path;
      if (Verification.isVerified(stateContext, issue.comment.id) && !effectiveChangedSet.has(primaryPath)) {
        debug('Skipping already-verified issue in verifyFixes', { id: issue.comment.id });
        continue;
      }

      const related = findRelatedChangedFiles(primaryPath, effectiveChangedFiles);
      if (related.length > 0) {
        relatedFilesMap.set(issue.comment.id, related);
        changedIssues.push(issue);
        if (stateContext.state) {
          stateContext.state.fileUnchangedConsecutiveCountByCommentId = stateContext.state.fileUnchangedConsecutiveCountByCommentId ?? {};
          stateContext.state.fileUnchangedConsecutiveCountByCommentId[issue.comment.id] = 0;
        }
      } else {
        const id = issue.comment.id;
        const prev = stateContext.state?.fileUnchangedConsecutiveCountByCommentId?.[id] ?? 0;
        const next = prev + 1;
        if (stateContext.state) {
          stateContext.state.fileUnchangedConsecutiveCountByCommentId = stateContext.state.fileUnchangedConsecutiveCountByCommentId ?? {};
          stateContext.state.fileUnchangedConsecutiveCountByCommentId[id] = next;
        }
        if (next >= FILE_UNCHANGED_DISMISS_THRESHOLD) unchangedIssues.push(issue);
      }
    }

    // Mark unchanged files as failed (only after threshold) and document as dismissed
    // NOTE: No validation needed here - we're providing an explicit, meaningful reason
    for (const issue of unchangedIssues) {
      const primaryPath = getIssuePrimaryPath(issue);
      Iterations.addVerificationResult(stateContext, issue.comment.id, {
        passed: false,
        reason: 'File was not modified',
      });
      Dismissed.dismissIssue(stateContext, 
        issue.comment.id,
        'File was not modified by the fixer tool, so issue could not have been addressed',
        'file-unchanged',
        primaryPath,
        issue.comment.line,
        issue.comment.body
      );
      failedCount++;
    }

    // Verify changed files
    if (changedIssues.length > 0) {
      // Cache diffs by file to avoid fetching same diff multiple times
      const diffCache = new Map<string, string>();
      
      const getDiff = async (path: string): Promise<string> => {
        const cached = diffCache.get(path);
        if (cached) {
          return cached;
        }
        const diff = await getDiffForFile(git, path) || '';
        diffCache.set(path, diff);
        return diff;
      };

      // Get combined diff for an issue — includes target file AND any related test files.
      // Prompts.log audit: when multiple fixes target the same file, filter the target file's diff by issue line so the verifier sees only relevant hunks.
      const getIssueDiff = async (issue: UnresolvedIssue): Promise<string> => {
        const primaryPath = issue.resolvedPath ?? issue.comment.path;
        const related = relatedFilesMap.get(issue.comment.id) || [primaryPath];
        const diffs: string[] = [];
        for (const file of related) {
          let d = await getDiff(file);
          if (d && file === primaryPath && issue.comment.line != null) {
            d = filterUnifiedDiffByLineRange(d, issue.comment.line);
          }
          if (d) diffs.push(d);
        }
        return diffs.join('\n');
      };

      if (noBatch) {
        // Sequential mode - one LLM call per fix
        spinner.text = `Verifying ${formatNumber(changedIssues.length)} fixes sequentially...`;
        
        for (let i = 0; i < changedIssues.length; i++) {
          const issue = changedIssues[i];
          const primaryPathSeq = issue.resolvedPath ?? issue.comment.path;
          spinner.text = `Verifying [${formatNumber(i + 1)}/${formatNumber(changedIssues.length)}] ${primaryPathSeq}:${issue.comment.line || '?'}`;
          
          try {
            const diff = await getIssueDiff(issue);
            // output.log audit: empty diff → skip verifier LLM, add lesson, treat as failed (no-changes / rotate).
            if (!diff || !diff.trim()) {
              const primaryPathEmpty = issue.resolvedPath ?? issue.comment.path;
              LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${primaryPathEmpty}:${issue.comment.line ?? '?'} - fix must produce a non-empty diff; verifier saw no file changes.`);
              Iterations.addVerificationResult(stateContext, issue.comment.id, {
                passed: false,
                reason: 'Diff was empty — no actual file changes',
              });
              failedCount++;
              continue;
            }
            // Sequential verifyFix has no model override; escalation to stronger model is done in batch path only.
            const verification = await llm.verifyFix(
              issue.comment.body,
              primaryPathSeq,
              diff
            );

            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: verification.fixed,
              reason: verification.explanation,
            });

            debug(`Verification for ${primaryPathSeq}:${issue.comment.line}`, verification);
            
            if (verification.fixed) {
              verifiedCount++;
              Verification.markVerified(stateContext, issue.comment.id);
              Iterations.addCommentToIteration(stateContext, issue.comment.id);
              verifiedThisSession.add(issue.comment.id);  // Track for session filtering
              
              // Clean up fix-attempt lessons now that the issue is resolved.
              // Keeps architectural constraints, removes "Fix for X - the diff..." debris.
              const cleaned = LessonsAPI.Cleanup.cleanupLessonsForFixedIssue(
                lessonsContext, primaryPathSeq, issue.comment.line
              );
              if (cleaned > 0) {
                debug(`Cleaned up ${cleaned} fix-attempt lesson(s) for ${primaryPathSeq}:${issue.comment.line}`);
              }
              
              // Auto-verify duplicates of this canonical issue
              if (duplicateMap) {
                const duplicates = duplicateMap.get(issue.comment.id) || [];
                for (const dupId of duplicates) {
                  if (!Verification.isVerified(stateContext, dupId)) {
                    Verification.markVerified(stateContext, dupId, issue.comment.id);
                    verifiedThisSession.add(dupId);
                    autoVerifiedCount++;
                    debug(`Auto-verified duplicate comment ${dupId} (canonical ${issue.comment.id} was fixed)`);
                  }
                }
              }
            } else {
              // output.log audit: verifier said "diff is empty" → treat as no-changes, add lesson, don't escalate.
              if (isEmptyDiffVerdict(verification.explanation)) {
                LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${primaryPathSeq}:${issue.comment.line ?? '?'} - fix must produce a non-empty diff; verifier reported no changes.`);
                failedCount++;
                continue;
              }
              const stateSeq = getState(stateContext);
              const rejectionCountSeq = (stateSeq.verifierRejectionCount?.[issue.comment.id] ?? 0) + 1;
              const currentCodeSeq = workdir
                ? await getCurrentCodeAtLine(workdir, primaryPathSeq, issue.comment.line, {
                    expandForTypeSignature: commentMentionsApiOrSignature({ comment: issue.comment.body }),
                    expandForLifecycle: commentNeedsLifecycleContext({ comment: issue.comment.body }),
                    commentBody: issue.comment.body,
                  })
                : '';
              if (
                rejectionCountSeq >= AUTO_VERIFY_PATTERN_ABSENT_THRESHOLD &&
                // WHY conservative gate: For lifecycle/cache/leak issues, a local snippet can lose
                // the creation or cleanup path that still makes the bug real. Keep these issues open
                // until the verifier explicitly sees enough lifecycle context and says they are fixed.
                !commentNeedsLifecycleContext({ comment: issue.comment.body }) &&
                currentCodeSeq &&
                currentCodeSeq !== '(file not found or unreadable)' &&
                bugPatternAbsentInCode(issue.comment.body, currentCodeSeq)
              ) {
                verifiedCount++;
                Verification.markVerified(stateContext, issue.comment.id);
                Iterations.addVerificationResult(stateContext, issue.comment.id, {
                  passed: true,
                  reason: `Auto-verified: bug pattern no longer in code after ${rejectionCountSeq} verifier rejections`,
                });
                Iterations.addCommentToIteration(stateContext, issue.comment.id);
                verifiedThisSession.add(issue.comment.id);
                const cleaned = LessonsAPI.Cleanup.cleanupLessonsForFixedIssue(
                  lessonsContext, primaryPathSeq, issue.comment.line
                );
                if (cleaned > 0) {
                  debug(`Auto-verified (pattern absent) and cleaned ${cleaned} lesson(s) for ${primaryPathSeq}:${issue.comment.line}`);
                }
              } else {
                failedCount++;
                if (!isInfrastructureFailure(verification.explanation)) {
                  issue.verifierContradiction = verification.explanation;
                  if (!issue.verifierFeedbackHistory) issue.verifierFeedbackHistory = [];
                  issue.verifierFeedbackHistory.push(verification.explanation);
                  if (issue.verifierFeedbackHistory.length > VERIFIER_FEEDBACK_HISTORY_MAX) {
                    issue.verifierFeedbackHistory = issue.verifierFeedbackHistory.slice(-VERIFIER_FEEDBACK_HISTORY_MAX);
                  }
                }
                if (!stateSeq.verifierRejectionCount) stateSeq.verifierRejectionCount = {};
                stateSeq.verifierRejectionCount[issue.comment.id] = rejectionCountSeq;
                if (isDeleteEntirelyVerdict(verification.explanation)) {
                  if (!stateSeq.deleteEntirelyVerdictCountByCommentId) stateSeq.deleteEntirelyVerdictCountByCommentId = {};
                  stateSeq.deleteEntirelyVerdictCountByCommentId[issue.comment.id] = (stateSeq.deleteEntirelyVerdictCountByCommentId[issue.comment.id] ?? 0) + 1;
                }
                if (isInfrastructureFailure(verification.explanation)) {
                  const shortReason = verification.explanation.substring(0, 120);
                  LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${primaryPathSeq}:${issue.comment.line} - infra failure: ${shortReason}`);
                } else {
                  const lesson = await llm.analyzeFailedFix(
                    {
                      comment: issue.comment.body,
                      filePath: primaryPathSeq,
                      line: issue.comment.line,
                    },
                    diff,
                    verification.explanation
                  );
                  LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${primaryPathSeq}:${issue.comment.line} - ${lesson}`);
                }
              }
            }
          } catch (err) {
            failedCount++;
            const msg = err instanceof Error ? err.message : String(err);
            debug('Verification failed for issue', { path: primaryPathSeq, line: issue.comment.line, error: msg });
            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: false,
              reason: `Verification threw: ${msg}`,
            });
          }
        }
      } else {
        // Batch mode - one LLM call for all fixes
        // Fetch diffs and current code for all issues concurrently.
        // WHY parallel: Each read is independent (different file or line). With 12+
        // issues this turns ~1-2s of sequential I/O into a single ~100ms burst.
        const fixesToVerify = await Promise.all(
          changedIssues.map(async (issue) => {
            const primaryPath = issue.resolvedPath ?? issue.comment.path;
            const [diff, currentCode] = await Promise.all([
              getIssueDiff(issue),
              workdir
                ? getCurrentCodeAtLine(workdir, primaryPath, issue.comment.line, {
                    expandForTypeSignature: commentMentionsApiOrSignature({ comment: issue.comment.body }),
                    expandForLifecycle: commentNeedsLifecycleContext({ comment: issue.comment.body }),
                    commentBody: issue.comment.body,
                  })
                : Promise.resolve(undefined),
            ]);
            return {
              id: issue.comment.id,
              comment: issue.comment.body,
              filePath: primaryPath,
              line: issue.comment.line,
              diff,
              currentCode,
            };
          })
        );

        // output.log audit: empty diff → skip verifier LLM, add lesson, treat as failed (no-changes / rotate).
        const emptyDiffIds = new Set<string>();
        for (const fix of fixesToVerify) {
          if (!fix.diff || !fix.diff.trim()) {
            emptyDiffIds.add(fix.id);
            LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${fix.filePath}:${fix.line ?? '?'} - fix must produce a non-empty diff; verifier saw no file changes.`);
            Iterations.addVerificationResult(stateContext, fix.id, {
              passed: false,
              reason: 'Diff was empty — no actual file changes',
            });
            failedCount++;
          }
        }
        const fixesWithDiff = fixesToVerify.filter((f) => !emptyDiffIds.has(f.id));

        spinner.text = `Verifying ${formatNumber(fixesWithDiff.length)} fixes in batch...`;
        const state = getState(stateContext);
        // Split by escalation need so we only use the stronger model for issues that had previous rejections.
        // Create an ID set for O(1) lookup instead of O(n²) nested loops (only for issues with non-empty diff).
        const needStrongerIdSet = new Set(
          getCurrentModel
            ? changedIssues
                .filter((issue) => !emptyDiffIds.has(issue.comment.id) && (state.verifierRejectionCount?.[issue.comment.id] ?? 0) >= VERIFIER_ESCALATION_THRESHOLD)
                .map((i) => i.comment.id)
            : []
        );
        const fixesDefault: typeof fixesToVerify = [];
        const fixesStronger: typeof fixesToVerify = [];
        for (const fix of fixesWithDiff) {
          if (needStrongerIdSet.has(fix.id)) {
            fixesStronger.push(fix);
          } else {
            fixesDefault.push(fix);
          }
        }
        const runner = getRunner?.();
        const preferredVerifier = typeof llm.getVerifierModel === 'function' ? llm.getVerifierModel() : undefined;
        const currentModel = getCurrentModel ? getCurrentModel() : undefined;
        const strongerModel = runner && (preferredVerifier || currentModel)
          ? getStrongerVerifierModel(runner, preferredVerifier, currentModel)
          : undefined;

        // Split out API/signature-related fixes so we can verify them with a stronger model.
        // WHY: Weak default verifier often approves fixes that miss call-site updates (e.g. await/args); stronger model catches those and reduces "fixed then broken at call site".
        const fixesNeedStrongerVerifier = fixesDefault.filter((f) =>
          commentMentionsApiOrSignature(f) || commentNeedsLifecycleContext(f)
        );
        const fixesDefaultRest = fixesDefault.filter((f) =>
          !commentMentionsApiOrSignature(f) && !commentNeedsLifecycleContext(f)
        );

        // Batch all stronger-model verifications into one call when possible (prompts.log audit: avoid two separate opus calls for same file).
        const fixesForStronger =
          strongerModel && (fixesNeedStrongerVerifier.length > 0 || fixesStronger.length > 0)
            ? [...fixesNeedStrongerVerifier, ...fixesStronger]
            : [];

        const result = new Map<string, { fixed: boolean; explanation: string; lesson?: string }>();
        if (fixesDefaultRest.length > 0) {
          const defaultResult = await llm.batchVerifyFixes(fixesDefaultRest);
          for (const [id, value] of defaultResult) result.set(id, value);
        }
        if (fixesForStronger.length > 0) {
          debug('Using stronger model for verification (API/signature + previous rejections)', { model: strongerModel, count: fixesForStronger.length });
          const strongerResult = await llm.batchVerifyFixes(fixesForStronger, { model: strongerModel });
          for (const [id, value] of strongerResult) result.set(id, value);
        } else if (fixesNeedStrongerVerifier.length > 0 && !strongerModel) {
          const apiResult = await llm.batchVerifyFixes(fixesNeedStrongerVerifier);
          for (const [id, value] of apiResult) result.set(id, value);
        } else if (fixesStronger.length > 0 && !strongerModel) {
          const fallback = await llm.batchVerifyFixes(fixesStronger);
          for (const [id, value] of fallback) result.set(id, value);
        }

        for (const issue of changedIssues) {
          if (emptyDiffIds.has(issue.comment.id)) continue; // already processed above
          const verification = result.get(issue.comment.id);
          if (verification) {
            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: verification.fixed,
              reason: verification.explanation,
            });

            if (verification.fixed) {
              verifiedCount++;
              Verification.markVerified(stateContext, issue.comment.id);
              Iterations.addCommentToIteration(stateContext, issue.comment.id);
              verifiedThisSession.add(issue.comment.id);
              
              // Clean up fix-attempt lessons now that the issue is resolved
              const cleaned = LessonsAPI.Cleanup.cleanupLessonsForFixedIssue(
                lessonsContext, getIssuePrimaryPath(issue), issue.comment.line
              );
              if (cleaned > 0) {
                debug(`Cleaned up ${cleaned} fix-attempt lesson(s) for ${getIssuePrimaryPath(issue)}:${issue.comment.line}`);
              }
              
              // Auto-verify duplicates of this canonical issue
              if (duplicateMap) {
                const duplicates = duplicateMap.get(issue.comment.id) || [];
                for (const dupId of duplicates) {
                  if (!Verification.isVerified(stateContext, dupId)) {
                    Verification.markVerified(stateContext, dupId, issue.comment.id);
                    verifiedThisSession.add(dupId);
                    autoVerifiedCount++;
                    debug(`Auto-verified duplicate comment ${dupId} (canonical ${issue.comment.id} was fixed)`);
                  }
                }
              }
            } else {
              // output.log audit: verifier said "diff is empty" → treat as no-changes, add lesson, don't escalate.
              if (isEmptyDiffVerdict(verification.explanation)) {
                LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${getIssuePrimaryPath(issue)}:${issue.comment.line ?? '?'} - fix must produce a non-empty diff; verifier reported no changes.`);
                failedCount++;
                continue;
              }
              const state = getState(stateContext);
              const rejectionCount = (state.verifierRejectionCount?.[issue.comment.id] ?? 0) + 1;
              const fixEntry = fixesToVerify.find((f) => f.id === issue.comment.id);
              const currentCode = fixEntry?.currentCode ?? '';
              // After N rejections, if the review's bug pattern is no longer in the code, auto-verify
              // to break fixer/verifier stalemates (audit: reporting.py enumerate was fixed but verifier kept rejecting).
              if (
                rejectionCount >= AUTO_VERIFY_PATTERN_ABSENT_THRESHOLD &&
                // WHY conservative gate: "pattern absent near the anchor line" is weak evidence for
                // stateful lifecycle bugs. Avoid auto-passing leak/cleanup issues unless the verifier
                // reviewed the broader symbol lifecycle and explicitly accepted the fix.
                !commentNeedsLifecycleContext({ comment: issue.comment.body }) &&
                currentCode &&
                currentCode !== '(file not found or unreadable)' &&
                bugPatternAbsentInCode(issue.comment.body, currentCode)
              ) {
                verifiedCount++;
                Verification.markVerified(stateContext, issue.comment.id);
                Iterations.addVerificationResult(stateContext, issue.comment.id, {
                  passed: true,
                  reason: `Auto-verified: bug pattern no longer in code after ${rejectionCount} verifier rejections`,
                });
                Iterations.addCommentToIteration(stateContext, issue.comment.id);
                verifiedThisSession.add(issue.comment.id);
                const cleaned = LessonsAPI.Cleanup.cleanupLessonsForFixedIssue(
                  lessonsContext, getIssuePrimaryPath(issue), issue.comment.line
                );
                if (cleaned > 0) {
                  debug(`Auto-verified (pattern absent) and cleaned ${cleaned} lesson(s) for ${getIssuePrimaryPath(issue)}:${issue.comment.line}`);
                }
              } else {
                failedCount++;
                const contradiction = verification.lesson && verification.lesson !== verification.explanation
                  ? `${verification.explanation} Next time: ${verification.lesson}`
                  : verification.explanation;
                issue.verifierContradiction = contradiction;
                if (!issue.verifierFeedbackHistory) issue.verifierFeedbackHistory = [];
                issue.verifierFeedbackHistory.push(contradiction);
                if (issue.verifierFeedbackHistory.length > VERIFIER_FEEDBACK_HISTORY_MAX) {
                  issue.verifierFeedbackHistory = issue.verifierFeedbackHistory.slice(-VERIFIER_FEEDBACK_HISTORY_MAX);
                }
                if (!state.verifierRejectionCount) state.verifierRejectionCount = {};
                state.verifierRejectionCount[issue.comment.id] = rejectionCount;
                if (isDeleteEntirelyVerdict(verification.explanation)) {
                  if (!state.deleteEntirelyVerdictCountByCommentId) state.deleteEntirelyVerdictCountByCommentId = {};
                  state.deleteEntirelyVerdictCountByCommentId[issue.comment.id] = (state.deleteEntirelyVerdictCountByCommentId[issue.comment.id] ?? 0) + 1;
                }
                const lesson = verification.lesson
                  || `Fix rejected: ${verification.explanation}`;
                LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${getIssuePrimaryPath(issue)}:${issue.comment.line} - ${lesson}`);
              }
            }
          } else {
            // No verification result returned for this issue - treat as failed
            // WHY no lesson: "No verification result returned" is a parsing/infra issue,
            // NOT actionable guidance for fixing code. These pollute the lessons list
            // and waste prompt tokens with zero value.
            failedCount++;
            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: false,
              reason: 'No verification result returned by LLM',
            });
          }
        // Review: handles cases with no verification result to ensure consistent error tracking.
        }
      }
    }

  } finally {
    spinner.stop();
  }
  const verifyTime = endTimer('Verify fixes');
  
  // Verification results — show what left (or stayed in) the queue.
  // WHY: This is the counterpart to the QUEUE log. Together they bracket
  // the fix attempt: QUEUE shows what went in, this shows what came out.
  console.log(chalk.gray(`\n  Verified in ${formatDuration(verifyTime)}`));
  
  if (failedCount > 0) {
    const n = failedCount;
    const unchanged = unchangedIssues.length;
    const detail =
      unchanged === n
        ? ' (file not modified by fixer)'
        : unchanged > 0
          ? ` (${formatNumber(unchanged)} ${pluralize(unchanged, 'file')} not modified, ${formatNumber(n - unchanged)} failed verification)`
          : ' (not fixed)';
    console.log(chalk.yellow(`  ○ ${formatNumber(n)} issue(s) still in queue${detail}`));
  }
  
  if (verifiedCount > 0 || autoVerifiedCount > 0 || failedCount > 0) {
    const totalResolved = verifiedCount + autoVerifiedCount;
    if (totalResolved > 0) {
      console.log(chalk.greenBright(`  ┌─ RESOLVED: ${formatNumber(totalResolved)} issue(s) leaving queue ─┐`));
      // Show each verified issue with its file
      for (const issue of changedIssues) {
        if (verifiedThisSession.has(issue.comment.id)) {
          const line = issue.comment.line ? `:${issue.comment.line}` : '';
          console.log(chalk.greenBright(`  │  - ${getIssuePrimaryPath(issue)}${line} ✓ fixed`));
        }
      }
      if (autoVerifiedCount > 0) {
        console.log(chalk.greenBright(`  │  + ${autoVerifiedCount} duplicate(s) auto-resolved`));
      }
      console.log(chalk.greenBright(`  └${'─'.repeat(40)}┘`));
    }
  }

  // Self-corruption detection: if ALL issues on a file failed verification,
  // check whether previous fixer attempts have structurally damaged the file.
  // If corrupted, restore from base branch to give the next iteration a clean slate.
  if (failedCount > 0 && verifiedCount === 0) {
    const failedByFile = new Map<string, number>();
    for (const issue of changedIssues) {
      const path = getIssuePrimaryPath(issue);
      failedByFile.set(path, (failedByFile.get(path) || 0) + 1);
    }

    for (const [filePath, count] of failedByFile.entries()) {
      if (count < 2) continue; // Only check files with multiple failed issues
      try {
        const corruption = await detectFileCorruption(git, filePath, 'HEAD');
        if (corruption.corrupted && corruption.baseContent) {
          console.log(chalk.red(`  ⚠ Self-corruption detected in ${filePath}: ${corruption.reason}`));
          console.log(chalk.yellow(`    Restoring from base branch to give next iteration a clean slate...`));
          try {
            await git.checkout(['HEAD', '--', filePath]);
            debug(`Restored corrupted file from HEAD: ${filePath}`);
          } catch {
            debug(`Could not restore ${filePath} from HEAD`);
          }
        }
      } catch {
        // Corruption detection is best-effort
      }
    }
  }

  return { verifiedCount, failedCount, changedIssues, unchangedIssues, changedFiles };
}
