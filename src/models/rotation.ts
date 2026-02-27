/**
 * Model rotation and runner management logic.
 * Extracted from PRResolver to reduce file size and improve modularity.
 */
import chalk from 'chalk';
import type { Runner } from '../runners/types.js';
import { detectAvailableRunners, getRunnerByName, printRunnerSummary, DEFAULT_MODEL_ROTATIONS } from '../runners/index.js';
import type { StateContext } from '../state/state-context.js';
import * as Rotation from '../state/state-rotation.js';
import * as Bailout from '../state/state-bailout.js';
import type { CLIOptions } from '../cli.js';
import type { Config } from '../config.js';
import { warn, debug, formatNumber } from '../logger.js';
import { MAX_MODELS_PER_TOOL_ROUND } from '../constants.js';
import { fetchAvailableOpenAIModels, fetchAvailableAnthropicModels, fetchAvailableElizaCloudModels, probeElizaCloudModel } from '../llm/client.js';
import * as Performance from '../state/state-performance.js';

/**
 * Context for model rotation state
 */
export interface RotationContext {
  runner: Runner;
  runners: Runner[];
  currentRunnerIndex: number;
  modelIndices: Map<string, number>;
  modelFailuresInCycle: number;
  modelsTriedThisToolRound: number;
  progressThisCycle: number;
  recommendedModels?: string[];
  recommendedModelIndex: number;
  modelRecommendationReasoning?: string;
  /** Runners that actually executed an iteration this cycle.
   *  Needed because single-model runners (like llm-api) can't be
   *  distinguished as "never tried" vs "tried and stuck" by index alone. */
  runnersAttemptedInCycle: Set<string>;
  /** Runners disabled for this run due to tool_config (e.g. unknown option). Skip when rotating. */
  disabledRunners?: Set<string>;
  /** True when the only failures this cycle were 504/timeout (model never responded). Don't count as stalemate. */
  cycleHadOnlyTimeouts?: boolean;
  /** When set, rotation list is sorted by success rate (best first). WHY: Tries proven models before chronic low performers. */
  stateContext?: StateContext;
}

/**
 * Create a new rotation context
 */
export function createRotationContext(runner: Runner, runners: Runner[]): RotationContext {
  return {
    runner,
    runners,
    currentRunnerIndex: 0,
    modelIndices: new Map(),
    modelFailuresInCycle: 0,
    modelsTriedThisToolRound: 0,
    progressThisCycle: 0,
    recommendedModelIndex: 0,
    runnersAttemptedInCycle: new Set(),
    disabledRunners: new Set(),
  };
}

/**
 * Get the list of models available for a runner
 */
export function getModelsForRunner(runner: Runner | undefined): string[] {
  if (!runner) return [];
  // Use runner's own list if provided, otherwise use defaults
  return runner.supportedModels || DEFAULT_MODEL_ROTATIONS[runner.name] || [];
}

/**
 * Get models for runner, optionally sorted by success rate when stateContext is present.
 * WHY: Audit showed some models at ~1% success still cycled early in rotation. Using persisted
 * modelPerformance to order the list tries proven models first and deprioritizes chronic low performers.
 * Single-model runners or missing stateContext return the raw list unchanged.
 */
function getModelsForRunnerSorted(ctx: RotationContext): string[] {
  const raw = getModelsForRunner(ctx.runner);
  if (raw.length <= 1 || !ctx.stateContext) return raw;
  return Performance.sortRecommendedModelsByPerformance(raw, ctx.runner.name, ctx.stateContext);
}

/**
 * Get the current model for the active runner
 * Returns undefined if using CLI default or user-specified model
 * 
 * Smart model selection (default):
 * - Uses LLM-recommended models first (if available)
 * - Falls back to rotation when recommendations exhausted
 * 
 * Legacy rotation (--model-rotation):
 * - Uses DEFAULT_MODEL_ROTATIONS in order
 */
export function getCurrentModel(ctx: RotationContext, options: CLIOptions): string | undefined {
  // If user specified a model via CLI, always use that
  if (options.toolModel) {
    return options.toolModel;
  }
  
  // Smart model selection: use LLM recommendations first
  if (!options.modelRotation && ctx.recommendedModels?.length) {
    // Try current and subsequent recommendations to find one compatible with current runner
    for (let i = ctx.recommendedModelIndex; i < ctx.recommendedModels.length; i++) {
      const model = ctx.recommendedModels[i];
      if (model && isModelAvailableForRunner(ctx, model) && isModelProviderCompatible(ctx.runner, model)) {
        // Advance index to this position so advanceModel starts from here
        ctx.recommendedModelIndex = i;
        debug('Using LLM-recommended model', { model, runner: ctx.runner.name, index: i });
        return model;
      }
    }
    // No compatible recommendations found for this runner - fall through to rotation
    debug('No compatible recommended models for runner', { 
      runner: ctx.runner.name, 
      recommendations: ctx.recommendedModels,
    });
  }
  
  // Fall back to legacy rotation (sorted by success rate when stateContext set)
  const models = getModelsForRunnerSorted(ctx);
  if (models.length === 0) {
    return undefined;  // Let the tool use its default
  }
  
  const index = ctx.modelIndices.get(ctx.runner.name) || 0;
  // Bounds check: if persisted index exceeds model list (e.g., model was removed),
  // wrap back to 0 and update the stored index
  if (index >= models.length) {
    ctx.modelIndices.set(ctx.runner.name, 0);
    return models[0];
  }
  return models[index];
}

