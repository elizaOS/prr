/**
 * Re-export from shared so workflow/prompt-building and other tools keep stable import paths.
 */
export {
  deriveMaxFixPromptCharsFromContext,
  ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS,
  ELIZACLOUD_MODEL_CONTEXT,
  ELIZACLOUD_MODEL_ID_ALIASES,
  getElizaCloudModelContextSpec,
  getMaxElizacloudLlmCompleteInputChars,
  getMaxFixPromptCharsForModel,
  lowerModelMaxPromptChars,
  resolveElizaCloudCanonicalModelId,
  type ElizaCloudModelContextSpec,
} from '../../../shared/llm/model-context-limits.js';
