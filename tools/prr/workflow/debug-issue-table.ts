import chalk from 'chalk';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as CommentStatusAPI from '../state/state-comment-status.js';
import { formatNumber } from '../../../shared/logger.js';

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)) + '...';
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width, ' ');
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

function buildRow(
  index: number,
  comment: ReviewComment,
  statusLabel: string,
  reason: string,
): string {
  const location = `${comment.path}:${comment.line ?? '?'}`;
  const summary = firstLine(comment.body ?? '');
  return [
    pad(String(index + 1), 4),
    pad(comment.id.slice(0, 10), 12),
    pad(location, 42),
    pad(statusLabel, 20),
    pad(reason, 72),
    pad(summary, 76),
  ].join(' ');
}

/**
 * Print PRR's current per-comment decision table.
 *
 * WHY this exists: Aggregate counts ("3 open, 12 fixed") are not enough when
 * the operator is comparing PRR's state with a GitHub PR that still shows many
 * open threads. This table makes the exact decision for each comment visible.
 *
 * WHY the status precedence matters: "dismissed/already-fixed" is more specific
 * than generic "verified". Showing the more specific category helps audits trace
 * which comments PRR actively decided to dismiss versus comments it truly fixed
 * and verified in the normal loop.
 */
export function printDebugIssueTable(
  stage: string,
  comments: ReviewComment[],
  stateContext: StateContext,
  unresolvedIssues: UnresolvedIssue[] = [],
): void {
  const unresolvedById = new Map(unresolvedIssues.map((issue) => [issue.comment.id, issue]));
  const counts = new Map<string, number>();
  const rows: string[] = [];

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    let statusLabel = 'unseen';
    let reason = '';

    if (comment.outdated) {
      statusLabel = 'outdated';
      reason = 'GitHub marked this thread outdated';
    } else if (unresolvedById.has(comment.id)) {
      const issue = unresolvedById.get(comment.id)!;
      statusLabel = 'open';
      reason = issue.explanation || 'Issue remains unresolved';
    } else {
      const dismissed = Dismissed.getDismissedIssue(stateContext, comment.id);
      if (dismissed) {
        statusLabel = `dismissed/${dismissed.category}`;
        reason = dismissed.reason;
      } else if (Verification.isVerified(stateContext, comment.id)) {
        statusLabel = 'verified';
        const status = CommentStatusAPI.getStatus(stateContext, comment.id);
        reason = status?.explanation ?? 'Marked verified';
      } else {
        const status = CommentStatusAPI.getStatus(stateContext, comment.id);
        if (status) {
          statusLabel = `${status.status}/${status.classification}`;
          reason = status.explanation;
        }
      }
    }

    counts.set(statusLabel, (counts.get(statusLabel) ?? 0) + 1);
    rows.push(buildRow(i, comment, statusLabel, reason));
  }

  const summary = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label}=${formatNumber(count)}`)
    .join(', ');

  console.log(chalk.gray(`\nDebug issue table (${stage})`));
  console.log(chalk.gray(`  Counts: ${summary || 'none'}`));
  console.log(chalk.gray(
    [
      pad('#', 4),
      pad('id', 12),
      pad('location', 42),
      pad('status', 20),
      pad('reason', 72),
      pad('comment', 76),
    ].join(' ')
  ));
  console.log(chalk.gray('-'.repeat(4 + 1 + 12 + 1 + 42 + 1 + 20 + 1 + 72 + 1 + 76)));
  for (const row of rows) {
    console.log(chalk.gray(row));
  }
}
