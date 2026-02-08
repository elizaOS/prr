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
import { warn } from '../logger.js';
import { MAX_MODELS_PER_TOOL_ROUND } from '../constants.js';

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
    const model = ctx.recommendedModels[ctx.recommendedModelIndex];
    if (model && isModelAvailableForRunner(ctx, model)) {
      return model;
    }
  }
  
  // Fall back to legacy rotation
  const models = getModelsForRunner(ctx.runner);
  if (models.length === 0) {
    return undefined;  // Let the tool use its default
  }
  
  const index = ctx.modelIndices.get(ctx.runner.name) || 0;
  return models[index];
}

/**
 * Check if a model is available for the current runner
 */
export function isModelAvailableForRunner(ctx: RotationContext, model: string): boolean {
  const available = getModelsForRunner(ctx.runner);
  const lowerModel = model.toLowerCase();
  return available.some(m => {
    const lowerAvail = m.toLowerCase();
    
    // Exact match
    if (lowerAvail === lowerModel) return true;
    
    // Family-based matching: extract family token (before first - or .)
    const familyAvail = lowerAvail.split(/[-.]/, 1)[0];
    const familyModel = lowerModel.split(/[-.]/, 1)[0];
    
    // Accept if same family and one is a proper variant of the other
    if (familyAvail === familyModel) {
      // Only match if they share the same model family prefix (up to first version segment)
      const familyOf = (m: string) => m.split(/[-._\d]/)[0];
      const familyAvail = familyOf(lowerAvail);
      const familyModel = familyOf(lowerModel);
      return familyAvail === familyModel && familyAvail.length > 0 &&
        (lowerAvail === lowerModel || (familyAvail === familyModel && (lowerAvail.startsWith(lowerModel + '-') || lowerModel.startsWith(lowerAvail + '-'))));
    }
    
    return false;
  });
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
    console.log(chalk.gray(`  Exhausted ${ctx.recommendedModels.length} recommended models, falling back to rotation`));
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
  const models = getModelsForRunner(ctx.runner);
  if (models.length <= 1) {
    return false;  // No rotation possible
  }
  
  const currentIndex = ctx.modelIndices.get(ctx.runner.name) || 0;
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
 */
export function switchToNextRunner(ctx: RotationContext, stateContext: StateContext, options?: CLIOptions): boolean {
  if (ctx.runners.length <= 1) return false;
  
  const previousRunner = ctx.runner.name;
  ctx.currentRunnerIndex = (ctx.currentRunnerIndex + 1) % ctx.runners.length;
  ctx.runner = ctx.runners[ctx.currentRunnerIndex];
  
  // Persist runner index so we resume here if interrupted
  Rotation.setCurrentRunnerIndex(stateContext, ctx.currentRunnerIndex);
  
  // Reset the per-tool-round counter, but DON'T reset model index
  // We'll continue from where we left off on this tool
  ctx.modelsTriedThisToolRound = 0;
  
  const newModel = getCurrentModel(ctx, { toolModel: undefined, modelRotation: false } as Partial<CLIOptions> as CLIOptions);
  const modelInfo = newModel ? ` (${newModel})` : '';
  console.log(chalk.yellow(`\n  🔄 Switching fixer: ${previousRunner} → ${ctx.runner.name}${modelInfo}`));
  return true;
}

/**
 * Check if all tools have exhausted all their models
 */
export function allModelsExhausted(ctx: RotationContext): boolean {
  for (const runner of ctx.runners) {
    const models = getModelsForRunner(runner);
    const currentIndex = ctx.modelIndices.get(runner.name) || 0;
    // If any runner has models left to try, we're not exhausted
    if (currentIndex < models.length - 1) {
      return false;
    }
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
  // Track which tools we've fully exhausted (tried all models)
  const exhaustedTools = new Set<string>();
  
  // Check if current tool is exhausted
  const checkToolExhausted = (runnerName: string): boolean => {
    const runner = ctx.runners.find(r => r.name === runnerName);
    if (!runner) return true; // Unknown runner treated as exhausted
    const models = getModelsForRunner(runner);
    const currentIndex = ctx.modelIndices.get(runnerName) || 0;
    return currentIndex >= models.length - 1;  // On last model or beyond
  };</change>
</change>

<change path="src/resolver.ts">
<search>    const result = await ResolverProc.executeRun(prUrl, this.config, this.options, this.github, this.llm, ora(), callbacks, state);
    Object.assign(this, result);</search>
<replace>    const result = await ResolverProc.executeRun(prUrl, this.config, this.options, this.github, this.llm, ora(), callbacks, state);
    // Explicitly sync only the mutable run-state fields
    this.prInfo = result.prInfo;
    this.botTimings = result.botTimings;
    this.expectedBotResponseTime = result.expectedBotResponseTime;
    this.workdir = result.workdir;
    this.stateContext = result.stateContext;
    this.lessonsContext = result.lessonsContext;
    this.lockConfig = result.lockConfig;
    this.runner = result.runner;
    this.runners = result.runners;
    this.currentRunnerIndex = result.currentRunnerIndex;
    this.modelIndices = result.modelIndices;
    this.rapidFailureCount = result.rapidFailureCount;
    this.lastFailureTime = result.lastFailureTime;
    this.consecutiveFailures = result.consecutiveFailures;
    this.modelFailuresInCycle = result.modelFailuresInCycle;
    this.progressThisCycle = result.progressThisCycle;
    this.exitReason = result.exitReason;
    this.exitDetails = result.exitDetails;
    this.finalUnresolvedIssues = result.finalUnresolvedIssues;
    this.finalComments = result.finalComments;
  }

  // Helper: Check if we should bail out after completing a cycle
  const checkBailOut = (): boolean => {
    // A cycle just completed - check if we made progress
    if (ctx.progressThisCycle === 0) {
      const cycles = Bailout.incrementNoProgressCycles(stateContext);
      console.log(chalk.yellow(`\n  ⚠️  Completed cycle ${cycles} with zero progress`));
      
      if (cycles >= options.maxStaleCycles) {
        console.log(chalk.red(`\n  🛑 Bail-out triggered: ${cycles} cycles with no progress (max: ${options.maxStaleCycles})`));
        return true;  // Signal bail-out
      }
    } else {
      // Made progress - reset counter
      Bailout.resetNoProgressCycles(stateContext);
    }
    
    // Reset for next cycle
    ctx.progressThisCycle = 0;
    return false;
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
      switchToNextRunner(ctx, stateContext);
      
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
      switchToNextRunner(ctx, stateContext);
      
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
    return true;
  }
  
  return false;
}

/**
 * Setup and detect available runners
 * Returns the primary runner to use
 */
export async function setupRunner(
  options: CLIOptions,
  config: Config
): Promise<{ primary: Runner; all: Runner[] }> {
  // Auto-detect all available and ready runners
  const detected = await detectAvailableRunners(options.verbose);

  if (detected.length === 0) {
    throw new Error('No fix tools available! Install one of: cursor, claude-code, aider, opencode, codex, llm-api');
  }

  // Print summary
  printRunnerSummary(detected);

  // Find preferred runner: CLI option > PRR_TOOL env var > auto (first available)
  let primaryRunner: Runner;
  
  // Determine which tool to use: CLI option takes precedence, then config (PRR_TOOL env var)
  // 'auto' or undefined means use first available tool
  const preferredTool = options.tool || config.defaultTool;
  const isAutoSelect = !preferredTool || preferredTool === 'auto';

  if (!isAutoSelect) {
    const preferred = detected.find(d => d.runner.name === preferredTool);
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
}

/**
 * Reset progress counter for new cycle
 */
export function resetProgress(ctx: RotationContext): void {
  ctx.progressThisCycle = 0;
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