/**
 * Check if a model's provider is compatible with a runner.
 * 
 * WHY: Recommended models come from LLM batch analysis which may have been
 * done when a different runner was active. When the runner rotates (e.g., 
 * claude-code → codex), the recommendations may contain models from the
 * wrong provider (e.g., claude-sonnet for codex). This check prevents
 * sending Anthropic models to OpenAI-only tools and vice versa.
 */
function isModelProviderCompatible(runner: Runner, model: string): boolean {
  // Prefer runner.provider over RUNNER_PROVIDER_MAP when the runner sets it at runtime.
  // WHY: llm-api can be openai, anthropic, or elizacloud depending on which API key
  // is set. The map hardcodes llm-api as 'anthropic', so gpt-5.2 was rejected as
  // "no compatible recommended models" when only OPENAI_API_KEY was set.
  const runnerProvider = runner.provider ?? RUNNER_PROVIDER_MAP[runner.name];

  // No provider mapping = runner handles its own models (e.g., cursor) — allow anything
  if (!runnerProvider) return true;

  // Mixed-provider runners accept any model
  if (runnerProvider === 'mixed') return true;

  // ElizaCloud gateway accepts both OpenAI and Anthropic models (same as mixed).
  // WHY: When llm-api uses ELIZACLOUD_API_KEY, runner.provider is 'elizacloud';
  // without this, we compared modelProvider to 'elizacloud' and rejected every recommendation.
  if (runnerProvider === 'elizacloud') {
    const modelProvider = detectModelProvider(model, 'mixed');
    return modelProvider === 'openai' || modelProvider === 'anthropic' || modelProvider === null;
  }

  // Detect the model's provider from its name
  const modelProvider = detectModelProvider(model, runnerProvider);

  // Can't determine model provider — allow it (safe default, let the API reject)
  if (!modelProvider) return true;

  return modelProvider === runnerProvider;
}

/**
 * Check if a model is available for the current runner
 */
export function isModelAvailableForRunner(ctx: RotationContext, model: string): boolean {
  const available = getModelsForRunner(ctx.runner);
  const normalize = (m: string) => stripProviderPrefix(m.toLowerCase());
  const lowerModel = normalize(model);
  return available.some(m => {
    const lowerAvail = normalize(m);
    
    // Exact match
    if (lowerAvail === lowerModel) return true;
    
    // Family-based matching: extract family prefix (before first version/separator)
    const familyOf = (m: string) => m.split(/[-._\d]/)[0];
    const familyAvail = familyOf(lowerAvail);
    const familyModel = familyOf(lowerModel);
    
    if (familyAvail === familyModel && familyAvail.length > 0) {
      return (
        lowerAvail === lowerModel ||
        lowerAvail.startsWith(lowerModel + '-') ||
        lowerModel.startsWith(lowerAvail + '-') ||
        lowerAvail.startsWith(lowerModel + '/') ||
        lowerModel.startsWith(lowerAvail + '/')
      );
    // Review: designed for flexible model matching, accommodating provider prefixes.
    }
    
    return false;
  });
// Review: designed for flexible matching to accommodate model variations and user needs.
}

/**
 * Advance to next recommended model, or fall back to rotation
 * Returns true if we have more models to try
 */
export function advanceModel(ctx: RotationContext, stateContext: StateContext, options: CLIOptions): boolean {
  // If using smart selection and we have recommendations
  if (!options.modelRotation && ctx.recommendedModels?.length) {
    ctx.recommendedModelIndex++;
    
    // Still have recommendations to try?
    if (ctx.recommendedModelIndex < ctx.recommendedModels.length) {
      const nextModel = ctx.recommendedModels[ctx.recommendedModelIndex];
      const prevModel = ctx.recommendedModels[ctx.recommendedModelIndex - 1];
      console.log(chalk.yellow(`\n  🔄 Next recommended model: ${prevModel} → ${nextModel}`));
      return true;
    }
    
    // Exhausted recommendations, clear and fall back to rotation
    console.log(chalk.gray(`  Exhausted ${formatNumber(ctx.recommendedModels.length)} recommended models, falling back to rotation`));
    ctx.recommendedModels = undefined;
    ctx.recommendedModelIndex = 0;
  }
  
  // Fall back to legacy rotation
  return rotateModel(ctx, stateContext);
}

