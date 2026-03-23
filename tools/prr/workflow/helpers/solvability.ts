/**
 * Issue solvability detection and snippet refresh
 * 
 * Catches unsolvable issues early (deleted files, line drift, chronic failure)
 * before any LLM call, and refreshes stale snippets between fix iterations.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import chalk from 'chalk';
import type { ReviewComment } from '../../github/types.js';
import type { StateContext } from '../../state/state-context.js';
import type { UnresolvedIssue } from '../../analyzer/types.js';
import { getTestPathForIssueLike, isTestOrSpecPath, issueRequestsTestsText } from '../../analyzer/test-path-inference.js';
import * as Performance from '../../state/state-performance.js';
import * as Dismissed from '../../state/state-dismissed.js';
import { ALREADY_FIXED_EXHAUST_THRESHOLD, ALREADY_FIXED_ANY_THRESHOLD, APPLY_FAILURE_DISMISS_THRESHOLD, CANNOT_FIX_EXHAUST_THRESHOLD, CHRONIC_FAILURE_THRESHOLD, CANNOT_FIX_MISSING_CONTENT_THRESHOLD, VERIFIER_REJECTION_DISMISS_THRESHOLD, WRONG_FILE_EXHAUST_THRESHOLD, WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD } from '../../../../shared/constants.js';
import { pluralize, debug } from '../../../../shared/logger.js';
import { isLockFile, getLockFileInfo } from '../../../../shared/git/git-lock-files.js';
import {
  isReviewPathFragment,
  pathDismissCategoryForNotFound,
  tryResolvePathWithExtensionVariants,
} from '../../../../shared/path-utils.js';
import { hashFileContentSync } from '../../../../shared/utils/file-hash.js';
import { getOutdatedModelCatalogDismissal } from './outdated-model-advice.js';

export const SNIPPET_PLACEHOLDER = '(file not found or unreadable)';

const repoFilesCache = new Map<string, string[]>();

type TrackedPathResolution =
  | { kind: 'exact'; path: string }
  | { kind: 'suffix'; path: string }
  | { kind: 'body-hint'; path: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'missing' }
  | { kind: 'fragment' };  // e.g. ".d.ts" — not a full file path

/**
 * Cached `git ls-files` output for tracked-path resolution.
 *
 * WHY: Solvability runs for every comment, and path resolution may be consulted
 * by analysis, dismissal comments, and mid-run new-comment handling. Re-running
 * `git ls-files` each time would turn the safer path categories into extra I/O
 * noise.
 */
function getTrackedRepoFiles(workdir: string): string[] | null {
  let repoFiles = repoFilesCache.get(workdir);
  if (!repoFiles) {
    try {
      const out = execFileSync('git', ['ls-files'], { cwd: workdir, encoding: 'utf8' });
      repoFiles = out.split('\n').map((f) => f.trim()).filter(Boolean);
      repoFilesCache.set(workdir, repoFiles);
    } catch {
      return null;
    }
  }
  return repoFiles;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPathHintsFromBody(body: string): string[] {
  if (!body) return [];
  const hints: string[] = [];
  const seen = new Set<string>();
  // Paths with extension (e.g. plugins/plugin-form/typescript/src/providers/context.ts)
  const pathRe = /`?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml))`?/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(body)) !== null) {
    const hint = match[1]!;
    if (seen.has(hint)) continue;
    seen.add(hint);
    hints.push(hint);
  }
  // Pill #5/#10: path-like segments without extension (e.g. ../src/providers/context, src/providers/context)
  const pathLikeRe = /(?:\.\.\/)*(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g;
  while ((match = pathLikeRe.exec(body)) !== null) {
    const raw = match[0]!;
    const hint = raw.replace(/^\.\.\//, '').trim();
    if (hint.length < 4 || seen.has(hint)) continue;
    if (/\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml)$/.test(hint)) continue;
    seen.add(hint);
    hints.push(hint);
  }
  return hints;
}

/** Bare filenames in body (e.g. TickerClient.tsx) for (PR comment) path inference. */
function extractBareFilePathHintsFromBody(body: string): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const bareRe = /\b([A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml))\b/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(body)) !== null) {
    const hint = m[1]!;
    if (!seen.has(hint)) {
      seen.add(hint);
      out.push(hint);
    }
  }
  return out;
}

function scorePathCandidateAgainstBody(candidate: string, body: string): number {
  if (!body) return 0;
  let score = 0;
  const lowerBody = body.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  if (lowerBody.includes(lowerCandidate)) score += 100;
  const segments = candidate.split('/').filter(Boolean);
  for (const segment of segments.slice(-3)) {
    if (segment.length < 3) continue;
    if (lowerBody.includes(segment.toLowerCase())) score += 10;
  }
  const parentDir = segments.length > 1 ? segments[segments.length - 2] : '';
  if (parentDir && lowerBody.includes(parentDir.toLowerCase())) score += 20;
  return score;
}

/** Compact candidate list for debug/dismissal text. WHY: large ambiguous basename sets should explain the problem without flooding logs. */
function formatPathCandidates(candidates: string[]): string {
  if (candidates.length <= 3) return candidates.join(', ');
  return `${candidates.slice(0, 3).join(', ')} (+${candidates.length - 3} more)`;
}

function commentRequestsTests(body: string): boolean {
  return issueRequestsTestsText(body);
}

function inferCreateFileTargetPath(comment: ReviewComment): string | null {
  return getTestPathForIssueLike(
    { comment, explanation: '' },
    { keepExistingTestPath: true }
  );
}

/**
 * Missing test/spec paths are often the thing the review wants us to create.
 *
 * WHY: "file missing" usually means stale, but for comments like "add
 * widget.test.ts" the absence is the requested change. Distinguish that case
 * before we dismiss it as missing.
 */
function isCreateFileCandidate(comment: ReviewComment, resolution: TrackedPathResolution): boolean {
  const targetPath = inferCreateFileTargetPath(comment);
  if (!targetPath || !isTestOrSpecPath(targetPath)) return false;
  if (resolution.kind === 'exact' || resolution.kind === 'suffix' || resolution.kind === 'body-hint') return false;
  return commentRequestsTests(comment.body ?? '') || isTestOrSpecPath(comment.path);
}

