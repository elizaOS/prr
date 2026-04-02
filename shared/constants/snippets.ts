// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CODE SNIPPETS & CONTEXT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Lines of context before the issue line in code snippets (for getCodeSnippet).
 * WHY 20: Review bots reference ranges (e.g. "lines 52-93"); 5 lines before was too narrow
 * and often missed imports/class context. 20 captures surrounding scope without bloating the prompt.
 */
export const CODE_SNIPPET_CONTEXT_BEFORE = 20;

/**
 * Lines of context after the issue line in code snippets (for getCodeSnippet).
 * WHY 30: Comments often point at the start of a block; 10 lines after missed the rest of
 * the function or block. 30 covers typical method/block length while staying under snippet cap.
 */
export const CODE_SNIPPET_CONTEXT_AFTER = 30;

/**
 * Default line range when only start line is provided (for bugbot comments).
 */
export const DEFAULT_LINE_RANGE_SIZE = 20;