/**
 * Rotate to the next model for the current runner
 * Returns true if rotated to a new model, false if we've cycled through all
 */
export function rotateModel(ctx: RotationContext, stateContext: StateContext): boolean {
  const models = getModelsForRunnerSorted(ctx);
  if (models.length <= 1) {
    return false;  // No rotation possible
  }
  
  let currentIndex = ctx.modelIndices.get(ctx.runner.name) || 0;
  // Bounds check: if persisted index exceeds model list, wrap to 0
  if (currentIndex >= models.length) {
    currentIndex = 0;
    ctx.modelIndices.set(ctx.runner.name, 0);
  }
  const nextIndex = (currentIndex + 1) % models.length;
  
  // Check if we've completed a full cycle
  if (nextIndex === 0) {
    return false;  // Cycled through all models
  }
  
  const previousModel = models[currentIndex];
  const nextModel = models[nextIndex];
  ctx.modelIndices.set(ctx.runner.name, nextIndex);
  
  // Persist to state so we resume here if interrupted
  Rotation.setModelIndex(stateContext, ctx.runner.name, nextIndex);
  
  ctx.modelsTriedThisToolRound++;
  console.log(chalk.yellow(`\n  🔄 Rotating model: ${previousModel} → ${nextModel}`));
  return true;
}

/**
 * Switch to the next runner/tool
 * Does NOT reset model index - we continue where we left off when we come back
 * WHY: Interleaving tools is more effective than exhausting all models on one tool
 * Skips runners in ctx.disabledRunners (e.g. tool_config like unknown option)
 */
export function switchToNextRunner(ctx: RotationContext, stateContext: StateContext, options?: CLIOptions): boolean {
  if (ctx.runners.length <= 1) return false;

  const disabled = ctx.disabledRunners;
  const startIndex = ctx.currentRunnerIndex;
  let nextIndex = (ctx.currentRunnerIndex + 1) % ctx.runners.length;

  while (disabled?.has(ctx.runners[nextIndex].name)) {
    nextIndex = (nextIndex + 1) % ctx.runners.length;
    if (nextIndex === startIndex) return false; // All runners disabled
  }

  const previousRunner = ctx.runner.name;
  ctx.currentRunnerIndex = nextIndex;
  ctx.runner = ctx.runners[nextIndex];

  Rotation.setCurrentRunnerIndex(stateContext, ctx.currentRunnerIndex);
  ctx.modelsTriedThisToolRound = 0;

  const newModel = getCurrentModel(ctx, options ?? ({} as CLIOptions));
  const modelInfo = newModel ? ` (${newModel})` : '';
  console.log(chalk.yellow(`\n  🔄 Switching fixer: ${previousRunner} → ${ctx.runner.name}${modelInfo}`));
  return true;
// Review: passing options ensures consistent model selection with active CLI flags.
}

/**
 * Check if all tools have exhausted all their models
 * Disabled runners (tool_config) count as exhausted.
 */
export function allModelsExhausted(ctx: RotationContext): boolean {
  for (const runner of ctx.runners) {
    if (ctx.disabledRunners?.has(runner.name)) continue;
    const models = getModelsForRunner(runner);
    if (models.length <= 1) {
      if (!ctx.runnersAttemptedInCycle.has(runner.name)) return false;
      continue;
    }
    const currentIndex = ctx.modelIndices.get(runner.name) || 0;
    if (currentIndex < models.length - 1) return false;
  }
  return true;
}

/**
 * Try rotating - interleaves tools more aggressively
 * Strategy: Try MAX_MODELS_PER_TOOL_ROUND models on current tool, then switch tools
 * WHY: Different tools have different strengths; cycling through tools faster
 * gives each tool a chance before we exhaust all options on one tool
 * 
 * Returns false if we should bail out (too many cycles with no progress).
 */
