/**
 * Configuration module for PRR (PR Review Resolver).
 * 
 * Loads configuration from environment variables and .env file.
 * Supports multiple LLM providers (Anthropic, OpenAI) and fixer tools.
 * 
 * @module config
 */

import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';

dotenv.config();

/** Supported LLM provider backends */
export type LLMProvider = 'anthropic' | 'openai';

/** Available fixer tools that can apply code changes */
export type FixerTool = 'cursor' | 'opencode' | 'claude-code' | 'aider' | 'codex' | 'gemini' | 'junie' | 'goose' | 'openhands' | 'llm-api' | 'auto';

const REAL_FIXER_TOOLS = ['cursor', 'opencode', 'claude-code', 'aider', 'codex', 'gemini', 'junie', 'goose', 'openhands', 'llm-api'] as const;
export type RealFixerTool = typeof REAL_FIXER_TOOLS[number];
/**
 * Application configuration loaded from environment.
 */
export interface Config {
  /** GitHub personal access token with repo scope */
  githubToken: string;
  /** LLM provider for analysis (anthropic or openai) */
  llmProvider: LLMProvider;
  /** Model name/identifier for the LLM provider */
  llmModel: string;
  /** Anthropic API key (required if provider is anthropic) */
  anthropicApiKey?: string;
  /** OpenAI API key (required if provider is openai) */
  openaiApiKey?: string;
  /** Default fixer tool to use (auto = detect available) */
  defaultTool?: FixerTool;
  /** Base directory for working directories */
  workdirBase: string;
  /** Extended thinking token budget for Anthropic */
  anthropicThinkingBudget?: number;
}

/**
 * Get environment variable or throw if missing.
 * 
 * @param key - Environment variable name
 * @returns The environment variable value
 * @throws Error if the variable is not set
 */
function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get environment variable with fallback default.
 * 
 * @param key - Environment variable name
 * @param defaultValue - Value to use if not set
 * @returns The environment variable value or default
 */
function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Load and validate application configuration from environment.
 * 
 * Required environment variables:
 * - GITHUB_TOKEN: GitHub personal access token
 * - ANTHROPIC_API_KEY or OPENAI_API_KEY: LLM provider API key
 * 
 * Optional environment variables:
 * - PRR_LLM_PROVIDER: 'anthropic' (default) or 'openai'
 * - PRR_LLM_MODEL: Model name (defaults to claude-sonnet-4-5 or gpt-5.2)
 * - PRR_TOOL: Default fixer tool
 * - PRR_THINKING_BUDGET: Extended thinking token budget
 * 
 * @returns Validated configuration object
 * @throws Error if required variables are missing or invalid
 */
export function loadConfig(): Config {
  const llmProvider = getEnvOrDefault('PRR_LLM_PROVIDER', 'anthropic') as LLMProvider;

  if (llmProvider !== 'anthropic' && llmProvider !== 'openai') {
    throw new Error(`Invalid LLM provider: ${llmProvider}. Must be 'anthropic' or 'openai'`);
  }

  // Parse and validate thinking budget if set
  const thinkingBudgetStr = process.env.PRR_THINKING_BUDGET;
  let thinkingBudget: number | undefined;
  if (thinkingBudgetStr) {
    if (!/^\d+$/.test(thinkingBudgetStr)) {
      throw new Error(`Invalid PRR_THINKING_BUDGET: "${thinkingBudgetStr}". Must be a positive integer.`);
    }
    const parsed = Number(thinkingBudgetStr);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid PRR_THINKING_BUDGET: "${thinkingBudgetStr}". Must be a positive integer.`);
    }
    thinkingBudget = parsed;
  }

  const config: Config = {
    githubToken: getEnvOrThrow('GITHUB_TOKEN'),
    llmProvider,
    llmModel: getEnvOrDefault(
      'PRR_LLM_MODEL',
      llmProvider === 'anthropic' ? 'claude-sonnet-4-5-20250929' : 'gpt-4o'
    ),
    defaultTool: validateTool(getEnvOrDefault('PRR_TOOL', 'auto')),
    workdirBase: join(homedir(), '.prr', 'work'),
    anthropicThinkingBudget: thinkingBudget,
  };

  // Validate API key exists for chosen provider
  if (llmProvider === 'anthropic') {
    config.anthropicApiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
  } else {
    config.openaiApiKey = getEnvOrThrow('OPENAI_API_KEY');
  }

  // Also pick up the OTHER provider's key if available (optional).
  // WHY: The LLM provider is for verification, but fixer tools may use a
  // different provider (e.g. Anthropic for LLM + Codex/OpenAI for fixing).
  // We need both keys to validate model rotation lists at startup.
  if (!config.openaiApiKey && process.env.OPENAI_API_KEY) {
    config.openaiApiKey = process.env.OPENAI_API_KEY;
  }
  if (!config.anthropicApiKey && process.env.ANTHROPIC_API_KEY) {
    config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  }

  return config;
}


/**
 * Pattern for validating model names.
 * Allows alphanumeric, dots, underscores, hyphens, and forward slashes
 * (for provider-prefixed names like "anthropic/claude-3-opus").
 */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._\/-]+$/;

/**
 * Validate that a model name is safe and well-formed.
 * 
 * WHY: Model names are passed to external tools and could be a vector
 * for command injection if not validated. This is defense-in-depth.
 * 
 * @param model - Model name to validate
 * @returns True if model name matches expected pattern
 */
export function isValidModelName(model: string): boolean {
  return MODEL_NAME_PATTERN.test(model);
}

/**
 * Validate and cast a tool string to FixerTool type.
 * 
 * @param tool - Tool name to validate
 * @returns Validated FixerTool value
 * @throws Error if tool is not a valid option
 */
export function validateTool(tool: string): FixerTool {
  if (tool === 'auto') {
    // NOTE: 'auto' is a meta-value for auto-detection; resolve before storing or running as a real tool.
    return tool;
  }

  // If not 'auto', ensure it's one of the real fixer tools and cast appropriately.
  return validateRealTool(tool) as FixerTool;
}

/** Validate that a tool is a real runner (not 'auto'). 'auto' should be resolved before calling this. */
/**
 * Validate a real fixer tool name (not 'auto').
 * 
 * WHY: 'auto' is a meta-value for auto-detection, not an actual tool.
 * This function ensures only real tools are used when a specific tool is required.
 */
export function validateRealTool(tool: string): RealFixerTool {
  if (!REAL_FIXER_TOOLS.includes(tool as RealFixerTool)) {
    throw new Error(`Invalid real tool: ${tool}. Must be one of: ${REAL_FIXER_TOOLS.join(', ')}`);
  }
  return tool as RealFixerTool;
}