/**
 * Resolve a possibly truncated review path to a tracked repo file.
 *
 * WHY: Review bots often cite non-root-relative paths like `generate-skills-md.ts`,
 * `SKILL.md`, or `wallet/nfts/route.ts`. Using the raw path in solvability caused
 * incorrect "File no longer exists" dismissal before the fix loop even started.
 *
 * Strategy:
 * 1. Exact tracked-file match → use as-is.
 * 2. Unique suffix match (`foo/bar.ts` or bare basename) → use that file.
 * 3. Comment-body path hints may break suffix ties when the review mentions a fuller path.
 * 4. Ambiguous basename → preserve ambiguity rather than guessing the wrong file.
 *
 * WHY preserve ambiguity: Calling an ambiguous basename "missing" or guessing a
 * winner both mislead operators. The debug table should say "we could not tell
 * which file this meant" when that is the real problem.
 */
export function resolveTrackedPathDetailed(workdir: string, rawPath: string, commentBody = ''): TrackedPathResolution {
  const repoFiles = getTrackedRepoFiles(workdir);
  if (!repoFiles) return { kind: 'missing' };
  if (isReviewPathFragment(rawPath)) return { kind: 'fragment' };
  const exact = repoFiles.find((f) => f === rawPath);
  if (exact) return { kind: 'exact', path: exact };
  const suffixMatches = repoFiles.filter((f) => f.endsWith('/' + rawPath) || f === rawPath);
  if (suffixMatches.length === 0) {
    // Config extension variant: review path tsconfig.js but file is tsconfig.json (common bot mistake)
    if (rawPath.endsWith('tsconfig.js') || rawPath === 'tsconfig.js') {
      const altPath = rawPath.slice(0, -3) + 'json';
      const altExact = repoFiles.find((f) => f === altPath);
      if (altExact) {
        debug('Review path tsconfig.js not found; resolved to tsconfig.json', { rawPath, resolved: altExact });
        return { kind: 'suffix', path: altExact };
      }
      const altSuffix = repoFiles.filter((f) => f.endsWith('/' + altPath) || f === altPath);
      if (altSuffix.length === 1) {
        debug('Review path tsconfig.js not found; resolved to tsconfig.json', { rawPath, resolved: altSuffix[0] });
        return { kind: 'suffix', path: altSuffix[0] };
      }
    }
    if (rawPath.endsWith('jsconfig.js') || rawPath === 'jsconfig.js') {
      const altPath = rawPath.slice(0, -3) + 'json';
      const altExact = repoFiles.find((f) => f === altPath);
      if (altExact) {
        debug('Review path jsconfig.js not found; resolved to jsconfig.json', { rawPath, resolved: altExact });
        return { kind: 'suffix', path: altExact };
      }
      const altSuffix = repoFiles.filter((f) => f.endsWith('/' + altPath) || f === altPath);
      if (altSuffix.length === 1) {
        debug('Review path jsconfig.js not found; resolved to jsconfig.json', { rawPath, resolved: altSuffix[0] });
        return { kind: 'suffix', path: altSuffix[0] };
      }
    }
    // Prefix variant: review path missing top-level dir (e.g. plugin-personality/... vs plugins/plugin-personality/...)
    const commonPrefixes = ['plugins/', 'packages/', 'benchmarks/', 'tools/', 'shared/', 'examples/'];
    for (const prefix of commonPrefixes) {
      if (rawPath.startsWith(prefix)) continue;
      const prefixed = prefix + rawPath;
      const exactPrefixed = repoFiles.find((f) => f === prefixed);
      if (exactPrefixed) {
        debug('Review path resolved with prefix', { rawPath, prefix, resolved: exactPrefixed });
        return { kind: 'suffix', path: exactPrefixed };
      }
      const suffixPrefixed = repoFiles.filter((f) => f.endsWith('/' + prefixed) || f === prefixed);
      if (suffixPrefixed.length === 1) {
        debug('Review path resolved with prefix', { rawPath, prefix, resolved: suffixPrefixed[0] });
        return { kind: 'suffix', path: suffixPrefixed[0] };
      }
    }
    // Extension typo: review path .ts but file is .tsx (common bot mistake); pill-output.md #4
    if (rawPath.endsWith('.ts') && !rawPath.endsWith('.tsx')) {
      const altPath = rawPath.slice(0, -3) + 'tsx';
      const altExact = repoFiles.find((f) => f === altPath);
      if (altExact) {
        debug('Review path .ts not found; resolved to .tsx (extension typo)', { rawPath, resolved: altExact });
        return { kind: 'suffix', path: altExact };
      }
      const altSuffix = repoFiles.filter((f) => f.endsWith('/' + altPath) || f === altPath);
      if (altSuffix.length === 1) {
        debug('Review path .ts not found; resolved to .tsx (extension typo)', { rawPath, resolved: altSuffix[0] });
        return { kind: 'suffix', path: altSuffix[0] };
      }
    }
    return { kind: 'missing' };
  }
  if (suffixMatches.length === 1) return { kind: 'suffix', path: suffixMatches[0] };

  const pathHints = extractPathHintsFromBody(commentBody);
  for (const hint of pathHints) {
    const hinted = suffixMatches.find((f) => {
      if (f === hint || f.endsWith('/' + hint)) return true;
      // Pill #5/#10: hint may be path without extension (e.g. src/providers/context) → match .../context.ts
      if (f.includes(hint) && (f.endsWith(hint + '.ts') || f.endsWith('/' + hint + '.ts') || f.endsWith(hint + '.tsx') || f.endsWith('/' + hint + '.tsx'))) return true;
      return false;
    });
    if (hinted) return { kind: 'body-hint', path: hinted };
  }

  const scored = suffixMatches
    .map((candidate) => ({ candidate, score: scorePathCandidateAgainstBody(candidate, commentBody) }))
    .sort((a, b) => b.score - a.score || a.candidate.length - b.candidate.length);
  if (scored[0] && scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? -1)) {
    return { kind: 'body-hint', path: scored[0].candidate };
  }

  if (!rawPath.includes('/')) {
    return { kind: 'ambiguous', candidates: suffixMatches };
  }
  return { kind: 'suffix', path: suffixMatches.reduce((a, b) => (a.length <= b.length ? a : b)) };
}