export function tryRotation(
  ctx: RotationContext,
  stateContext: StateContext,
  options: CLIOptions
): boolean {
  // If current runner is disabled for this run (e.g. tool_config), switch away immediately
  while (ctx.disabledRunners?.has(ctx.runner.name)) {
    if (!switchToNextRunner(ctx, stateContext, options)) return false;
  }

  // The current runner just attempted an iteration (and failed),
  // so mark it as attempted for this cycle.
  ctx.runnersAttemptedInCycle.add(ctx.runner.name);

  // Track which tools we've fully exhausted (tried all models)
  const exhaustedTools = new Set<string>();
  
  // Check if current tool is exhausted
  const checkToolExhausted = (runnerName: string): boolean => {
    const runner = ctx.runners.find(r => r.name === runnerName);
    if (!runner) return true; // Unknown runner treated as exhausted
    const models = getModelsForRunner(runner);
    if (models.length <= 1) {
      // Single-model runners can't be distinguished by index alone
      // (index 0 means both "never tried" and "tried the only model").
      // Use runnersAttemptedInCycle to tell them apart.
      return ctx.runnersAttemptedInCycle.has(runnerName);
    }
    const currentIndex = ctx.modelIndices.get(runnerName) || 0;
    return currentIndex >= models.length - 1;  // On last model or beyond
  // Review: checks if exhausted; returning true safely avoids crashing on unknown runners.
  };

  // Helper: Check if we should bail out after completing a cycle
  const checkBailOut = (): boolean => {
    // A cycle just completed - check if we made progress
    if (ctx.progressThisCycle === 0) {
      // Don't count 504-only cycles as stalemate — model never had a chance to respond.
      if (ctx.cycleHadOnlyTimeouts) {
        debug('Cycle had only 504/timeouts — not counting as zero progress');
        console.log(chalk.gray('\n  ⏳ Cycle had only gateway timeouts — not counting as stalemate'));
        ctx.cycleHadOnlyTimeouts = false;
      } else {
        const cycles = Bailout.incrementNoProgressCycles(stateContext);
        console.log(chalk.yellow(`\n  ⚠️  Completed cycle ${cycles} with zero progress`));

        if (options.maxStaleCycles > 0 && cycles >= options.maxStaleCycles) {
          console.log(chalk.red(`\n  🛑 Bail-out triggered: ${cycles} cycles with no progress (max: ${options.maxStaleCycles})`));
          return true;  // Signal bail-out
        }
      }
    } else {
      // Made progress - reset counter
      Bailout.resetNoProgressCycles(stateContext);
      ctx.cycleHadOnlyTimeouts = false;
    }

    // Reset for next cycle
    ctx.progressThisCycle = 0;
    ctx.cycleHadOnlyTimeouts = undefined;
    return false;
  // Review: ensures tool switch only occurs after exhausting all model attempts within limits
  };
  
  // If we've tried enough models on this tool, switch to next tool
  if (ctx.modelsTriedThisToolRound >= MAX_MODELS_PER_TOOL_ROUND && ctx.runners.length > 1) {
    // Mark current tool if exhausted
    if (checkToolExhausted(ctx.runner.name)) {
      exhaustedTools.add(ctx.runner.name);
    }
    
    // Find a tool that has models left to try
    const startingRunner = ctx.currentRunnerIndex;
    let foundTool = false;
    
    do {
      switchToNextRunner(ctx, stateContext, options);
      
      // Check if this tool has more models to try
      if (!checkToolExhausted(ctx.runner.name)) {
        // Start with current model on the new tool (don't skip index 0)
        ctx.modelsTriedThisToolRound = 1;
        ctx.modelFailuresInCycle = 0;
        foundTool = true;
        break;
      } else {
        exhaustedTools.add(ctx.runner.name);
      }
    } while (ctx.currentRunnerIndex !== startingRunner && exhaustedTools.size < ctx.runners.length);
    
    if (foundTool) {
      return true;
    }
    
    // All tools exhausted - check bail-out before starting fresh round
    if (exhaustedTools.size >= ctx.runners.length) {
      if (checkBailOut()) {
        return false;  // Bail out - don't reset
      }
      
      console.log(chalk.yellow('\n  All tools exhausted their models, starting fresh round...'));
      for (const runner of ctx.runners) {
        ctx.modelIndices.set(runner.name, 0);
        Rotation.setModelIndex(stateContext, runner.name, 0);
      }
      ctx.modelsTriedThisToolRound = 0;
      ctx.runnersAttemptedInCycle.clear();
      return true;  // Will retry with first model on current tool
    }
    
    return false;
  }
  
  // Try next model within current tool (uses recommendations first if available)
  if (advanceModel(ctx, stateContext, options)) {
    ctx.modelFailuresInCycle = 0;
    return true;
  }
  
  // Current tool exhausted its models, try switching to another tool
  if (ctx.runners.length > 1) {
    const startingRunner = ctx.currentRunnerIndex;
    
    do {
      switchToNextRunner(ctx, stateContext, options);
      
      if (!checkToolExhausted(ctx.runner.name)) {
        // Start with current model on the new tool (don't skip index 0)
        ctx.modelsTriedThisToolRound = 1;
        ctx.modelFailuresInCycle = 0;
        return true;
      }
    } while (ctx.currentRunnerIndex !== startingRunner);
    
    // All tools exhausted - check bail-out before starting fresh round
    if (checkBailOut()) {
      return false;  // Bail out - don't reset
    }
    
    console.log(chalk.yellow('\n  All tools exhausted their models, starting fresh round...'));
    for (const runner of ctx.runners) {
      ctx.modelIndices.set(runner.name, 0);
      Rotation.setModelIndex(stateContext, runner.name, 0);
    }
    ctx.modelsTriedThisToolRound = 0;
    ctx.runnersAttemptedInCycle.clear();
    return true;
  }
  
  // Only one tool and it's exhausted - check bail-out before reset
  const models = getModelsForRunner(ctx.runner);
  if (models.length > 0) {
    if (checkBailOut()) {
      return false;  // Bail out - don't reset
    }
    
    console.log(chalk.yellow('\n  Tool exhausted, restarting model rotation...'));
    ctx.modelIndices.set(ctx.runner.name, 0);
    Rotation.setModelIndex(stateContext, ctx.runner.name, 0);
    ctx.modelsTriedThisToolRound = 0;
    ctx.runnersAttemptedInCycle.clear();
    return true;
  }
  
  return false;
}

