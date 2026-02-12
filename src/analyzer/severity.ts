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
  if (order === 'none') return issues;
  
  const sorted = [...issues]; // Clone to avoid mutating input
  
  sorted.sort((a, b) => {
    switch (order) {
      case 'important':
        // Lower importance score = higher priority (1=critical comes first)
        return (a.triage?.importance ?? 3) - (b.triage?.importance ?? 3);
      
      case 'important-asc':
        // Higher importance score = higher priority (5=trivial comes first)
        return (b.triage?.importance ?? 3) - (a.triage?.importance ?? 3);
      
      case 'easy':
        // Lower ease score = higher priority (1=easy fix comes first)
        return (a.triage?.ease ?? 3) - (b.triage?.ease ?? 3);
      
      case 'easy-asc':
        // Higher ease score = higher priority (5=hard fix comes first)
        return (b.triage?.ease ?? 3) - (a.triage?.ease ?? 3);
      
      case 'newest':
        // Newer comments first
        return new Date(b.comment.createdAt).getTime() - new Date(a.comment.createdAt).getTime();
      
      case 'oldest':
        // Older comments first (GitHub's default behavior)
        return new Date(a.comment.createdAt).getTime() - new Date(b.comment.createdAt).getTime();
      
      default:
        return 0;
    }
  });
  
  return sorted;
}