export function resolveTrackedPath(workdir: string, rawPath: string, commentBody?: string): string | null {
  const resolved = resolveTrackedPathDetailed(workdir, rawPath, commentBody);
  return 'path' in resolved ? resolved.path : null;
}

export interface SolvabilityResult {
  solvable: boolean;
  reason?: string;                    // For logging
  dismissCategory?: 'stale' | 'remaining' | 'not-an-issue' | 'chronic-failure' | 'already-fixed' | 'missing-file' | 'path-unresolved';
  /** Next-step for humans (e.g. lockfile: "Run: bun install") */
  remediationHint?: string;
  contextHints?: string[];            // Injected into LLM prompt in Phase 3
  retargetedLine?: number;            // If smart re-targeting found the code at a different line
  resolvedPath?: string;              // Canonical tracked path when raw comment path was truncated/basename-only
  /** Pill cycle 2 #6: When true, auto-verify instead of dismissing (e.g. after N ALREADY_FIXED verdicts) */
  autoVerify?: boolean;
}

/**
 * Human "closing / merged" chatter on a file line — not a code defect (audit eliza#6575).
 * WHY: GitHub may anchor merge-status replies on arbitrary files; the fix loop then burns stale cycles.
 */
function isMergeClosingMetaComment(body: string | undefined): boolean {
  if (!body || body.length > 6_000) return false;
  const t = body.trim();
  const looksClosing =
    /^\s*closing[\s—:-]/i.test(t) ||
    /\bbranch\s+was\s+already\s+merged\b/i.test(t) ||
    /\bthis\s+work\s+is\s+(?:already\s+)?in\s+\S+/i.test(t);
  if (!looksClosing) return false;
  if (!/\bmerged\b/i.test(body)) return false;
  const head = body.slice(0, 550).toLowerCase();
  if (
    /\b(model\s+name|typo|invalid\s+model|incorrect\s+import|undefined|error:|fix:|should\s+use|change\s+`)\b/.test(
      head,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Assess whether an issue is solvable before attempting any LLM call.
 * Checks file existence, line validity with smart re-targeting, and attempt exhaustion.
 * 
 * WHY: Eliminates LLM cost for deleted files, line drift, and chronic retries.
 */
export function assessSolvability(
  workdir: string,
  comment: ReviewComment,
  stateContext: StateContext
): SolvabilityResult {
  // Check 0a: PR metadata requests (title, description, labels, etc.)
  // WHY: Some review comments ask to update the PR title/description/labels,
  // which are GitHub API operations — not file edits. The fixer can't solve
  // these, and they loop forever (observed: "update PR title" re-attempted 5+
  // times with 0 progress, generating noise lessons and wasting iterations).
  if (isPRMetadataRequest(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: 'Comment requests PR metadata change (title/description/labels) — not solvable via file edits',
    };
  }

  // Check 0a2: Summary/meta-review comments (reviewer recap tables: "| Issue | Status |" with ✅/❌/Fixed/Still missing)
  // WHY: These are status recaps of many issues, not a single fixable item. Treating them as one issue causes
  // verifier confusion (e.g. "patchComponent tests: Still missing" row → NO with wrong reasoning). Dismiss so we don't fix "the summary".
  if (isSummaryOrMetaReviewComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Summary or meta-review comment (status recap table), not a single fixable issue',
    };
  }

  // Check 0a3: Pure approval comments ("Approve", "All critical issues addressed/resolved", "LGTM")
  // WHY: Audit showed approval comments consumed 10+ fix cycles because they survived dedup and existence checks.
  if (isApprovalComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Approval/verdict comment — no issue to fix',
    };
  }

  // Check 0a3b: PR merge / branch-closing status (often anchored on a code file by mistake).
  if (isMergeClosingMetaComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'PR merge or branch-closing message — no concrete code fix requested',
    };
  }

  // Check 0a4: "What's Good" / positive-summary meta-comments (reviewer recap, not a single fixable issue).
  // WHY: Audit showed "### ✅ What's Good" comments entered the fix loop and consumed iterations; they are meta-review, not actionable.
  if (isWhatsGoodOrPositiveSummaryComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: "Positive summary / \"What's Good\" meta-comment — not a single fixable issue",
    };
  }

  // Check 0a5: Bot progress / checklist comments ("PR Review in Progress", "Task List", etc.)
  // WHY: output.log/prompts.log audit showed these status posts can enter the fix loop,
  // where every model correctly says "not actionable" but we still burn a full stale cycle.
  if (isBotProgressOrChecklistComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Bot progress/checklist comment — review status update, not a code issue to fix',
    };
  }

  // Check 0a5b: Human confirmed the thread is addressed (e.g. "✅ Confirmed as addressed by @user").
  // WHY: output.log audit eliza#6562 — no remaining code task; keeps Remaining queue noisy and burns retries.
  if (isHumanConfirmedAddressedComment(comment.body)) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Reviewer/human confirmed issue already addressed — no code change requested',
    };
  }

  // Check 0a6: Outdated vendor model-ID "typo" advice (bots vs committed catalog).
  // WHY early in solvability: Same category as 0a4/0a5 — stop non-actionable bot text before path
  // resolution and LLM analysis. Pair must parse + both ids in generated/model-provider-catalog.json.
  // Heal (if enabled) runs in main-loop-setup; dismissal here keeps the issue out of unresolvedIssues.
  const catalogDismiss = getOutdatedModelCatalogDismissal(comment.body ?? '');
  if (catalogDismiss) {
    console.log(
      chalk.gray(
        `Solvability 0a6: dismissing catalog model-id noise — ${catalogDismiss.pair.catalogGoodId} vs ${catalogDismiss.pair.wronglySuggestedId} (comment ${String(comment.id)})`,
      ),
    );
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: catalogDismiss.reason,
    };
  }

  // Check 0b: Path traversal guard (comment.path comes from GitHub API; can be null from GraphQL/bot parsing).
  // WHY guard null/empty: join(workdir, comment.path) and comment.path.replace() throw if path is null; we dismiss path-less comments instead of crashing.
  if (comment.path == null || comment.path === '') {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: 'Comment has no file path — cannot target a fix',
    };
  }
  const fullPath = join(workdir, comment.path);
  const resolvedWorkdir = resolve(workdir);
  const resolvedPath = resolve(fullPath);
  if (!resolvedPath.startsWith(resolvedWorkdir + sep) && resolvedPath !== resolvedWorkdir) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: `Path outside workdir: ${comment.path}`,
    };
  }

  // Check 0c: Tool-artifact paths (.prr/ is tool-managed; fixer must not modify, and file may not exist yet)
  // WHY: Bots sometimes comment on .prr/lessons.md (e.g. "remove from version control"). We exclude these
  // so we never fetch snippets (ENOENT) or send fix prompts for our own artifact paths.
  const normalizedPath = comment.path.replace(/\\/g, '/');
  if (normalizedPath.startsWith('.prr/')) {
    return {
      solvable: false,
      dismissCategory: 'stale',
      reason: `Path is under .prr/ (tool-managed); excluded from fix loop`,
    };
  }

  // Check 0d: Lockfiles — LLM search/replace fails on lockfiles; use package manager instead
  // WHY: bun.lock, package-lock.json, etc. are generated; edits should be "run bun install" / "npm install"
  if (isLockFile(normalizedPath)) {
    const lockInfo = getLockFileInfo(normalizedPath);
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: `Lockfile — update with package manager (e.g. bun install, npm install) instead of editing`,
      remediationHint: lockInfo ? `Run: ${lockInfo.regenerateCmd}` : undefined,
    };
  }

  // Pill cycle 2 #1: Early-exit for synthetic path "(PR comment)" — dismiss before path inference to avoid wasted LLM calls.
  // WHY: Log shows issues #0017 and #0019 both attempted the same PR-checklist comment with TARGET FILE = '(PR comment)'.
  // These waste LLM fix calls per iteration. Only try path inference if body suggests a real file (has file-like patterns).
  if (normalizedPath === '(PR comment)') {
    // Pill cycle 2 #12: Detect bot commands (e.g. "@coderabbitai review") with specific category
    const bodyLower = (comment.body ?? '').toLowerCase().trim();
    if (/^@\w+.*(?:review|analyze|check)/i.test(bodyLower)) {
      return {
        solvable: false,
        dismissCategory: 'not-an-issue',
        reason: 'Bot command (e.g. @coderabbitai review) — not a code issue to fix',
      };
    }
    if (bodyLower.length < 60) {
      return {
        solvable: false,
        dismissCategory: 'not-an-issue',
        reason: 'Synthetic path "(PR comment)" — too short to infer file path',
      };
    }
    
    // Try to infer path from body (only if body has file-like patterns)
    const pathHints = [
      ...extractPathHintsFromBody(comment.body ?? ''),
      ...extractBareFilePathHintsFromBody(comment.body ?? ''),
    ];
    const resolvedPaths = new Set<string>();
    for (const hint of pathHints) {
      const resolution = resolveTrackedPathDetailed(workdir, hint, comment.body ?? '');
      if ('path' in resolution) resolvedPaths.add(resolution.path);
    }
    if (resolvedPaths.size === 1) {
      const resolvedPath = [...resolvedPaths][0]!;
      const effectiveFullPath = join(workdir, resolvedPath);
      if (existsSync(effectiveFullPath)) {
        const retargetedLine = extractMaxLineRefFromBody(comment.body ?? '') ?? undefined;
        return {
          solvable: true,
          resolvedPath,
          retargetedLine,
          contextHints: ['Path inferred from (PR comment) body; fixer target may need verification.'],
        };
      }
    }
    // No single resolvable path — fixer cannot edit a non-file; dismiss.
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: 'Synthetic path "(PR comment)" — no target file for fixer to edit',
    };
  }

  // Resolve truncated/basename review paths to tracked repo files before existence checks.
  // WHY: Without this, comments on `generate-skills-md.ts` or `SKILL.md` were dismissed as stale
  // even though the real repo files existed at `scripts/...` / `skills/babylon/...`.
  const pathResolution = resolveTrackedPathDetailed(workdir, comment.path, comment.body);
  if (pathResolution.kind === 'fragment') {
    return {
      solvable: false,
      dismissCategory: 'path-unresolved',
      reason: `Review path "${comment.path}" is a fragment (e.g. .d.ts), not a full file path — cannot resolve to a single file`,
    };
  }
  let effectivePath = 'path' in pathResolution ? pathResolution.path : comment.path;
  effectivePath = tryResolvePathWithExtensionVariants(workdir, effectivePath);
  const effectiveFullPath = join(workdir, effectivePath);

  // Check 0e1: Issue references line numbers beyond current file length (file was shortened → comment stale).
  // WHY: output.log audit — DATABASE_API_README.md had 37 lines but review referenced "lines 56-57, 120-121"; verifier couldn't confirm and we burned 3+ iterations.
  try {
    if (existsSync(effectiveFullPath)) {
      const content = readFileSync(effectiveFullPath, 'utf8');
      const lineCount = content.split('\n').length;
      const maxRef = extractMaxLineRefFromBody(comment.body);
      if (maxRef != null && lineCount < maxRef) {
        return {
          solvable: false,
          dismissCategory: 'stale',
          reason: `Issue references line(s) up to ${maxRef} but file has ${lineCount} line(s) — likely stale (file shortened)`,
        };
      }
    }
  } catch {
    /* ignore read errors */
  }

  // Check 0e2: CANNOT_FIX exhaustion — fixer said CANNOT_FIX N times (output.log audit); dismiss as not-an-issue.
  const cannotFixConsecutive = stateContext.state?.cannotFixConsecutiveByCommentId?.[comment.id] ?? 0;
  if (cannotFixConsecutive >= CANNOT_FIX_EXHAUST_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: `CANNOT_FIX ${cannotFixConsecutive}× — dismissing as not fixable via code changes`,
    };
  }

  // Check 0f: CANNOT_FIX with missing/placeholder file content — circuit breaker.
  // WHY: Audit showed 10+ retries on placeholder files (500K+ tokens wasted). If the file content
  // is broken/missing and the fixer has said so N times, retrying with the same broken input won't help.
  const cannotFixCount = stateContext.state?.cannotFixMissingContentCountByCommentId?.[comment.id] ?? 0;
  if (cannotFixCount >= CANNOT_FIX_MISSING_CONTENT_THRESHOLD) {
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `CANNOT_FIX (file content missing/placeholder) ${cannotFixCount}× — skipping to avoid token waste`,
    };
  }

  // Check 1: File existence
  if (!existsSync(effectiveFullPath)) {
    if (isCreateFileCandidate(comment, pathResolution)) {
      const createFileTarget = inferCreateFileTargetPath(comment) ?? comment.path;
      return {
        solvable: true,
        resolvedPath: createFileTarget,
        contextHints: [
          `The target test/spec file \`${createFileTarget}\` does not exist yet. Treat this as a create-file issue and add the new test file.`,
        ],
      };
    }
    if (pathResolution.kind === 'ambiguous') {
      // Pill #6: Log candidate paths for ambiguous basenames
      debug('Ambiguous review path — multiple candidates', {
        commentId: comment.id,
        reviewPath: comment.path,
        candidates: pathResolution.candidates,
        candidateCount: pathResolution.candidates.length,
        commentBodySnippet: (comment.body ?? '').substring(0, 200),
      });
      return {
        solvable: false,
        dismissCategory: 'path-unresolved',
        reason: `Ambiguous review path "${comment.path}" matched multiple tracked files: ${formatPathCandidates(pathResolution.candidates)}`,
      };
    }
    return {
      solvable: false,
      dismissCategory: pathDismissCategoryForNotFound(comment.path, pathResolution.kind),
      reason: `Tracked file not found for review path: ${comment.path}`,
    };
  }

  const inferredCreateFileTarget = inferCreateFileTargetPath(comment);
  if (
    inferredCreateFileTarget &&
    inferredCreateFileTarget !== effectivePath &&
    !existsSync(join(workdir, inferredCreateFileTarget))
  ) {
    return {
      solvable: true,
      resolvedPath: inferredCreateFileTarget,
      contextHints: [
        `This review is asking for tests in \`${inferredCreateFileTarget}\`, which does not exist yet. Treat it as a create-file issue instead of editing only \`${effectivePath}\`.`,
      ],
    };
  }

  // Check 2: Smart snippet re-targeting for line drift
  if (comment.line !== null) {
    try {
      const fileContent = readFileSync(effectiveFullPath, 'utf-8');
      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // Extract identifiers from comment (backtick-wrapped).
      // WHY: Weak built-in/type names like `BigInt` are poor stale-retarget anchors and
      // should not be treated as evidence that the reviewed code disappeared.
      const { strong: identifiers, weak: weakIdentifiers } = extractIdentifierSignals(comment.body);

      if (comment.line > totalLines) {
        // Line is out of range - try to re-target using identifiers
        if (identifiers.length > 0) {
          const retargetResult = findClosestOccurrence(lines, identifiers, comment.line);
          if (retargetResult.found) {
            return {
              solvable: true,
              retargetedLine: retargetResult.line,
              contextHints: [`Code for \`${identifiers[0]}\` found at line ${retargetResult.line} (comment targeted line ${comment.line})`],
            };
          } else {
            const msg = `Comment targets line ${comment.line} but file only has ${totalLines} lines, and identifier \`${identifiers[0]}\` not found — code may have been removed or renamed`;
            return {
              solvable: false,
              dismissCategory: 'stale',
              reason: msg,
              contextHints: [msg],
            };
          // Review: identifies no longer found indicates code has shifted; thus, marked as stale.
          }
        }
        // WHY: Only weak identifiers (e.g. BigInt, symbol) are poor evidence that code was removed; keep open.
        if (weakIdentifiers.length > 0) {
          const msg = `Comment targets line ${comment.line} but file only has ${totalLines} lines, and only weak built-in/type identifiers (${weakIdentifiers.join(', ')}) were extracted — keep the issue open for broader analysis instead of dismissing as stale`;
          return {
            solvable: true,
            contextHints: [msg],
          };
        }
        // No identifiers to re-target with - mark as stale
        const msg = `File has ${totalLines} lines but comment targets line ${comment.line} — code location may have shifted and no identifiers found to re-target`;
        return {
          solvable: false,
          dismissCategory: 'stale',
          reason: msg,
          contextHints: [msg],
        };
      } else if (identifiers.length > 0) {
        // Line is within range - check if identifiers are near the target line
        const targetIdx = comment.line - 1;
        const snippetRegionStart = Math.max(0, targetIdx - 15);
        const snippetRegionEnd = Math.min(totalLines, targetIdx + 15 + 1);
        // Review: captures a ±15 line context around the target for better identifier matching
        const snippetRegion = lines.slice(snippetRegionStart, snippetRegionEnd).join('\n');

        let foundInRegion = false;
        for (const ident of identifiers) {
          if (snippetRegion.includes(ident)) {
            foundInRegion = true;
            break;
          }
        }

        if (!foundInRegion) {
          // Identifiers not in expected region - try to re-target
          const retargetResult = findClosestOccurrence(lines, identifiers, comment.line);
          if (retargetResult.found && Math.abs(retargetResult.line! - comment.line) > 10) {
            return {
              solvable: true,
              retargetedLine: retargetResult.line,
              contextHints: [`Code for \`${identifiers[0]}\` found at line ${retargetResult.line} (comment targeted line ${comment.line})`],
            };
          } else if (!retargetResult.found) {
            // Identifiers not found anywhere in the file - mark as stale
            const msg = `Comment targets line ${comment.line} but identifier \`${identifiers[0]}\` not found in file — code may have been removed or renamed`;
            return {
              solvable: false,
              dismissCategory: 'stale',
              reason: msg,
              contextHints: [msg],
            };
          }
        }
      }
    } catch {
      // File read failed after existsSync passed - let it fall through to snippet fetch
    }
  }

  // Check 3a: Apply failure exhaustion — output did not match file after N attempts (output.log audit: earlier dismissal with clear handoff).
  const applyFailures = stateContext.state?.applyFailureCountByCommentId?.[comment.id] ?? 0;
  if (applyFailures >= APPLY_FAILURE_DISMISS_THRESHOLD) {
    debug('Solvability dismiss: apply-failure chronic', { commentId: comment.id, path: comment.path, applyFailures, threshold: APPLY_FAILURE_DISMISS_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'chronic-failure',
      reason: `Output did not match file after ${applyFailures} attempt(s); manual review recommended.`,
    };
  }

  // Check 3: Chronic failure — total failed attempts for current file version only
  // WHY: Same issue failing N+ times burns tokens; only count attempts on same file content so refactors reset the counter
  const attempts = Performance.getIssueAttempts(stateContext, comment.id);
  let failedAttempts = attempts.filter(a => a.result === 'failed' || a.result === 'no-changes');
  const currentHash = hashFileContentSync(fullPath);
  failedAttempts = failedAttempts.filter(a => !a.fileContentHash || a.fileContentHash === currentHash);
  if (failedAttempts.length >= CHRONIC_FAILURE_THRESHOLD) {
    debug('Solvability dismiss: chronic-failure', { commentId: comment.id, path: comment.path, failedAttempts: failedAttempts.length, threshold: CHRONIC_FAILURE_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'chronic-failure',
      reason: `Chronic failure: ${failedAttempts.length} fix attempts failed (current file version) — dismissing to avoid infinite retries`,
    };
  // Note: filters out past failures to avoid infinite retries on known chronic issues.
  }

  // Check 3b: Verifier rejection exhaustion — verifier kept rejecting fix/ALREADY_FIXED; stop retries (remaining for human follow-up).
  const verifierRejections = stateContext.state?.verifierRejectionCount?.[comment.id] ?? 0;
  if (verifierRejections >= VERIFIER_REJECTION_DISMISS_THRESHOLD) {
    debug('Solvability dismiss: verifier-rejection', { commentId: comment.id, path: comment.path, rejections: verifierRejections, threshold: VERIFIER_REJECTION_DISMISS_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `Verifier rejected fix/claim ${verifierRejections} ${pluralize(verifierRejections, 'time', 'times')} — dismissing to avoid repeated retries`,
    };
  }

  // Check 3c: Wrong-file exhaustion — fixer kept editing the wrong file; issue may need another file (e.g. tests, README). Stop retries.
  const wrongFileCount = stateContext.state?.wrongFileLessonCountByCommentId?.[comment.id] ?? 0;
  if (wrongFileCount >= WRONG_FILE_EXHAUST_THRESHOLD) {
    debug('Solvability dismiss: wrong-file', { commentId: comment.id, path: comment.path, wrongFileCount, threshold: WRONG_FILE_EXHAUST_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `Fixer modified wrong files ${wrongFileCount} ${pluralize(wrongFileCount, 'time', 'times')} — issue may require changes in another file; dismissing for human follow-up`,
    };
  }

  // Check 4: WRONG_LOCATION/UNCLEAR — after N consecutive same explanation, stop retries (remaining for human follow-up).
  const consecutiveSame = stateContext.state?.wrongLocationUnclearConsecutiveSameByCommentId?.[comment.id] ?? 0;
  if (consecutiveSame >= WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD) {
    debug('Solvability dismiss: wrong-location/unclear', { commentId: comment.id, path: comment.path, consecutiveSame, threshold: WRONG_LOCATION_UNCLEAR_EXHAUST_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'remaining',
      reason: `UNCLEAR/WRONG_LOCATION with same explanation ${consecutiveSame}× — stopping retries`,
    };
  }

  // Pill cycle 2 #6: Auto-verify after N ALREADY_FIXED verdicts instead of dismissing.
  // WHY: Log shows issues marked ALREADY_FIXED 6+ times yet kept being re-queued when audit disagreed.
  // Auto-verifying stops the oscillation loop and treats consensus as truth.
  const alreadyFixedAny = stateContext.state?.consecutiveAlreadyFixedAnyByCommentId?.[comment.id] ?? 0;
  const AUTO_VERIFY_ALREADY_FIXED_THRESHOLD = 2; // Lower than dismiss threshold — auto-verify earlier
  if (alreadyFixedAny >= AUTO_VERIFY_ALREADY_FIXED_THRESHOLD) {
    debug('Solvability auto-verify: already-fixed-any', { commentId: comment.id, path: comment.path, alreadyFixedAny, threshold: AUTO_VERIFY_ALREADY_FIXED_THRESHOLD });
    // Return solvable: false but with a special flag that issue-analysis.ts will handle by auto-verifying
    return {
      solvable: false,
      dismissCategory: 'already-fixed',
      reason: `ALREADY_FIXED ${alreadyFixedAny}× (multiple models) — auto-verifying to stop oscillation`,
      // Special marker for issue-analysis to auto-verify instead of dismissing
      autoVerify: true,
    };
  }
  
  // Check 5a: ALREADY_FIXED any-explanation counter (dismiss threshold, higher than auto-verify).
  // WHY check here (before LLM calls): If 3+ models already said ALREADY_FIXED, re-running
  // the fixer would waste another iteration. Dismissing in solvability avoids the LLM call entirely.
  if (alreadyFixedAny >= ALREADY_FIXED_ANY_THRESHOLD) {
    debug('Solvability dismiss: already-fixed-any', { commentId: comment.id, path: comment.path, alreadyFixedAny, threshold: ALREADY_FIXED_ANY_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'already-fixed',
      reason: `ALREADY_FIXED ${alreadyFixedAny}× (multiple models) — dismissing as already-fixed`,
    };
  }

  // Check 5b: ALREADY_FIXED exhaustion — after N consecutive same explanation, dismiss as not-an-issue (prompts.log audit).
  const alreadyFixedConsecutive = stateContext.state?.alreadyFixedConsecutiveSameByCommentId?.[comment.id] ?? 0;
  if (alreadyFixedConsecutive >= ALREADY_FIXED_EXHAUST_THRESHOLD) {
    debug('Solvability dismiss: already-fixed-exhaust', { commentId: comment.id, path: comment.path, alreadyFixedConsecutive, threshold: ALREADY_FIXED_EXHAUST_THRESHOLD });
    return {
      solvable: false,
      dismissCategory: 'not-an-issue',
      reason: `ALREADY_FIXED ${alreadyFixedConsecutive}× with same explanation — dismissing as not-an-issue`,
    };
  }

  // All checks passed - issue is solvable
  const extensionTypoHint =
    effectivePath !== comment.path &&
    effectivePath.endsWith('.tsx') &&
    comment.path.endsWith('.ts') &&
    !comment.path.endsWith('.tsx')
      ? ['Review path had .ts; resolved to .tsx (extension typo).']
      : undefined;
  return {
    solvable: true,
    resolvedPath: effectivePath !== comment.path ? effectivePath : undefined,
    contextHints: extensionTypoHint,
  };
}

/**
 * Built-in and type names that are poor anchors for stale retargeting.
 * WHY: When the only backtick-wrapped token in a comment is e.g. `BigInt` or `symbol`,
 * "identifier not found" does not imply the reviewed code disappeared — these appear
 * in many files and are weak evidence for dismissing as stale. We keep the issue open instead.
 */
const WEAK_RETARGET_IDENTIFIERS = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'Date',
  'Error',
  'Function',
  'Map',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'Uint8Array',
  'boolean',
  'bigint',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
  'void',
]);

function extractIdentifierSignals(commentBody: string): { strong: string[]; weak: string[] } {
  const identPattern = /`(\w+)`/g;
  const strong: string[] = [];
  const weak: string[] = [];
  let match;
  while ((match = identPattern.exec(commentBody)) !== null) {
    const identifier = match[1];
    if (WEAK_RETARGET_IDENTIFIERS.has(identifier)) {
      weak.push(identifier);
    } else {
      strong.push(identifier);
    }
  }
  return { strong, weak };
}

export function extractIdentifiers(commentBody: string): string[] {
  return extractIdentifierSignals(commentBody).strong;
}

/**
 * Find the closest occurrence of identifiers to the original line.
 * Prefers occurrences near the original line to handle insertion-drift correctly.
 */
function findClosestOccurrence(
  lines: string[],
  identifiers: string[],
  originalLine: number
): { found: boolean; line?: number } {
  for (const ident of identifiers) {
    // Find all line numbers where this identifier appears
    const occurrences: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(ident)) {
        occurrences.push(i + 1); // 1-indexed
      }
    }

    if (occurrences.length > 0) {
      // Pick the occurrence closest to the original line
      let closestLine = occurrences[0];
      let minDistance = Math.abs(occurrences[0] - originalLine);
      for (const lineNum of occurrences) {
        const distance = Math.abs(lineNum - originalLine);
        if (distance < minDistance) {
          minDistance = distance;
          closestLine = lineNum;
        }
      }
      return { found: true, line: closestLine };
    }
  }
  return { found: false };
}

/**
 * Refresh code snippets for issues whose files were touched by the fixer.
 * Catches files deleted by the fixer and updates snippets so next iteration's prompt is accurate.
 * 
 * Returns a new array (does not mutate input).
 * WHY: Caller decides how to apply the update (consistent with push-iteration-loop patterns).
 */
export async function recheckSolvability(
  unresolvedIssues: UnresolvedIssue[],
  changedFiles: string[],
  workdir: string,
  stateContext: StateContext,
  getCodeSnippetFn: (path: string, line: number | null, body?: string) => Promise<string>
): Promise<{ updated: UnresolvedIssue[]; dismissed: number; refreshed: number }> {
  let dismissed = 0;
  let refreshed = 0;

  // Split into changed vs unchanged (sync), then batch-fetch changed snippets.
  // WHY parallel: Each snippet read is for a different file. With 10+ changed
  // issues, sequential reads waste ~0.5-1s of accumulated I/O latency.
  const unchanged: UnresolvedIssue[] = [];
  const changed: UnresolvedIssue[] = [];

  for (const issue of unresolvedIssues) {
    const primaryPath = issue.resolvedPath ?? issue.comment.path;
    if (changedFiles.includes(primaryPath)) {
      changed.push(issue);
    } else {
      unchanged.push(issue);
    }
  }

  // Fetch all changed snippets concurrently (use primary path so basename-resolved issues get correct file)
  const snippetResults = await Promise.all(
    changed.map(async (issue) => {
      const primaryPath = issue.resolvedPath ?? issue.comment.path;
      const newSnippet = await getCodeSnippetFn(
        primaryPath,
        issue.comment.line,
        issue.comment.body
      );
      return { issue, newSnippet };
    })
  );

  const updated: UnresolvedIssue[] = [...unchanged];

  for (const { issue, newSnippet } of snippetResults) {
    if (newSnippet === SNIPPET_PLACEHOLDER) {
      // File was deleted by fixer - dismiss as stale
      // CRITICAL: dismissIssue ONLY, NOT markVerified (see plan gotcha #1)
      const primaryPath = issue.resolvedPath ?? issue.comment.path;
      Dismissed.dismissIssue(
        stateContext,
        issue.comment.id,
        'File deleted by fixer',
        'stale',
        primaryPath,
        issue.comment.line,
        issue.comment.body
      );
      dismissed++;
      continue;
    }

    // Preserve all issue fields (e.g. verifierContradiction) so AAR and next fix prompt see them
    updated.push({
      ...issue,
      codeSnippet: newSnippet,
    });
    refreshed++;
  }

  return { updated, dismissed, refreshed };
}

/**
 * Detect whether a review comment is asking for a PR metadata change
 * (title, description, labels, branch name) rather than a code change.
 *
 * WHY heuristic instead of LLM: This runs before any LLM call, for every
 * comment, every iteration. Must be zero-cost. False negatives are fine
 * (comment goes to LLM as normal); false positives are bad (real issue
 * dismissed). The patterns are conservative — they require both a PR
 * metadata keyword AND an action verb in the same sentence.
 */
function isSummaryOrMetaReviewComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 800);
  // Table with Status column and status-like cells (✅/❌/Fixed/Still missing/Addressed)
  const hasStatusTable =
    /\|[^|]*\bStatus\b[^|]*\|/i.test(head) &&
    (/\|\s*(?:✅|❌|✔|✗|Fixed|Still missing|Addressed|addressed|fixed|missing)\s*\|/i.test(head) ||
      /\|\s*.*(?:✅|❌|Fixed|Still missing).*\|\s*/.test(head));
  if (hasStatusTable) return true;
  // "### Summary" or "## Summary" with multiple issue statuses (3+)
  const summaryHeading = /^[\s\S]{0,200}(?:^|\n)\s*#{1,3}\s*Summary\b/im.test(head);
  if (summaryHeading) {
    const statusLike = head.match(/(?:✅|❌|Fixed|addressed|Still missing|missing|not done)/gi);
    if (statusLike && statusLike.length >= 3) return true;
  }
  return false;
}