/**
 * Reset the current runner's model index to 0 (first model in rotation).
 * Call at the start of each push iteration (when pushIteration > 1) so the first
 * fix attempt uses the best model instead of wherever the previous iteration left off.
 * WHY: Audit showed PI2 started with claude-3-opus (where PI1 ended) and 500'd immediately.
 */
export function resetCurrentModelToFirst(ctx: RotationContext, stateContext: StateContext): void {
  ctx.modelIndices.set(ctx.runner.name, 0);
  Rotation.setModelIndex(stateContext, ctx.runner.name, 0);
  debug('Reset model rotation to first for new push iteration', { runner: ctx.runner.name });
}

/**
 * Setup and detect available runners
 * Returns the primary runner to use
 */
/**
 * Which provider backs each runner's models.
 * 
 * - 'openai': Models validated against OpenAI GET /v1/models
 * - 'anthropic': Models validated against Anthropic GET /v1/models
 * - undefined: Runner manages its own models (cursor uses internal aliases)
 * 
 * NOTE: 'aider' uses provider-prefixed names like "openai/gpt-5.2" and
 * "anthropic/claude-sonnet-4-5-20250929". We detect the provider from
 * the prefix and validate against the corresponding API.
 */
const RUNNER_PROVIDER_MAP: Record<string, 'openai' | 'anthropic' | 'google' | 'mixed'> = {
  'elizacloud': 'mixed',      // Gateway to OpenAI + Anthropic + Google
  'codex': 'openai',
  'opencode': 'mixed',        // Has both OpenAI and Anthropic models
  'aider': 'mixed',           // Provider-prefixed: "openai/..." and "anthropic/..."
  'claude-code': 'anthropic',
  'llm-api': 'anthropic',
  // 'cursor' intentionally omitted - uses its own internal model aliases
  // 'gemini' intentionally omitted - uses Google's own model validation
};

/** Models to skip on ElizaCloud (500/timeout in practice). Audit: claude-3-opus 500'd on 4/5 calls including at 45k prompt. */
const ELIZACLOUD_SKIP_MODELS = new Set<string>([
  'openai/gpt-5.2-codex',
  'anthropic/claude-3-opus',
]);

/**
 * Determine which provider a model belongs to based on its name/prefix.
 * Returns the provider for validation against the corresponding API's model list.
 */
function detectModelProvider(model: string, runnerProvider: string): 'openai' | 'anthropic' | 'google' | null {
  // Explicit provider prefix (aider style)
  if (model.startsWith('openai/')) return 'openai';
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('google/')) return 'google';
  
  // Infer from model name patterns
  if (/^(gpt|o[34]|codex|davinci|babbage)/i.test(model)) return 'openai';
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^gemini/i.test(model)) return 'google';
  
  // Fall back to runner's default provider
  if (runnerProvider === 'openai' || runnerProvider === 'anthropic' || runnerProvider === 'google') return runnerProvider;
  
  return null; // Can't determine - skip validation for this model
// Review: designed to fallback to any known provider when model detection fails.
}

/**
 * Strip provider prefix from model name for API lookup.
 * "openai/gpt-5.3" -> "gpt-5.3", "anthropic/claude-sonnet-4-5" -> "claude-sonnet-4-5"
 */
