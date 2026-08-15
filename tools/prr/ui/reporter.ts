/**
 * UI/Reporting functions for PR resolution results.
 * Extracted from PRResolver to reduce file size and improve modularity.
 */
import chalk from 'chalk';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { getState } from '../state/state-context.js';
import * as Performance from '../state/state-performance.js';
import * as Verification from '../state/state-verification.js';

/**
 * Omit PR-description boilerplate and auto-verified duplicate threads from AAR per-thread previews.
 * WHY: `### What this adds` bodies dominate the handoff without actionable signal; duplicate-of-canonical
 * rows repeat the same fix — the header count + gray “detail omitted” line keeps totals honest.
 */
function shouldSuppressFixedThisSessionDetail(comment: ReviewComment, stateContext: StateContext | null): boolean {
  const body = sanitizeCommentForDisplay(comment.body).trim();
  if (/^###\s*what this adds\b/im.test(body)) return true;
  if (stateContext && Verification.getVerificationRecord(stateContext, comment.id)?.autoVerifiedFrom) {
    return true;
  }
  return false;
}
import * as Dismissed from '../state/state-dismissed.js';
import type { DismissedIssue } from '../state/types.js';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { formatLessonForDisplay } from '../state/lessons-normalize.js';
import { debug } from '../../../shared/logger.js';

/** Format path:line for display; use "PR-level comment" when path is the synthetic (PR comment). */
function formatCommentLocation(comment: { path: string; line?: number | null }): string {
  return comment.path === '(PR comment)' ? 'PR-level comment' : `${comment.path}:${comment.line ?? '?'}`;
}

/** Dedupe issues by (filePath, line) so the same location is shown once (e.g. remaining/exhausted from state). */
function dedupeByLocation(issues: DismissedIssue[]): DismissedIssue[] {
  const seen = new Set<string>();
  return issues.filter((d) => {
    const key = `${d.filePath}:${d.line ?? '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Group near-duplicate review threads (same file + same first-line topic) for a shorter handoff. WHY: output.log audit — multiple bots repeat the same concern at adjacent lines. */
function handoffTopicKey(path: string, body: string): string {
  const first = sanitizeCommentForDisplay(body).split('\n').find((l) => l.trim()) ?? '';
  const slug = first
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim();
  return `${path}::${slug}`;
}

function groupUnresolvedForHandoff(issues: UnresolvedIssue[]): { rep: UnresolvedIssue; others: UnresolvedIssue[] }[] {
  const map = new Map<string, UnresolvedIssue[]>();
  for (const i of issues) {
    const k = handoffTopicKey(i.comment.path, i.comment.body);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(i);
  }
  return [...map.values()].map((g) => {
    const sorted = [...g].sort((a, b) => (a.comment.line ?? 0) - (b.comment.line ?? 0));
    return { rep: sorted[0]!, others: sorted.slice(1) };
  });
}

/** Regexes used to detect analysis text that contradicts the verifier (e.g. "fix may already be in place"). */
const LOOKS_FIXED_REGEXES = [
  /already.*(?:fixed|applied|in place)/i,
  /fix.*may.*already/i,
  /suggests.*the fix/i,
];

/**
 * Sanitize a review comment body for human-readable terminal output.
 * Strips HTML tags, massive URLs (JWT tokens, data URIs, tracking links),
 * markdown images, and collapses whitespace.
 */
export function sanitizeCommentForDisplay(body: string): string {
  let text = body;
  
  // Strip HTML comments (<!-- ... -->) including BugBot metadata
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Strip entire <p> blocks that contain only links/images (BugBot "Fix in Cursor" buttons)
  text = text.replace(/<p>\s*<a[^>]*>[\s\S]*?<\/a>(?:\s*&nbsp;\s*<a[^>]*>[\s\S]*?<\/a>)*\s*<\/p>/gi, '');
  
  // Strip <picture> blocks (contain <source>/<img> for dark/light mode badges)
  text = text.replace(/<picture>[\s\S]*?<\/picture>/gi, '');
  
  // Strip <details> blocks (collapsed sections with secondary info)
  text = text.replace(/<details>[\s\S]*?<\/details>/gi, '');
  
  // Strip markdown images: ![alt](url) and HTML <img> tags
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/<img[^>]*\/?>/gi, '');
  
  // Strip <a> tags that wrap non-text content (images, badges) — remove entirely
  text = text.replace(/<a[^>]*>\s*<(?:picture|img)[^]*?<\/a>/gi, '');
  
  // Strip remaining <a> tags but keep their text content
  text = text.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  
  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  // Strip standalone URLs longer than 60 chars (JWT tokens, tracking links, data URIs)
  text = text.replace(/https?:\/\/\S{60,}/g, '');
  
  // Strip markdown links where the URL is very long: [text](huge-url) → text
  text = text.replace(/\[([^\]]*)\]\(https?:\/\/\S{60,}\)/g, '$1');
  
  // Strip HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&[a-z]+;/gi, '');
  
  // Collapse multiple blank lines into one
  text = text.replace(/\n{3,}/g, '\n\n');
  
  // Collapse leading/trailing whitespace per line, drop empty lines at start/end
  text = text.split('\n').map(l => l.trim()).join('\n').trim();
  
  return text;
}

/** First line suitable for "Fixed This Session" — strip markdown headings, skip generic "Summary" etc. Exported for unit tests. */
export function getFixedIssueTitle(sanitizedBody: string): string {
  const lines = sanitizedBody.split('\n').map(l => l.trim()).filter(Boolean);
  const genericFirstLines = /^(#+\s*)?(Summary|Done|Fixed|Overview)$/i;
  for (const line of lines) {
    const stripped = line.replace(/^#+\s*/, '').trim();
    if (!stripped) continue;
    if (genericFirstLines.test(stripped) && lines.length > 1) continue;
    return stripped;
  }
  return lines[0] ?? sanitizedBody.slice(0, 80);
}

// Re-export for callers that type against reporter; canonical type is in analyzer/types.js
export type { UnresolvedIssue } from '../analyzer/types.js';

/**
 * Format a number with commas (e.g., 1234 -> "1,234")
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Print model performance statistics
 */
export function printModelPerformance(stateContext: StateContext | null): void {
  if (!stateContext) return;
  
  const models = Performance.getModelsBySuccessRate(stateContext);
  if (models.length === 0) return;
  
  console.log(chalk.cyan('\n📊 Model Performance:'));
  
  for (const { key, stats, successRate } of models) {
    const total = stats.fixes + stats.failures;
    if (total === 0 && stats.noChanges === 0 && stats.errors === 0) continue;
    
    const pct = total > 0 ? Math.round(successRate * 100) : 0;
    const successColor = pct >= 70 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
    
    const parts: string[] = [];
    if (stats.fixes > 0) parts.push(chalk.green(`${formatNumber(stats.fixes)} fixes`));
    if (stats.failures > 0) parts.push(chalk.red(`${formatNumber(stats.failures)} failed`));
    if (stats.noChanges > 0) parts.push(chalk.gray(`${formatNumber(stats.noChanges)} no-change`));
    if (stats.errors > 0) parts.push(chalk.red(`${formatNumber(stats.errors)} errors`));
    
    const rateStr = total > 0 ? ` (${successColor(pct + '%')} success)` : '';
    console.log(`  ${key}: ${parts.join(', ')}${rateStr}`);
  }
}

/**
 * Get display properties for an exit reason
 */
type ChalkColorFn = (text: string) => string;

export function getExitReasonDisplay(exitReason: string | null): { 
  label: string; 
  icon: string; 
  color: ChalkColorFn 
} {
  switch (exitReason) {
    case 'all_fixed':
    case 'all_resolved':
    case 'audit_passed':
      return { label: 'All issues resolved', icon: '✓', color: chalk.green };
    
    case 'bail_out':
      return { label: 'Bail-out (stalemate)', icon: '⚠', color: chalk.red };
    
    case 'max_iterations':
      return { label: 'Max iterations reached', icon: '⏱', color: chalk.yellow };
    
    case 'no_comments':
      return { label: 'No review comments found', icon: '○', color: chalk.green };
    
    case 'dry_run':
      return { label: 'Dry run completed', icon: '👁', color: chalk.blue };
    
    case 'no_commit_mode':
      return { label: 'Stopped (no-commit mode)', icon: '⏸', color: chalk.yellow };
    
    case 'no_push_mode':
      return { label: 'Stopped (no-push mode)', icon: '⏸', color: chalk.yellow };
    
    case 'committed_locally':
      return { label: 'Committed locally (not pushed)', icon: '📝', color: chalk.blue };
    
    case 'no_changes':
      return { label: 'No changes to commit', icon: '○', color: chalk.yellow };

    case 'no_verified_progress':
      return { label: 'No verified fixes (same issues failing)', icon: '⏹', color: chalk.yellow };

    case 'no_progress':
      return { label: 'No committable changes', icon: '🛑', color: chalk.red };
    
    case 'no_push_iterations':
      return { label: 'No push iterations run (config)', icon: '?', color: chalk.yellow };

    case 'error':
      return { label: 'Error', icon: '✗', color: chalk.red };

    case 'unknown':
      // Run was interrupted (e.g. Ctrl+C) or exited before the loop could set a reason.
      return { label: 'Interrupted or exited early', icon: '?', color: chalk.gray };

    default:
      return { label: exitReason || 'Unknown', icon: '?', color: chalk.gray };
  }
}

/** Exit reasons that indicate run failure (process should exit with code 1). */
export function isFailureExitReason(exitReason: string | null): boolean {
  return exitReason === 'error' || exitReason === 'init_failed' || exitReason === 'merge_conflicts' || exitReason === 'sync_failed';
}

/**
 * Print final results summary
 * WHY: Profiling info pushes important results off screen. This ensures
 * the most important info (what got fixed) is visible at the end.
 */
export function printFinalSummary(
  stateContext: StateContext | null,
  exitReason: string | null,
  exitDetails: string | null,
  remainingCount?: number
): void {
  if (!stateContext?.state) return;
  
  // Get counts — mutually exclusive: Fixed + Dismissed should not overlap.
  // Dismissed = truly dismissed only (exclude exhausted/remaining so count matches AAR Summary).
  const verifiedFixed = stateContext.state.verifiedFixed || [];
  const allDismissed = Dismissed.getDismissedIssues(stateContext);
  const allDismissedIds = new Set(allDismissed.map(d => d.commentId));
  const dismissedIssues = allDismissed.filter(d => d.category !== 'exhausted' && d.category !== 'remaining');
  // Do not count dismissed-as-already-fixed as "fixed and verified" (pill-output.md #2; AUDIT-CYCLES 33/34).
  const alreadyFixedDismissedIds = new Set(
    allDismissed.filter(d => d.category === 'already-fixed').map(d => d.commentId)
  );
  // Bound verifiedFixed against the current comment IDs; exclude any dismissed (including exhausted/remaining).
  const currentIds = stateContext.currentCommentIds;
  const relevantVerified = (currentIds
    ? verifiedFixed.filter(id => currentIds.has(id) && !allDismissedIds.has(id))
    : verifiedFixed.filter(id => !allDismissedIds.has(id))
  ).filter(id => !alreadyFixedDismissedIds.has(id));
  const toolFixedCount = relevantVerified.length;
  
  // Overlap detection: IDs in verifiedFixed that are also dismissed (including already-fixed).
  const overlapIds = verifiedFixed.filter(id => allDismissedIds.has(id));
  const alreadyFixedOverlap = verifiedFixed.filter(id => alreadyFixedDismissedIds.has(id));
  debug('RESULTS SUMMARY counts', {
    rawVerifiedFixed: verifiedFixed.length,
    allDismissed: allDismissed.length,
    dismissedExclExhaustedRemaining: dismissedIssues.length,
    alreadyFixedDismissed: alreadyFixedDismissedIds.size,
    currentCommentIds: currentIds?.size ?? 'all',
    overlapVerifiedAndDismissed: overlapIds.length,
    overlapVerifiedAndAlreadyFixed: alreadyFixedOverlap.length,
    relevantVerified: relevantVerified.length,
    toolFixedCount,
  });
  if (overlapIds.length > 0) {
    debug('Overlap IDs (verifiedFixed ∩ dismissed)', overlapIds);
  }
  // Pill #7: warn when verified set has accumulated many stale IDs (raw >> relevant or raw >> current PR size).
  if (
    currentIds &&
    currentIds.size > 0 &&
    verifiedFixed.length > 2 * currentIds.size
  ) {
    console.warn(
      chalk.yellow(
        `  ⚠ verifiedFixed (${formatNumber(verifiedFixed.length)}) is large vs current PR comments (${formatNumber(currentIds.size)}) — likely stale IDs; pruned at fetch when possible.`,
      ),
    );
  }
  if (verifiedFixed.length > 0 && relevantVerified.length > 0 && verifiedFixed.length >= 3 * relevantVerified.length) {
    console.warn(chalk.yellow(`  ⚠ verifiedFixed has ${formatNumber(verifiedFixed.length)} entries but only ${formatNumber(relevantVerified.length)} are relevant to current comments (stale IDs from previous iterations)`));
  }

  console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('                      RESULTS SUMMARY                         '));
  console.log(chalk.cyan('════════════════════════════════════════════════════════════'));

  const auditOverridesThisRun = stateContext.auditOverridesThisRun ?? [];

  if (overlapIds.length > 0) {
    const showOverlap = 20;
    const overlapSample = overlapIds.slice(0, showOverlap).join(', ');
    const more =
      overlapIds.length > showOverlap ? ` … (+${formatNumber(overlapIds.length - showOverlap)} more)` : '';
    console.warn(
      chalk.yellow(
        `  ⚠ verified ∩ dismissed still shows ${formatNumber(overlapIds.length)} ID(s) at summary time — unexpected. Overlap: ${overlapSample}${more}. Delete .pr-resolver-state.json in the clone workdir (see README Troubleshooting), then re-run.`,
      ),
    );
  }

  // Exit reason - most important info
  // WHEN no_changes but 0 remaining: we fixed everything in a previous iteration; show success.
  const effectiveReason = (exitReason === 'no_changes' && remainingCount === 0)
    ? 'all_fixed'
    : exitReason;
  const exitReasonDisplay = getExitReasonDisplay(effectiveReason);
  console.log(exitReasonDisplay.color(`\n  ${exitReasonDisplay.icon} Exit: ${exitReasonDisplay.label}`));
  if (exitDetails) {
    console.log(chalk.gray(`     ${exitDetails}`));
  }
  const successLikeExit =
    effectiveReason === 'all_fixed' ||
    effectiveReason === 'all_resolved' ||
    effectiveReason === 'audit_passed';
  if (successLikeExit && remainingCount !== undefined && remainingCount > 0) {
    console.log(
      chalk.gray(
        `     Note: Fix loop finished for all active threads. Remaining (${formatNumber(remainingCount)}) counts exhausted or “remaining” locations in state (deduped by file:line), not open fix-queue work.`,
      ),
    );
  }

  // Fixed issues (only count issues actually fixed by the tool, not pre-existing fixes)
  // Use verifiedThisSession (the actual Set of IDs verified during iteration loops)
  // instead of delta counting, which undercounts re-verifications of issues already
  // in verifiedFixed from git recovery.
  const fixedThisSession = stateContext.verifiedThisSession?.size ?? 0;

  if (toolFixedCount > 0) {
    let sessionNote = '';
    if (exitReason === 'merge_conflicts') {
      // Run stopped at base-merge; fixed count is from state/recovery only (no comment analysis this run).
      sessionNote = ' (from state; run stopped at base-merge)';
    } else if (fixedThisSession > 0 && fixedThisSession < toolFixedCount) {
      // Cycle 13 L1: Clarify that the total includes fixes from previous runs.
      sessionNote = ` (of which ${formatNumber(fixedThisSession)} this session)`;
    } else if (fixedThisSession === 0) {
      // Nothing verified this run — count is from state only (pill-output.md #2; AUDIT-CYCLES 33/34).
      sessionNote = ' (all from previous runs; 0 new this session)';
    }
    console.log(chalk.green(`\n  ✓ ${formatNumber(toolFixedCount)} issue${toolFixedCount === 1 ? '' : 's'} fixed and verified${sessionNote}`));
    if (overlapIds.length > 0 && fixedThisSession > 0 && fixedThisSession !== toolFixedCount) {
      console.log(chalk.gray(`     (${formatNumber(fixedThisSession)} verified this session; ${formatNumber(toolFixedCount)} relevant to current comments; some from earlier iterations were dismissed as file-unchanged or outdated.)`));
    }
  }
  
  // Dismissed issues by category
  if (dismissedIssues.length > 0) {
    const byCategory = dismissedIssues.reduce((acc, issue) => {
      acc[issue.category] = (acc[issue.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const categoryParts = Object.entries(byCategory)
      .map(([cat, count]) => `${formatNumber(count)} ${cat}`)
      .join(', ');
    
    console.log(chalk.gray(`  ○ ${formatNumber(dismissedIssues.length)} issue${dismissedIssues.length === 1 ? '' : 's'} dismissed (${categoryParts})`));
    const chronicCount = byCategory['chronic-failure'] ?? 0;
    if (chronicCount > 0) {
      console.log(chalk.cyan(`  ↳ ${formatNumber(chronicCount)} chronic-failure (auto-dismissed to save tokens)`));
    }
  }

  // Pill-output #407: surface UNCERTAIN vs truncation-guard counts in the summary (not only debug).
  const finalAuditUncertain = stateContext.finalAuditUncertainThisRun ?? [];
  if (finalAuditUncertain.length > 0) {
    const trunc = finalAuditUncertain.filter((u) => u.kind === 'truncation-guard').length;
    const unc = finalAuditUncertain.filter((u) => u.kind === 'uncertain').length;
    console.log(
      chalk.gray(
        `\n  ℹ Final audit non-affirming passes: ${formatNumber(finalAuditUncertain.length)} (${formatNumber(unc)} UNCERTAIN, ${formatNumber(trunc)} truncation guard)`,
      ),
    );
  }

  // Pill-output #18: keep final-audit re-queue count with other outcome lines (fixed / dismissed), not only above Exit.
  if (auditOverridesThisRun.length > 0) {
    console.log(
      chalk.cyan(
        `\n  ◆ Final audit re-queued: ${formatNumber(auditOverridesThisRun.length)} issue(s) (adversarial pass said UNFIXED for previously verified — see After Action Report)`,
      ),
    );
    console.log(
      chalk.gray(
        `     (This count is only threads that were verified then challenged by final audit — not the same as “Remaining” unless those were the only open issues.)`,
      ),
    );
    if (
      remainingCount !== undefined &&
      remainingCount > 0 &&
      remainingCount !== auditOverridesThisRun.length
    ) {
      console.log(
        chalk.gray(
          `     If Remaining below differs: re-queue is per thread id; Remaining dedupes by file:line and can include issues never verified this run.`,
        ),
      );
    }
  }

  // Remaining = unresolved + exhausted/chronic-failure (we gave up after repeated failures; they need human follow-up).
  if (remainingCount !== undefined) {
    if (remainingCount === 0) {
      console.log(chalk.green(`\n  ✓ No issues remaining`));
      if (exitReason === 'merge_conflicts') {
        // Avoid implying success: queue is empty but run stopped before main loop (AUDIT-CYCLES merge_conflicts audits).
        console.log(
          chalk.yellow(
            `  ⚠ Run blocked on base-merge: resolve the conflicted files above, then re-run PRR (review issues were not processed this run).`,
          ),
        );
      }
    } else {
      console.log(chalk.yellow(`\n  ○ Remaining: ${formatNumber(remainingCount)} (auto-stopped after repeated failures — resolve by fix or conversation)`));
      if (exitReason === 'merge_conflicts') {
        console.log(
          chalk.yellow(
            `  ⚠ Base-branch merge is still blocked — finish resolving conflicts before expecting PRR to work through the review backlog.`,
          ),
        );
      }
    }
  }

  // Pill #4: Warn about late-cycle comments (new comments added during fix cycle that weren't processed)
  const lateCycleComments = stateContext.state?.commentStatuses
    ? Object.values(stateContext.state.commentStatuses).filter(
        (status) => status?.status === 'open' && status?.explanation === 'New comment added during fix cycle'
      )
    : [];
  if (lateCycleComments.length > 0) {
    console.warn(
      chalk.yellow(
        `\n  ⚠ ${formatNumber(lateCycleComments.length)} unprocessed late-cycle comment${lateCycleComments.length === 1 ? '' : 's'}: new comment(s) added during fix cycle were not analyzed — re-run PRR to process them`,
      ),
    );
  }

  // Mid-run final audit re-opened these for re-verification (auditOverridesThisRun). Wording depends on end state (Cycle 64 M1).
  if (auditOverridesThisRun.length > 0) {
    const auditOverrides = auditOverridesThisRun;
    const relevantVerifiedSet = new Set(relevantVerified);
    const unrecovered = auditOverrides.filter((o) => !relevantVerifiedSet.has(o.commentId));
    if (remainingCount === undefined) {
      console.log(
        chalk.gray(
          `\n  ℹ Final audit re-opened ${formatNumber(auditOverrides.length)} issue(s) mid-run for re-verification (see log).`,
        ),
      );
    } else if (remainingCount === 0) {
      if (unrecovered.length === 0) {
        console.log(
          chalk.gray(
            `\n  ℹ Mid-run, final audit re-opened ${formatNumber(auditOverrides.length)} previously verified issue(s) for re-check; all were addressed before exit (see log).`,
          ),
        );
      } else {
        console.log(
          chalk.yellow(
            `\n  ⚠ Final audit re-opened ${formatNumber(auditOverrides.length)} issue(s); ${formatNumber(unrecovered.length)} ${unrecovered.length === 1 ? 'is' : 'are'} not in verified-fixed now — review dismissed/state if unexpected.`,
          ),
        );
      }
    } else {
      console.log(
        chalk.yellow(
          `\n  ⚠ ${formatNumber(auditOverrides.length)} issue(s) were re-opened by final audit for re-verification; see Remaining above (${formatNumber(remainingCount)}).`,
        ),
      );
      if (remainingCount !== auditOverrides.length) {
        console.log(
          chalk.gray(
            `     Re-queue count is per review thread (comment id). Remaining is unresolved issues plus exhausted threads deduped by file:line — some re-queued threads may verify or dismiss again, so the two numbers need not match.`,
          ),
        );
      }
    }
  }

  // When run in GitHub Actions, hint how to get logs
  if (process.env.GITHUB_ACTIONS === 'true') {
    const runId = process.env.GITHUB_RUN_ID;
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = process.env.PRR_PR_NUMBER;
    if (runId && repo) {
      const artifactName = prNumber ? `prr-logs-${prNumber}` : 'prr-logs-<PR>';
      console.log(chalk.gray(`\n  Tip: To share logs with an agent, download the run artifact: gh run download ${runId} --repo ${repo} --name ${artifactName}`));
    } else {
      console.log(chalk.gray(`\n  Tip: To share logs with an agent, download the workflow artifact (output.log, prompts.log) and point the agent at the files.`));
    }
  }

  console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
}

/**
 * Build markdown body for a formal Pull Request Review (so PRR shows in the Reviews section).
 * Mirrors the RESULTS SUMMARY counts; used when submitting the review via GitHub API.
 */
export function buildReviewSummaryMarkdown(
  stateContext: StateContext,
  exitReason: string,
  exitDetails: string | null,
  remainingCount: number
): string {
  const verifiedFixed = stateContext.state?.verifiedFixed || [];
  const allDismissed = Dismissed.getDismissedIssues(stateContext);
  const allDismissedIds = new Set(allDismissed.map(d => d.commentId));
  const dismissedIssues = allDismissed.filter(d => d.category !== 'exhausted' && d.category !== 'remaining');
  const alreadyFixedDismissedIds = new Set(
    allDismissed.filter(d => d.category === 'already-fixed').map(d => d.commentId)
  );
  const currentIds = stateContext.currentCommentIds;
  const relevantVerified = (currentIds
    ? verifiedFixed.filter(id => currentIds.has(id) && !allDismissedIds.has(id))
    : verifiedFixed.filter(id => !allDismissedIds.has(id))
  ).filter(id => !alreadyFixedDismissedIds.has(id));
  const toolFixedCount = relevantVerified.length;
  const fixedThisSession = stateContext.verifiedThisSession?.size ?? 0;

  const lines: string[] = ['## PRR run summary'];
  const auditOverridesMd = stateContext.auditOverridesThisRun ?? [];
  if (auditOverridesMd.length > 0) {
    lines.push(
      `**Final audit re-queues:** ${formatNumber(auditOverridesMd.length)} (adversarial pass said UNFIXED for previously verified issue(s); safe-over-sorry re-queue).`,
    );
  }
  if (exitDetails) lines.push(`**Exit:** ${exitDetails}`);
  if (exitReason === 'merge_conflicts') {
    lines.push(
      '- ⚠ Base-branch merge did not complete; resolve conflicts in the workdir and re-run PRR before tackling remaining review threads.',
    );
  }
  if (toolFixedCount > 0) {
    let note = '';
    if (fixedThisSession > 0 && fixedThisSession < toolFixedCount) note = ` (${formatNumber(fixedThisSession)} this run)`;
    else if (fixedThisSession === 0) note = ' (all from previous runs; 0 new this session)';
    lines.push(`- ✓ ${formatNumber(toolFixedCount)} issue(s) fixed and verified${note}`);
  }
  if (dismissedIssues.length > 0) {
    const byCategory = dismissedIssues.reduce((acc: Record<string, number>, issue) => {
      acc[issue.category] = (acc[issue.category] || 0) + 1;
      return acc;
    }, {});
    const catParts = Object.entries(byCategory).map(([c, n]) => `${formatNumber(n)} ${c}`).join(', ');
    lines.push(`- ○ ${formatNumber(dismissedIssues.length)} dismissed (${catParts})`);
  }
  if (remainingCount === 0) lines.push('- ✓ No issues remaining');
  else lines.push(`- ○ ${formatNumber(remainingCount)} remaining (resolve by fix or conversation)`);

  const auditOverrides = stateContext.auditOverridesThisRun ?? [];
  if (auditOverrides.length > 0) {
    const verifiedSet = new Set(relevantVerified);
    const unrecovered = auditOverrides.filter((o) => !verifiedSet.has(o.commentId));
    if (remainingCount === 0 && unrecovered.length === 0) {
      lines.push(`- ℹ All ${formatNumber(auditOverrides.length)} re-queued issue(s) were addressed again before exit.`);
    } else if (remainingCount > 0) {
      lines.push(
        `- ⚠ With ${formatNumber(remainingCount)} issue(s) still remaining, review threads above — final audit had re-opened ${formatNumber(auditOverrides.length)} previously verified issue(s).`,
      );
      if (remainingCount !== auditOverrides.length) {
        lines.push(
          `- ℹ Re-queue count is per thread; Remaining dedupes locations and can differ after re-verification or dismissal.`,
        );
      }
    } else {
      lines.push(
        `- ⚠ ${formatNumber(unrecovered.length)} of ${formatNumber(auditOverrides.length)} re-queued issue(s) not in verified-fixed — review dismissed/state.`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Print developer handoff prompt for remaining issues.
 * Remaining = unresolved + any legacy exhausted; resolve by fix, conversation, or other means.
 */
export function printHandoffPrompt(
  unresolvedIssues: UnresolvedIssue[],
  noHandoffPrompt: boolean,
  exhaustedIssues: DismissedIssue[] = [],
  exitReason: string | null = null,
  exitDetails: string | null = null
): void {
  const exhaustedDeduped = dedupeByLocation(exhaustedIssues);
  const grouped = groupUnresolvedForHandoff(unresolvedIssues);
  const displayedUnresolved = grouped.length;
  const total = displayedUnresolved + exhaustedDeduped.length;
  if (noHandoffPrompt || total === 0) return;

  if (exitReason === 'merge_conflicts') {
    console.log(chalk.yellow('\n┌─ BLOCKED: base-branch merge conflicts ─────────────────────────────────────┐'));
    console.log(chalk.yellow('│ Finish the merge in the workdir first, then re-run PRR.                       │'));
    console.log(chalk.yellow('│ Numbered items below are review backlog — not processed on this run.          │'));
    console.log(chalk.yellow('└──────────────────────────────────────────────────────────────────────────────┘'));
    if (exitDetails) {
      console.log(chalk.gray(`  ${exitDetails}`));
    }
  }

  console.log(chalk.cyan('\n┌─────────────────────────────────────────────────────────────┐'));
  console.log(chalk.cyan('│              DEVELOPER HANDOFF PROMPT                       │'));
  console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));
  console.log(chalk.gray('\nCopy this prompt to continue with a different tool:\n'));

  const formatIssueBlock = (index: number, path: string, line: number | null, body: string) => {
    console.log(chalk.white(`${index}. File: ${path}${line != null ? `:${line}` : ''}`));
    const cleanBody = sanitizeCommentForDisplay(body);
    const issueLines = cleanBody.split('\n');
    console.log(chalk.white(`   Issue: ${issueLines[0]}`));
    for (let j = 1; j < issueLines.length; j++) {
      if (issueLines[j].trim()) {
        console.log(chalk.white(`          ${issueLines[j]}`));
      }
    }
    console.log('');
  };

  console.log(chalk.white('─'.repeat(60)));
  const folded = unresolvedIssues.length - displayedUnresolved;
  let backlogIntro = `Remaining — resolve the following ${formatNumber(total)} code review issue(s) by fix, conversation, or other means`;
  if (folded > 0) {
    backlogIntro += ` (${formatNumber(displayedUnresolved)} topic group(s); folded ${formatNumber(folded)} near-duplicate thread(s) with the same file and heading)`;
  }
  console.log(chalk.white(`${backlogIntro}:\n`));
  let index = 1;
  for (const { rep, others } of grouped) {
    formatIssueBlock(index++, rep.comment.path, rep.comment.line ?? null, rep.comment.body);
    if (others.length > 0) {
      const lines = others.map((o) => formatNumber(o.comment.line ?? 0)).join(', ');
      console.log(chalk.gray(`   _Similar threads at lines: ${lines}_\n`));
    }
  }
  for (const d of exhaustedDeduped) {
    formatIssueBlock(index++, d.filePath, d.line, d.commentBody);
  }
  console.log(chalk.white('For each issue, make the necessary code changes to address'));
  console.log(chalk.white('the reviewer\'s concern while maintaining code quality and tests.'));
  console.log(chalk.white('─'.repeat(60)));
  console.log(chalk.gray('\n(Disable with --no-handoff-prompt)'));
}

/**
 * Suggest possible resolutions for an unresolved issue.
 * Prioritizes actionable, pattern-specific suggestions over generic boilerplate.
 */
function suggestResolutions(issue: UnresolvedIssue, stateContext?: StateContext | null): string[] {
  const resolutions: string[] = [];
  const body = issue.comment.body.toLowerCase();
  const path = issue.comment.path;
  const pathLower = path.toLowerCase();

  // --- Pattern 1: File corruption (multiple reviews about same file being broken) ---
  if (body.includes('corrupt') || body.includes('garbled') || body.includes('broken code')
    || body.includes('duplicate') && body.includes('method')
    || body.includes('orphaned') && body.includes('code')
    || body.includes('multiple automated fix attempts')) {
    resolutions.push(`Restore ${path} from the base branch: git show origin/dev:${path} > ${path}`);
    resolutions.push('The file may have been corrupted by previous automated fix attempts — a clean slate is faster than patching');
  }

  // --- Pattern 2: Test writing requests ---
  if (body.includes('test') && (body.includes('coverage') || body.includes('automated') || body.includes('unit'))) {
    resolutions.push('Write tests manually — LLMs struggle to generate working test suites without a running test harness');
    resolutions.push('Start with a single happy-path test, verify it runs, then expand to edge cases');
  }

  // --- Pattern 3: Multi-file consistency (duplication, shared imports) ---
  if (body.includes('duplicat') && (body.includes('import') || body.includes('shared') || body.includes('inline'))) {
    resolutions.push('Fix the shared module first, then update all import sites in a single commit');
  }

  // --- Pattern 4: Transaction / atomicity (word-boundary to avoid matching e.g. credit_transactions) ---
  if (/\btransaction\b/.test(body) || /\batomic\b/.test(body) || (body.includes('race') && body.includes('condition'))) {
    resolutions.push('Database transactions require understanding the ORM/driver — review the DB layer docs for this project');
    resolutions.push('Consider a compensating-action pattern if true transactions are not available');
  }

  // --- Pattern 4b: Metadata leakage / exposure ---
  if ((body.includes('metadata') || body.includes('leak') || body.includes('exposed') || body.includes('persisted')) && (body.includes('client') || body.includes('leak') || body.includes('redact') || body.includes('omit'))) {
    resolutions.push('Store only redacted/hashed data in metadata returned to the client, or omit sensitive fields and use server-side audit for reporting');
  }

  // --- Pattern 5: Dead code / unused variables ---
  if (body.includes('unused') || body.includes('dead code') || body.includes('never referenced')) {
    resolutions.push('Simple deletion — verify no other files import the symbol, then remove it');
  }

  // --- Pattern 5b: Vercel outputFileTracingIncludes / config not deployed ---
  if (body.includes('outputfiletracingincludes') || (body.includes('readfilesync') && body.includes('process.cwd') && body.includes('vercel'))) {
    resolutions.push('Add the config file path to outputFileTracingIncludes in next.config.ts so Vercel includes it in the deployment bundle');
  }

  // --- Pattern 6: Security / Redis / cache issues ---
  if (body.includes('redis') || (body.includes('cache') && body.includes('unavailable'))) {
    resolutions.push('Add an availability check at the entry point (return 503 early) rather than fixing downstream');
  }

  // --- Fallback: content-based ---
  if (resolutions.length === 0) {
    if (body.includes('error') || body.includes('exception')) {
      resolutions.push('Review error handling and add appropriate try-catch or fail-fast logic');
    } else if (body.includes('security') || body.includes('injection')) {
      resolutions.push('Review security implications and add input validation');
    } else {
      resolutions.push('Manually review the code and reviewer comment');
    }
  }

  // One generic fallback at most
  if (resolutions.length < 3) {
    resolutions.push('Break the issue into smaller, incremental changes');
  }

  return resolutions.slice(0, 4);
}

/**
 * Print after action report for remaining issues.
 * Provides analysis of what was attempted and possible resolutions.
 */
export async function printAfterActionReport(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  noAfterAction: boolean,
  stateContext: StateContext | null,
  lessonsContext: LessonsContext | null,
  exitReason: string | null = null,
  exitDetails: string | null = null
): Promise<void> {
  if (noAfterAction) return;

  // Compute fixed-this-session before the early return — we want the AAR
  // even when everything was fixed so the log has a record of what was done.
  const verifiedThisSession = stateContext?.verifiedThisSession ?? new Set<string>();
  const fixedThisSessionComments = comments.filter(c => verifiedThisSession.has(c.id));
  const dismissedIssuesForEarlyReturn = stateContext ? Dismissed.getDismissedIssues(stateContext) : [];
  const remainingLikeDismissed = dismissedIssuesForEarlyReturn.filter(d => d.category === 'exhausted' || d.category === 'remaining');

  if (unresolvedIssues.length === 0 && fixedThisSessionComments.length === 0 && remainingLikeDismissed.length === 0) return;
  
  console.log(chalk.cyan('\n┌─────────────────────────────────────────────────────────────┐'));
  console.log(chalk.cyan('│                 AFTER ACTION REPORT                         │'));
  console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));

  if (exitReason === 'merge_conflicts') {
    console.log(
      chalk.yellow(
        `\n  ⚠ Merge with the base branch did not complete — resolve conflicts in the workdir, commit, then re-run PRR.`,
      ),
    );
    if (exitDetails) {
      console.log(chalk.gray(`     ${exitDetails}`));
    }
    console.log(
      chalk.gray(
        `     Remaining-issue sections below are backlog from state (this run did not analyze PR comments).`,
      ),
    );
  }

  // --- Fixed this session ---
  if (fixedThisSessionComments.length > 0) {
    const prominent = fixedThisSessionComments.filter(
      (c) => !shouldSuppressFixedThisSessionDetail(c, stateContext),
    );
    const suppressed = fixedThisSessionComments.length - prominent.length;
    console.log(chalk.green(`\n━━━ Fixed This Session (${formatNumber(fixedThisSessionComments.length)}) ━━━`));
    for (const comment of prominent) {
      const preview = getFixedIssueTitle(sanitizeCommentForDisplay(comment.body));
      const truncated = preview.length > 100 ? preview.substring(0, 100) + '...' : preview;
      console.log(chalk.green(`  ✓ ${formatCommentLocation(comment)}`));
      console.log(chalk.gray(`    ${truncated}`));
    }
    if (suppressed > 0) {
      console.log(
        chalk.gray(
          `  … and ${formatNumber(suppressed)} duplicate or meta thread(s) verified this session (detail omitted).`,
        ),
      );
    }
  }

  // --- Remaining (unresolved + legacy exhausted/remaining) — resolve by fix, conversation, or other means ---
  const dismissedIssues = stateContext ? Dismissed.getDismissedIssues(stateContext) : [];
  const exhaustedList = dismissedIssues.filter(d => d.category === 'exhausted' || d.category === 'remaining');
  const exhaustedDeduped = dedupeByLocation(exhaustedList);
  const remainingTotal = unresolvedIssues.length + exhaustedDeduped.length;

  // --- Mid-run final audit re-opened (auditOverridesThisRun) — tone follows whether issues were recovered (Cycle 64 M1) ---
  const auditOverrides = stateContext?.auditOverridesThisRun ?? [];
  if (auditOverrides.length > 0 && stateContext?.state) {
    const verifiedFixed = stateContext.state.verifiedFixed || [];
    const allDismissedIds = new Set(dismissedIssues.map(d => d.commentId));
    const alreadyFixedDismissedIds = new Set(
      dismissedIssues.filter(d => d.category === 'already-fixed').map(d => d.commentId),
    );
    const currentIds = stateContext.currentCommentIds;
    const relevantVerifiedIds = (currentIds
      ? verifiedFixed.filter(id => currentIds.has(id) && !allDismissedIds.has(id))
      : verifiedFixed.filter(id => !allDismissedIds.has(id))
    ).filter(id => !alreadyFixedDismissedIds.has(id));
    const verifiedSet = new Set(relevantVerifiedIds);
    const unrecovered = auditOverrides.filter((o) => !verifiedSet.has(o.commentId));
    const recovered = unrecovered.length === 0;
    const headerColor = remainingTotal === 0 && recovered ? chalk.gray : chalk.yellow;
    console.log(
      headerColor(
        `\n━━━ Final audit re-check (${formatNumber(auditOverrides.length)}) — audit said UNFIXED for previously verified issue(s) ━━━`,
      ),
    );
    if (remainingTotal === 0 && recovered) {
      console.log(
        chalk.gray(`  All were addressed again before exit; details below are for the log trail.`),
      );
    } else if (remainingTotal > 0) {
      console.log(
        chalk.yellow(
          `  Some work may still be pending — see Remaining (${formatNumber(remainingTotal)}) below.`,
        ),
      );
    } else if (!recovered) {
      console.log(
        chalk.yellow(
          `  ${formatNumber(unrecovered.length)} re-opened issue(s) not in verified-fixed — review dismissed/state if unexpected.`,
        ),
      );
    }
    const lineColor = remainingTotal === 0 && recovered ? chalk.gray : chalk.yellow;
    for (const o of auditOverrides) {
      console.log(lineColor(`  ${remainingTotal === 0 && recovered ? '•' : '⚠'} ${o.path}:${o.line ?? '?'}`));
      if (o.explanation) console.log(chalk.gray(`    Audit said: ${o.explanation.slice(0, 120)}${o.explanation.length > 120 ? '…' : ''}`));
    }
  }
  const withVerifierReason = unresolvedIssues.filter(i => i.verifierContradiction);
  if (remainingTotal > 0) {
    console.log(chalk.yellow(`\n━━━ Remaining (${formatNumber(remainingTotal)}) — Resolve by fix, conversation, or other means ━━━`));
    if (exhaustedDeduped.length > 0) {
      console.log(chalk.gray(`  (Includes ${formatNumber(exhaustedDeduped.length)} issue(s) auto-stopped after repeated failures: verifier rejections or wrong-file edits)`));
    }
    if (withVerifierReason.length > 0) {
      console.log(chalk.gray(`  Why unresolved: Fixer and verifier disagreed — verifier checked the code and said the following for each issue below.`));
    }
  }
  for (let i = 0; i < unresolvedIssues.length; i++) {
    const issue = unresolvedIssues[i];
    const issueNum = i + 1;
    
    console.log(chalk.yellow(`\n  Issue ${formatNumber(issueNum)}/${formatNumber(remainingTotal)}: ${formatCommentLocation(issue.comment)}`));
    
    // Verifier's reason (why it's still not fixed) — most direct answer to "why couldn't it resolve"
    if (issue.verifierContradiction) {
      console.log(chalk.cyan('\n  ⚠ Verifier said (why still not fixed):'));
      const lines = issue.verifierContradiction.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t) console.log(chalk.yellow(`     ${t}`));
      }
    }
    
    // Original issue - sanitized for terminal readability
    console.log(chalk.cyan('\n  📝 Original Issue:'));
    const cleanIssue = sanitizeCommentForDisplay(issue.comment.body);
    for (const line of cleanIssue.split('\n')) {
      console.log(chalk.gray(`     ${line}`));
    }
    
    // Analysis / why it's hard
    // IMPORTANT: The batch verifier determined this issue still exists.
    // If the analysis below suggests the fix "may already be in place,"
    // that's a stale/inconsistent analysis — the verifier's verdict takes precedence.
    console.log(chalk.cyan('\n  🔍 Analysis:'));
    if (issue.explanation) {
      const contradictsVerifier = LOOKS_FIXED_REGEXES.some(r => r.test(issue.explanation || ''));
      if (contradictsVerifier) {
        console.log(chalk.yellow(`     ⚠ Note: Analysis below suggests fix may be in place, but verifier confirmed issue STILL EXISTS.`));
      }
      console.log(chalk.gray(`     ${issue.explanation}`));
    }
    
    // Check model performance for this file
    const fileModels = stateContext ? Performance.getModelsBySuccessRate(stateContext) : [];
    const relevantAttempts = fileModels.filter(m => m.stats.fixes > 0 || m.stats.failures > 0);
    if (relevantAttempts.length > 0) {
      // Show full runner/model keys (e.g., "cursor/gpt-5.2-codex-high-fast") not just runner name.
      // WHY: "cursor, cursor, cursor" tells you nothing; the model matters.
      console.log(chalk.gray(`     Models attempted: ${relevantAttempts.map(m => m.key).join(', ')}`));
    }
    
    // Learnings for this file only (exclude global so each issue doesn’t show the same long block)
    const fileOnlyLessons = lessonsContext ? LessonsAPI.Retrieve.getLessonsForFile(lessonsContext, issue.comment.path) : [];
    if (fileOnlyLessons.length > 0) {
      console.log(chalk.cyan('\n  📚 Relevant Learnings:'));
      for (const lesson of fileOnlyLessons.slice(0, 3)) {
        console.log(chalk.gray(`     • ${formatLessonForDisplay(lesson)}`));
      }
    }
    
    // Possible resolutions
    console.log(chalk.cyan('\n  💡 Possible Resolutions:'));
    const resolutions = suggestResolutions(issue, stateContext);
    for (const resolution of resolutions) {
      console.log(chalk.gray(`     • ${resolution}`));
    }
  }
  for (let j = 0; j < exhaustedDeduped.length; j++) {
    const d = exhaustedDeduped[j];
    const issueNum = unresolvedIssues.length + j + 1;
    console.log(chalk.yellow(`\n  Issue ${formatNumber(issueNum)}/${formatNumber(remainingTotal)}: ${d.filePath}:${d.line ?? '?'}`));
    console.log(chalk.cyan('\n  📝 Original Issue:'));
    for (const line of sanitizeCommentForDisplay(d.commentBody).split('\n')) {
      console.log(chalk.gray(`     ${line}`));
    }
    console.log(chalk.cyan('\n  🔍 Context:'));
    console.log(chalk.gray(`     ${d.reason}`));
    if (d.remediationHint) {
      console.log(chalk.cyan('\n  💡 Hint:'));
      console.log(chalk.gray(`     ${d.remediationHint}`));
    }
    const fakeIssueForResolutions: UnresolvedIssue = {
      comment: { id: d.commentId, threadId: '', path: d.filePath, line: d.line, body: d.commentBody, author: '', createdAt: '' },
      codeSnippet: '',
      stillExists: true,
      explanation: d.reason,
    };
    console.log(chalk.cyan('\n  💡 Possible Resolutions:'));
    for (const resolution of suggestResolutions(fakeIssueForResolutions, stateContext)) {
      console.log(chalk.gray(`     • ${resolution}`));
    }
  }

  // --- Dismissed issues (brief) — only truly dismissed, not remaining ---
  const trulyDismissed = dismissedIssues.filter(d => d.category !== 'exhausted' && d.category !== 'remaining');
  const dismissedIds = new Set(trulyDismissed.map(d => d.commentId));
  if (trulyDismissed.length > 0) {
    // Group by reason for a compact view
    const byReason = new Map<string, number>();
    for (const d of trulyDismissed) {
      const reason = d.category || 'unknown';
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
    const reasonSummary = [...byReason.entries()].map(([r, n]) => `${formatNumber(n)} ${r}`).join(', ');
    console.log(chalk.gray(`\n━━━ Dismissed (${formatNumber(trulyDismissed.length)}: ${reasonSummary}) ━━━`));
    const chronicInAar = byReason.get('chronic-failure') ?? 0;
    if (chronicInAar > 0) {
      console.log(chalk.cyan(`  ↳ ${formatNumber(chronicInAar)} chronic-failure (auto-dismissed to save tokens)`));
    }
    for (const d of trulyDismissed.slice(0, 10)) {
      const comment = comments.find(c => c.id === d.commentId);
      if (comment) {
        const preview = sanitizeCommentForDisplay(comment.body).split('\n')[0];
        const truncated = preview.length > 80 ? preview.substring(0, 80) + '...' : preview;
        console.log(chalk.gray(`  ○ ${formatCommentLocation(comment)} [${d.category}]`));
        if (d.remediationHint) {
          console.log(chalk.cyan(`    → ${d.remediationHint}`));
        }
        console.log(chalk.gray(`    ${truncated}`));
      }
    }
    if (trulyDismissed.length > 10) {
      console.log(chalk.gray(`  ... and ${formatNumber(trulyDismissed.length - 10)} more`));
    }
  }

  // Summary — Fixed, Dismissed, Remaining (union of distinct comment IDs across buckets vs fetched rows).
  console.log(chalk.cyan('\n━━━ Summary ━━━'));
  const fixedIds = new Set(
    comments
      .filter(c => stateContext ? Verification.isVerified(stateContext, c.id) && !dismissedIds.has(c.id) : false)
      .map(c => c.id)
  );
  const remainingIds = new Set(unresolvedIssues.map(i => i.comment.id));
  const fixedCount = fixedIds.size;
  const dismissedCount = dismissedIds.size;
  const remainingCount = unresolvedIssues.length + exhaustedDeduped.length;
  const fixedThisSessionCount = verifiedThisSession.size;
  const totalAccounted = new Set([...fixedIds, ...dismissedIds, ...remainingIds, ...exhaustedDeduped.map(d => d.commentId)]).size;
  const commentsFetched = comments.length;
  const fetchNote =
    commentsFetched === 0
      ? ' — no comments fetched this run; Fixed/Dismissed/Remaining below are from resolver state (cumulative across sessions).'
      : '';
  console.log(
    chalk.gray(
      `  PR comments loaded this run: ${formatNumber(commentsFetched)}${fetchNote}`,
    ),
  );
  console.log(
    chalk.gray(
      `  Buckets: Fixed ${formatNumber(fixedCount)}, Dismissed ${formatNumber(dismissedCount)}, Remaining ${formatNumber(remainingCount)}`,
    ),
  );
  if (totalAccounted !== comments.length) {
    console.log(
      chalk.gray(
        `  Distinct comment IDs in at least one bucket: ${formatNumber(totalAccounted)} (loaded: ${formatNumber(commentsFetched)})`,
      ),
    );
    console.log(
      chalk.gray(
        "  → Buckets can be larger if dismissed/remaining/exhausted reference IDs not in this run's fetch; smaller if many loaded comments are only outdated / out of queue.",
      ),
    );
  }
  console.log(chalk.green(`  Fixed: ${formatNumber(fixedCount)}${fixedThisSessionCount > 0 ? ` (${formatNumber(fixedThisSessionCount)} this session)` : ''}`));
  console.log(chalk.gray(`  Dismissed: ${formatNumber(dismissedCount)}`));
  console.log(chalk.yellow(`  Remaining: ${formatNumber(remainingCount)} (resolve by fix, conversation, or other means)`));
  
  console.log(chalk.gray('\n(Disable with --no-after-action)'));
}

/**
 * Print unresolved issues for dry run mode
 */
export function printUnresolvedIssues(issues: UnresolvedIssue[]): void {
  console.log(chalk.blue('\n=== Unresolved Issues (Dry Run) ===\n'));

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    console.log(chalk.yellow(`Issue ${i + 1}: ${formatCommentLocation(issue.comment)}`));
    console.log(chalk.gray('Comment:'), sanitizeCommentForDisplay(issue.comment.body).substring(0, 200));
    console.log(chalk.gray('Analysis:'), issue.explanation);
    console.log('');
  }
}