/**
 * Detect pure approval/verdict comments that contain no actionable fix request.
 * Examples: "Approve", "All critical issues addressed ✅", "LGTM", "All issues resolved."
 */
function isApprovalComment(commentBody: string): boolean {
  const trimmed = commentBody.trim();
  if (trimmed.length > 500) return false;
  const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (/^(approve[d]?\.?|lgtm\.?|looks good\.?|ship it\.?)$/i.test(lower)) return true;
  if (/\ball\s+(?:critical\s+)?issues?\s+(?:have\s+been\s+)?(?:addressed|resolved|fixed)\b/i.test(lower) && !/\bbut\b|\bhowever\b|\bexcept\b|\bstill\b/i.test(lower)) return true;
  if (/\ball\s+(?:critical\s+)?issues?\s+addressed\s*✅/i.test(lower)) return true;
  return false;
}

/**
 * Detect "What's Good" / positive-summary meta-comments that list strengths, not a single fix request.
 * WHY: output.log audit — "### ✅ What's Good" at component.test.ts:12 entered fix loop and wasted iterations.
 */
function isWhatsGoodOrPositiveSummaryComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 400);
  if (/^#+\s*✅\s*What'?s Good\b/im.test(head)) return true;
  if (/^#+\s*What'?s Good\s*$/im.test(head)) return true;
  if (/^#+\s*Strengths\b/im.test(head) && !/\b(fix|change|add|remove|update)\b.*\b(line|here)\b/i.test(head)) return true;
  // WHY: output.log audit babylon#1213 — "### Code Quality (Positive)" entered fix loop; treat (Positive) section headers as praise-only.
  if (/^#+\s*[^#\n]+\(Positive\)\s*$/im.test(head)) return true;
  // Pill cycle 2 #5: Catch "Excellent documentation ✅" and similar approval patterns
  // WHY: prompts.log audit — "Excellent documentation added" with ✅ reached fixer; catch praise-only documentation comments.
  if (/^#+\s*Documentation\s*✅/im.test(head) && /\b(?:Excellent|Great|Good|Well[- ]written)\s+(?:documentation|docs?)\s+added\b/i.test(head)) return true;
  if (/\b(?:Excellent|Great|Good|Well[- ]written)\s+(?:documentation|docs?)\s+added\b/i.test(head) && !/\b(?:fix|change|add|remove|update|improve|missing|lacks?)\b.*\b(?:documentation|docs?|file)\b/i.test(head)) return true;
  // Pill cycle 2 #5: Explicit approval patterns with ✅ emoji
  if (/\b(?:Excellent|Great|Good|Perfect|Outstanding)\s+(?:documentation|docs?|work|code|implementation)\s*✅/i.test(head)) return true;
  return false;
}

/**
 * Detect bot workflow/status comments that describe the review process itself.
 * Examples: "PR Review in Progress", "Task List", checklist-only progress posts with job links.
 */
function isBotProgressOrChecklistComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 1400);
  const checklistCount = (head.match(/^\s*-\s*\[[ xX]\]\s+/gm) || []).length;
  const hasProgressHeading = /^#+\s*(?:PR Review in Progress|PR Review Complete|Task List)\b/im.test(head);
  const hasReviewWorkflowText =
    /\b(?:read repository guidelines|review existing feedback|analyze changed files and pr diff|check for tests|provide consolidated review feedback)\b/i.test(head);
  const hasJobRunLink = /\[view job run\]\(https:\/\/github\.com\/.+\/actions\/runs\/\d+\)/i.test(head);
  const requestsCodeChange =
    /\b(?:fix|change|update|rename|remove|add|implement|refactor)\b.{0,60}\b(?:file|code|function|class|test|line|path)\b/i.test(head);

  if (requestsCodeChange) return false;
  if (hasProgressHeading && checklistCount >= 2) return true;
  if (checklistCount >= 4 && hasReviewWorkflowText) return true;
  if ((hasProgressHeading || hasReviewWorkflowText) && hasJobRunLink) return true;
  return false;
}

/** Thread marked resolved by a human in-line (e.g. CodeRabbit + maintainer confirmation). */
function isHumanConfirmedAddressedComment(commentBody: string): boolean {
  const head = commentBody.slice(0, 1500);
  if (/\bnot\s+confirmed\s+as\s+addressed\b/i.test(head)) return false;
  if (/✅\s*[Cc]onfirmed\s+as\s+addressed\b/.test(head)) return true;
  if (/\b[Cc]onfirmed\s+as\s+addressed\s+by\s+@/i.test(head)) return true;
  return false;
}

/**
 * Extract the highest line number referenced in text (e.g. "lines 56-57, 120-121" → 121).
 * Used to detect when a review comment references lines beyond the current file length (stale).
 */
function extractMaxLineRefFromBody(body: string): number | null {
  let max = 0;
  const rangeRe = /\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(body)) !== null) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a > max) max = a;
    if (b > max) max = b;
  }
  return max > 0 ? max : null;
}

function isPRMetadataRequest(commentBody: string): boolean {
  // Normalize: collapse whitespace, lowercase for matching
  const normalized = commentBody.toLowerCase().replace(/\s+/g, ' ');

  // Patterns: "PR title should", "update the PR description", etc.
  const metadataPatterns = [
    /\bpr\s+title\b.*\b(should|must|needs?\s+to|update|change|rename|reflect|misleading|inaccurate)\b/,
    /\b(update|change|rename|fix|improve|revise)\b.*\bpr\s+title\b/,
    /\bpr\s+description\b.*\b(should|must|needs?\s+to|update|change|reflect|misleading|inaccurate)\b/,
    /\b(update|change|rename|fix|improve|revise)\b.*\bpr\s+description\b/,
    /\bpull\s+request\s+title\b.*\b(should|must|needs?\s+to|update|change|reflect)\b/,
    /\b(update|change)\b.*\bpull\s+request\s+(title|description)\b/,
  ];

  return metadataPatterns.some(p => p.test(normalized));
}
