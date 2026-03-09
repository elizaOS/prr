/**
 * Issue priority and sorting utilities
 * 
 * Provides sort functions to order UnresolvedIssue arrays by importance,
 * ease of fix, or chronological order.
 */

import type { UnresolvedIssue, IssueTriage } from './types.js';

/**
 * Issue processing order options for --priority-order CLI flag.
 * 
 * WHY so many options: Different strategies work for different scenarios:
 * - "important": Tackle critical issues first (security, major bugs)
 * - "easy": Quick wins first to show progress and build confidence
 * - "newest": Address recent feedback first (shows responsiveness)
 * - "oldest": FIFO queue discipline
 * - "none": GitHub's default order (essentially random by thread creation)
 */
export type PriorityOrder =
  | 'important'      // Most important first (1=critical first)
  | 'important-asc'  // Least important first (5=trivial first)
  | 'easy'           // Easiest fixes first (1=one-liner first)
  | 'easy-asc'       // Hardest fixes first (5=refactor first)
  | 'newest'         // Newest comments first
  | 'oldest'         // Oldest comments first (GitHub default)
  | 'none';          // No sorting (preserve input order)

/**
 * Default triage scores when LLM analysis didn't provide them.
 * 
 * WHY 3 (middle) not 5 (worst): Issues without triage come from recovery paths
 * (audit failures, new comments mid-cycle) and shouldn't be deprioritized.
 * They go in the middle of the pack by default.
 */
export const DEFAULT_TRIAGE: IssueTriage = { importance: 3, ease: 3 };

/**
 * True when the issue has a usable code snippet for the fix prompt.
 *
 * WHY used as a tie-break: When the batch is capped by prompt size, the builder
 * takes the first N issues from the sorted array. Issues with a valid snippet
 * produce a "Current Code:" block in the prompt which is the fixer's primary
 * reference for applying search/replace. Placing snippet-bearing issues first
 * means that when we can only fit N issues, we prefer the ones where the fixer
 * has actual code context rather than having to guess from the comment alone.
 */
function hasValidSnippet(issue: UnresolvedIssue): boolean {
  return !!(
    issue.codeSnippet &&
    issue.codeSnippet.length > 0 &&
    !issue.codeSnippet.startsWith('(file not found')
  );
}

/**
 * Sort issues by the specified priority order.
 * 
 * CRITICAL: Returns a NEW array, NEVER mutates the input.
 * 
 * WHY never mutate: The unresolvedIssues array is shared state used by:
 * - Fix iteration loop
 * - No-changes verification
 * - Single-issue focus mode (which intentionally randomizes)
 * If we mutated here, single-issue randomization and priority sort would
 * fight each other on alternate iterations.
 * 
 * @param issues Input array (never modified)
 * @param order Sort order
 * @returns New sorted array
 */
export function sortByPriority(issues: UnresolvedIssue[], order: PriorityOrder): UnresolvedIssue[] {
  if (order === 'none') return [...issues];
  
  const sorted = [...issues]; // Clone to avoid mutating input
  
  sorted.sort((a, b) => {
    let primary: number;
    switch (order) {
      case 'important':
        primary = (a.triage?.importance ?? 3) - (b.triage?.importance ?? 3);
        break;
      case 'important-asc':
        primary = (b.triage?.importance ?? 3) - (a.triage?.importance ?? 3);
        break;
      case 'easy':
        primary = (a.triage?.ease ?? 3) - (b.triage?.ease ?? 3);
        break;
      case 'easy-asc':
        primary = (b.triage?.ease ?? 3) - (a.triage?.ease ?? 3);
        break;
      case 'newest':
        primary = new Date(b.comment.createdAt).getTime() - new Date(a.comment.createdAt).getTime();
        break;
      case 'oldest':
        primary = new Date(a.comment.createdAt).getTime() - new Date(b.comment.createdAt).getTime();
        break;
      default:
        primary = 0;
    }
    if (primary !== 0) return primary;
    // Prefer issues that have verifier feedback so they stay in the batch and their file gets injected (audit: 1&2 dropped when batch was capped).
    const aHasFeedback = !!(a.verifierContradiction || (a.verifierFeedbackHistory?.length ?? 0) > 0);
    const bHasFeedback = !!(b.verifierContradiction || (b.verifierFeedbackHistory?.length ?? 0) > 0);
    if (aHasFeedback !== bHasFeedback) return aHasFeedback ? -1 : 1;
    // Tie-break: prefer issues with valid code snippet so capped batches keep Current Code blocks (audit).
    return (hasValidSnippet(b) ? 1 : 0) - (hasValidSnippet(a) ? 1 : 0);
  });
  
  return sorted;
}
