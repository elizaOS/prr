/**
 * Re-export from shared so workflow/prompt-building and other tools keep stable import paths.
 */
export {
  deriveMaxFixPromptCharsFromContext,
  ELIZACLOUD_MODEL_CONTEXT,
  ELIZACLOUD_MODEL_ID_ALIASES,
  getElizaCloudModelContextSpec,
  getMaxFixPromptCharsForModel,
  lowerModelMaxPromptChars,
  resolveElizaCloudCanonicalModelId,
  type ElizaCloudModelContextSpec,
} from '../../../shared/llm/model-context-limits.js';
