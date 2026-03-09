/**
 * Re-export from shared so workflow/prompt-building and other src consumers keep working.
 */
export { getMaxFixPromptCharsForModel, lowerModelMaxPromptChars } from '../../../shared/llm/model-context-limits.js';