function stripProviderPrefix(model: string): string {
  return model.replace(/^(openai|anthropic|google)\//, '');
}

/** Chat/completion-style OpenAI model ID prefix (exclude embeddings, whisper, etc.). */
const OPENAI_CHAT_PREFIX = /^(gpt-|o[1-9]|o4-)/i;

/**
 * Build rotation order from OpenAI model set. Prefer known strong/fast IDs first, then alphabetical.
 */
function buildRotationFromOpenAISet(ids: Set<string>): string[] {
  const list = Array.from(ids).filter(id => OPENAI_CHAT_PREFIX.test(id));
  const preferred = ['gpt-5.2', 'gpt-5.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4.1', 'gpt-5-mini'];
  const ordered: string[] = [];
  for (const id of preferred) {
    if (list.includes(id)) ordered.push(id);
  }
  for (const id of list.sort()) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * Build rotation order from Anthropic model set.
 * Filters out legacy claude-3 models (haiku/sonnet/opus without the 3.5+ suffix)
 * which have low output limits and poor code-fix performance.
 */
function buildRotationFromAnthropicSet(ids: Set<string>): string[] {
  return Array.from(ids)
    .filter(id => {
      if (!/^claude-/i.test(id)) return false;
      // Exclude legacy claude-3-* (not 3.5/3-5): low output limits, poor fix quality
      if (/^claude-3-(haiku|sonnet|opus)(?!.*3[.-]5)/i.test(id)) return false;
      return true;
    })
    .sort();
}

/**
 * Validate rotation models against provider APIs and remove unavailable ones.
 * 
 * WHY: Models like "gpt-5.3-codex" may not exist or may not be accessible
 * to the user's API key. Without validation, the fixer retries multiple times
 * per unavailable model (3-5 retries × connection timeout), wasting minutes.
 * 
 * Calls GET /v1/models on both OpenAI and Anthropic (if keys are present)
 * once at startup and prunes the rotation lists.
 * 
 * For llm-api with native OpenAI/Anthropic, rotation is built FROM the API list
 * (no hardcoded list to maintain).
 * 
 * Skips runners that manage their own models (cursor).
 * If an API call fails (bad key, network), models for that provider are kept as-is.
 */
export async function validateAndFilterModels(
  runners: Runner[],
  openaiApiKey?: string,
  anthropicApiKey?: string,
  elizacloudApiKey?: string
): Promise<{ removed: Array<{ runner: string; model: string }>}> {
  const removed: Array<{ runner: string; model: string }> = [];
  
  // Check which providers we need to validate
  const runnersToValidate = runners.filter(r => RUNNER_PROVIDER_MAP[r.name]);
  if (runnersToValidate.length === 0) {
    return { removed };
  }
  
  const hasLlMApi = runnersToValidate.some(r => r.name === 'elizacloud' || r.name === 'llm-api');
  const needsOpenAI = runnersToValidate.some(r => {
    const p = RUNNER_PROVIDER_MAP[r.name];
    return p === 'openai' || p === 'mixed';
  }) || (hasLlMApi && !!openaiApiKey); // llm-api may be using native OpenAI when only OPENAI_API_KEY set
  const needsAnthropic = runnersToValidate.some(r => {
    const p = RUNNER_PROVIDER_MAP[r.name];
    return p === 'anthropic' || p === 'mixed';
  }) || (hasLlMApi && !!anthropicApiKey);
  // 'elizacloud' is the preferred-tool alias; the actual runner is 'llm-api' (Direct LLM API)
  const needsElizaCloud = hasLlMApi;
  
  // Fetch available models from all providers in parallel
  console.log(chalk.gray('  Validating model access...'));
  
  const [openaiModels, anthropicModels, elizacloudModels] = await Promise.all([
    needsOpenAI && openaiApiKey
      ? fetchAvailableOpenAIModels(openaiApiKey)
      : Promise.resolve(new Set<string>()),
    needsAnthropic && anthropicApiKey
      ? fetchAvailableAnthropicModels(anthropicApiKey)
      : Promise.resolve(new Set<string>()),
    needsElizaCloud && elizacloudApiKey
      ? fetchAvailableElizaCloudModels(elizacloudApiKey)
      : Promise.resolve(new Set<string>()),
  ]);
  
  // Log what we got (debug only)
  if (openaiModels.size > 0) {
    debug(`Available OpenAI models (${openaiModels.size}):`, 
      Array.from(openaiModels).filter(m => 
        m.includes('gpt') || m.includes('codex') || m.includes('o3') || m.includes('o4')
      ).sort()
    );
  } else if (needsOpenAI && openaiApiKey) {
    console.log(chalk.yellow('  ⚠ Could not fetch OpenAI model list'));
  }
  
  if (anthropicModels.size > 0) {
    debug(`Available Anthropic models (${anthropicModels.size}):`,
      Array.from(anthropicModels).sort()
    );
  } else if (needsAnthropic && anthropicApiKey) {
    console.log(chalk.yellow('  ⚠ Could not fetch Anthropic model list'));
  }
  
  if (elizacloudModels.size > 0) {
    debug(`Available ElizaCloud models (${elizacloudModels.size}):`,
      Array.from(elizacloudModels).sort()
    );
  } else if (needsElizaCloud && elizacloudApiKey) {
    console.log(chalk.yellow('  ⚠ Could not fetch ElizaCloud model list'));
  }
  
  // If all fetches failed or returned empty, skip filtering entirely
  if (openaiModels.size === 0 && anthropicModels.size === 0 && elizacloudModels.size === 0) {
    console.log(chalk.yellow('  ⚠ No model lists available - skipping validation'));
    return { removed };
  }

  // Build llm-api rotation from provider model list when native OpenAI/Anthropic (no hardcoded lists)
  for (const runner of runnersToValidate) {
    if ((runner.name !== 'llm-api' && runner.name !== 'elizacloud') || !runner.provider) continue;
    if (runner.provider === 'openai') {
      runner.supportedModels = openaiModels.size > 0
        ? buildRotationFromOpenAISet(openaiModels)
        : ['gpt-4o', 'gpt-4o-mini']; // fallback when API list fails (e.g. network)
      debug(`llm-api (openai): built rotation from API (${runner.supportedModels.length} models)`);
    } else if (runner.provider === 'anthropic') {
      runner.supportedModels = anthropicModels.size > 0
        ? buildRotationFromAnthropicSet(anthropicModels)
        : ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']; // fallback when API list fails
      debug(`llm-api (anthropic): built rotation from API (${runner.supportedModels.length} models)`);
    }
  }
  
  // Validate each runner's rotation list (use runner.supportedModels when set, e.g. llm-api per-provider list)
  for (const runner of runnersToValidate) {
    const runnerProvider = RUNNER_PROVIDER_MAP[runner.name];
    if (!runnerProvider) continue;
    
    const models = runner.supportedModels ?? DEFAULT_MODEL_ROTATIONS[runner.name];
    if (!models || models.length === 0) continue;
    
    const validModels: string[] = [];
    const isLlMApi = runner.name === 'elizacloud' || runner.name === 'llm-api';
    const useElizaCloudForLlMApi = isLlMApi && models.some(m => m.includes('/'));

    for (const model of models) {
      // Eliza Cloud backend: validate against elizacloud set
      if (isLlMApi && useElizaCloudForLlMApi) {
        if (ELIZACLOUD_SKIP_MODELS.has(model)) {
          removed.push({ runner: runner.name, model });
          debug(`ElizaCloud: skipping ${model} (known timeout)`);
          continue;
        }
        if (elizacloudModels.size === 0) {
          validModels.push(model);
        } else if (elizacloudModels.has(model) || elizacloudModels.has(stripProviderPrefix(model))) {
          validModels.push(model);
        } else {
          removed.push({ runner: runner.name, model });
          debug(`Model "${model}" not found in available ElizaCloud models`);
        }
        continue;
      }
      // llm-api with list built from API (openai/anthropic): already from provider set, keep if in set
      if (isLlMApi && runner.provider && runner.provider !== 'elizacloud') {
        const available = runner.provider === 'openai' ? openaiModels : anthropicModels;
        if (available.has(model)) {
          validModels.push(model);
        } else {
          removed.push({ runner: runner.name, model });
        }
        continue;
      }
      
      const provider = detectModelProvider(model, runnerProvider);
      const lookupName = stripProviderPrefix(model);
      
      // Pick the right set to check against
      let available: Set<string>;
      if (provider === 'openai') {
        available = openaiModels;
      } else if (provider === 'anthropic') {
        available = anthropicModels;
      } else {
        // Can't determine provider - keep the model (safe default)
        validModels.push(model);
        continue;
      }
      
      // If we don't have the model list for this provider, keep the model
      if (available.size === 0) {
        validModels.push(model);
        continue;
      }
      
      if (available.has(lookupName)) {
        validModels.push(model);
      } else {
        removed.push({ runner: runner.name, model });
        debug(`Model "${model}" not found in available ${provider} models for ${runner.name}`);
      }
    }
    
    // Update the rotation list in-place (where it came from)
    if (validModels.length > 0 && validModels.length < models.length) {
      if (runner.supportedModels) {
        runner.supportedModels.length = 0;
        runner.supportedModels.push(...validModels);
      } else {
        DEFAULT_MODEL_ROTATIONS[runner.name] = validModels;
      }
    } else if (validModels.length === 0) {
      console.log(chalk.yellow(`  ⚠ No valid models found for ${runner.name} - keeping defaults`));
    }
  }
  
  // ElizaCloud "slow pool" probe: some models are listed but return "not available in the slow pool"
  // at request time. Probe the first model(s) and drop any that fail so we effectively default to a working one.
  if (elizacloudApiKey && elizacloudModels.size > 0) {
    for (const runner of runnersToValidate) {
      if ((runner.name !== 'llm-api' && runner.name !== 'elizacloud') || runner.provider !== 'elizacloud') continue;
      const source = runner.supportedModels ?? DEFAULT_MODEL_ROTATIONS[runner.name];
      if (!source || source.length === 0 || !source.some(m => m.includes('/'))) continue;
      const list = [...source];
      const maxProbes = 3;
      let probed = 0;
      while (list.length > 0 && probed < maxProbes) {
        const model = list[0];
        const result = await probeElizaCloudModel(elizacloudApiKey, model);
        if (result === 'ok') break;
        if (result === 'slow_pool') {
          removed.push({ runner: runner.name, model });
          list.shift();
          console.log(chalk.yellow(`  Model ${model} not in slow pool — removed from rotation; using next.`));
        } else {
          break; // network/auth etc — keep list as-is
        }
        probed++;
      }
      if (list.length !== source.length) {
        runner.supportedModels = list;
      }
    }
  }

  // Report what we removed
  if (removed.length > 0) {
    console.log(chalk.yellow(`  Removed ${removed.length.toLocaleString()} unavailable model(s):`));
    for (const { runner, model } of removed) {
      console.log(chalk.yellow(`    ✗ ${runner}: ${model}`));
    }
  } else {
    console.log(chalk.green(`  ✓ All rotation models are available`));
  }
  
  return { removed };
}

export async function setupRunner(
  options: CLIOptions,
  config: Config
): Promise<{ primary: Runner; all: Runner[] }> {
  // Auto-detect all available and ready runners
  const detected = await detectAvailableRunners(options.verbose);

  if (detected.length === 0) {
    throw new Error('No fix tools available! Install one of: cursor, claude-code, aider, opencode, codex, llm-api, gemini');
  }

  // Print summary
  printRunnerSummary(detected);
  
  // ElizaCloud promotional banner (only in normal mode, not utility commands)
  if (!options.checkTools && !options.tidyLessons && !process.env.ELIZACLOUD_API_KEY) {
    console.log(chalk.dim('  Tip: Get one API key for all models (Claude, GPT, Gemini) → https://elizacloud.ai\n'));
  }

  // Validate model rotation lists against provider APIs
  // WHY: Remove models the user doesn't have access to BEFORE any fixer runs,
  // instead of discovering them one-by-one through failed retries
  const allDetectedRunners = detected.map(d => d.runner);
  await validateAndFilterModels(allDetectedRunners, config.openaiApiKey, config.anthropicApiKey, config.elizacloudApiKey);

  // Find preferred runner: CLI option > PRR_TOOL env var > auto (first available)
  let primaryRunner: Runner;
  
  // Determine which tool to use: CLI option takes precedence, then config (PRR_TOOL env var)
  // 'auto' or undefined means use first available tool
  const preferredTool = options.tool || config.defaultTool;
  const isAutoSelect = !preferredTool || preferredTool === 'auto';

  if (!isAutoSelect) {
    // 'elizacloud' is an alias for the llm-api runner (Direct LLM API with ElizaCloud backend)
    const preferred = detected.find(d =>
      d.runner.name === preferredTool || (preferredTool === 'elizacloud' && d.runner.name === 'llm-api')
    );
    if (preferred) {
      primaryRunner = preferred.runner;
    } else {
      // Check if it exists but isn't ready
      const runner = getRunnerByName(preferredTool);
      if (runner) {
        const status = await runner.checkStatus();
        if (status.installed && !status.ready) {
          warn(`${runner.displayName} is installed but not ready: ${status.error}`);
        } else {
          warn(`${preferredTool} not available, using ${detected[0].runner.displayName}`);
        }
      }
      primaryRunner = detected[0].runner;
    }
  } else {
    // Auto-select: use first available tool
    primaryRunner = detected[0].runner;
  }

  // Build list of all ready runners for rotation
  const allRunners = detected.map(d => d.runner);

  // Move primary to front
  const primaryIndex = allRunners.findIndex(r => r.name === primaryRunner.name);
  if (primaryIndex > 0) {
    allRunners.splice(primaryIndex, 1);
    allRunners.unshift(primaryRunner);
  }

  // Show info
  const primaryModels = getModelsForRunner(primaryRunner);
  const initialModel = options.toolModel || primaryModels[0];

  console.log(chalk.cyan(`\nPrimary fixer: ${primaryRunner.displayName}`));
  if (initialModel) {
    console.log(chalk.gray(`  Starting model: ${initialModel}`));
  }
  if (primaryModels.length > 1 && !options.toolModel) {
    console.log(chalk.gray(`  Model rotation: ${primaryModels.join(' → ')}`));
  }
  if (allRunners.length > 1) {
    console.log(chalk.gray(`  Tool rotation: ${allRunners.map(r => r.displayName).join(' → ')}`));
  }

  return { primary: primaryRunner, all: allRunners };
}

/**
 * Set recommended models for smart selection
 */
export function setRecommendedModels(
  ctx: RotationContext,
  models: string[],
  reasoning?: string
): void {
  ctx.recommendedModels = models;
  ctx.recommendedModelIndex = 0;
  ctx.modelRecommendationReasoning = reasoning;
}

/**
 * Record progress in current cycle
 */
export function recordProgress(ctx: RotationContext): void {
  ctx.progressThisCycle++;
  if (ctx.cycleHadOnlyTimeouts !== undefined) {
    ctx.cycleHadOnlyTimeouts = false;
  }
}

/**
 * Reset progress counter for new cycle
 */
export function resetProgress(ctx: RotationContext): void {
  ctx.progressThisCycle = 0;
  ctx.cycleHadOnlyTimeouts = undefined;
}

/**
 * Increment model failures counter
 */
export function incrementModelFailures(ctx: RotationContext): void {
  ctx.modelFailuresInCycle++;
}

/**
 * Reset model failures counter
 */
export function resetModelFailures(ctx: RotationContext): void {
  ctx.modelFailuresInCycle = 0;
}
