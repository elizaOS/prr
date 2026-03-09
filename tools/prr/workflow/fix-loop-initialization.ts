/**
 * Fix loop initialization
 * 
 * Sets up the inner fix loop with:
 * 1. Tracking variables (fixIteration, allFixed, verifiedThisSession)
 * 2. Committed fixes tracking (prevents double-commit)
 * 3. Existing comment IDs (for detecting new bot reviews)
 */

/**
 * Initialize fix loop tracking state
 * 
 * TRACKING STATE:
 * - `fixIteration`: Current iteration number
 * - `allFixed`: Flag indicating all issues resolved
 * - `verifiedThisSession`: Set of comment IDs verified during this session
 * - `alreadyCommitted`: Set of comment IDs already committed
 * - `existingCommentIds`: Set of comment IDs at loop start (for new comment detection)
 * 
 * WHY separate tracking:
 * - verifiedThisSession: Filter already-fixed issues from subsequent iterations
 * - alreadyCommitted: Prevent double-committing the same fixes (Trap 3)
 * - existingCommentIds: Detect new bot reviews arriving during fix loop
 */
export interface FixLoopState {
  fixIteration: number;
  allFixed: boolean;
  verifiedThisSession: Set<string>;
  alreadyCommitted: Set<string>;
  existingCommentIds: Set<string>;
}

/**
 * Create initial fix loop state
 */
export function initializeFixLoop(commentIds: string[]): FixLoopState {
  return {
    fixIteration: 0,
    allFixed: false,
    // Track which items were verified THIS SESSION (not from previous runs)
    // WHY: findUnresolvedIssues already handles stale verifications correctly.
    // We only need to filter items that got verified DURING this fix loop.
    verifiedThisSession: new Set<string>(),
    // Track which fixes have already been committed (Trap 3)
    // WHY: verifiedThisSession accumulates across iterations. Without this,
    // we'd try to commit already-committed fixes on subsequent iterations.
    alreadyCommitted: new Set<string>(),
    // Track existing comment IDs to detect new ones
    existingCommentIds: new Set(commentIds),
  };
}
