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
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_ELIZACLOUD_MODEL } from './constants.js';

dotenv.config();

/** Supported LLM provider backends */
export type LLMProvider = 'elizacloud' | 'anthropic' | 'openai';

/** Available fixer tools that can apply code changes */
export type FixerTool = 'elizacloud' | 'cursor' | 'opencode' | 'claude-code' | 'aider' | 'codex' | 'gemini' | 'junie' | 'goose' | 'openhands' | 'llm-api' | 'auto';

const REAL_FIXER_TOOLS = ['elizacloud', 'cursor', 'opencode', 'claude-code', 'aider', 'codex', 'gemini', 'junie', 'goose', 'openhands', 'llm-api'] as const;
export type RealFixerTool = typeof REAL_FIXER_TOOLS[number];
/**
 * Application configuration loaded from environment.
 */
export interface Config {
  /** GitHub personal access token with repo scope */
  githubToken: string;
  /** LLM provider for analysis (elizacloud, anthropic, or openai) */
  llmProvider: LLMProvider;
  /** Model name/identifier for the LLM provider */
  llmModel: string;
  /** Optional stronger model for verification (e.g. PRR_VERIFIER_MODEL). When set, batch verification uses this instead of llmModel to reduce false negatives. */
  verifierModel?: string;
  /** ElizaCloud API key (recommended - one key for all models) */
  elizacloudApiKey?: string;
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
 * Trims whitespace/newlines so .env copy-paste doesn't cause 401s.
 *
 * WHY trim: Pasting an API key from a doc or password manager often adds a
 * trailing newline. Without trim, the key is sent with "\n" and providers
 * reject it (401 Unauthorized). Trimming avoids this class of config error.
 *
 * @param key - Environment variable name
 * @returns The trimmed value
 * @throws Error if the variable is not set or empty after trim
 */
function getEnvOrThrow(key: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === null) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`Required environment variable ${key} is empty (or only whitespace). Check your .env file.`);
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
  const value = process.env[key] ?? defaultValue;
  return value.trim();
}

/**
 * Load and validate application configuration from environment.
 *
 * WHY env + .env: Users expect to set GITHUB_TOKEN and API keys in .env so they
 * aren't in shell history. We load .env via dotenv then read process.env; all
 * keys are trimmed so copy-paste from docs or password managers doesn't add
 * trailing newlines (which cause 401s).
 *
 * Required environment variables:
 * - GITHUB_TOKEN: GitHub personal access token
 * - ELIZACLOUD_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY: LLM provider API key
 *
 * Optional environment variables:
 * - PRR_LLM_PROVIDER: 'elizacloud', 'anthropic', or 'openai' (auto-detects if not set)
 * - PRR_LLM_MODEL: Model name (defaults based on provider)
 * - PRR_VERIFIER_MODEL: Stronger model for verification (recommended when default is weak; reduces false negatives)
 * - PRR_TOOL: Default fixer tool
 * - PRR_THINKING_BUDGET: Extended thinking token budget
 *
 * @returns Validated configuration object
 * @throws Error if required variables are missing or invalid
 */
export function loadConfig(): Config {
  // Smart auto-detect: check which API key is available, prefer ElizaCloud
  const explicitProvider = process.env.PRR_LLM_PROVIDER;
  let llmProvider: LLMProvider;

  if (explicitProvider) {
    llmProvider = explicitProvider as LLMProvider;
  } else if (process.env.ELIZACLOUD_API_KEY) {
    llmProvider = 'elizacloud';
  } else if (process.env.ANTHROPIC_API_KEY) {
    llmProvider = 'anthropic';
  } else if (process.env.OPENAI_API_KEY) {
    llmProvider = 'openai';
  } else {
    llmProvider = 'elizacloud'; // will error below with helpful message
  }

  if (llmProvider !== 'elizacloud' && llmProvider !== 'anthropic' && llmProvider !== 'openai') {
    throw new Error(`Invalid LLM provider: ${llmProvider}. Must be 'elizacloud', 'anthropic', or 'openai'`);
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

  // Default model based on provider
  let defaultModel: string;
  if (llmProvider === 'elizacloud') {
    defaultModel = DEFAULT_ELIZACLOUD_MODEL;
  } else if (llmProvider === 'anthropic') {
    defaultModel = DEFAULT_ANTHROPIC_MODEL;
  } else {
    // Use gpt-4o: a stable, widely-available OpenAI API model
    // Note: gpt-5.3 does not exist as a general API model (only gpt-5.3-codex for paid ChatGPT)
    defaultModel = 'gpt-4o';
  }

  const verifierModelRaw = process.env.PRR_VERIFIER_MODEL?.trim();
  const config: Config = {
    githubToken: getEnvOrThrow('GITHUB_TOKEN'),
    llmProvider,
    llmModel: getEnvOrDefault('PRR_LLM_MODEL', defaultModel),
    verifierModel: verifierModelRaw && verifierModelRaw.length > 0 ? verifierModelRaw : undefined,
    defaultTool: validateTool(getEnvOrDefault('PRR_TOOL', 'auto')),
    workdirBase: join(homedir(), '.prr', 'work'),
    anthropicThinkingBudget: thinkingBudget,
  };

  // Validate API key exists for chosen provider
  if (llmProvider === 'elizacloud') {
    config.elizacloudApiKey = getEnvOrThrow('ELIZACLOUD_API_KEY');
  } else if (llmProvider === 'anthropic') {
    config.anthropicApiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
  } else {
    config.openaiApiKey = getEnvOrThrow('OPENAI_API_KEY');
  }

  // Also pick up the OTHER provider's key if available (optional).
  // WHY: The LLM provider is for verification, but fixer tools may use a
  // different provider (e.g. ElizaCloud for LLM + Codex/OpenAI for fixing).
  // We need all keys to validate model rotation lists at startup.
  // Trim optional keys too so stray newlines don't cause 401.
  if (!config.elizacloudApiKey) {
    const v = process.env.ELIZACLOUD_API_KEY?.trim();
    if (v) config.elizacloudApiKey = v;
  }
  if (!config.openaiApiKey) {
    const v = process.env.OPENAI_API_KEY?.trim();
    if (v) config.openaiApiKey = v;
  }
  if (!config.anthropicApiKey) {
    const v = process.env.ANTHROPIC_API_KEY?.trim();
    if (v) config.anthropicApiKey = v;
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
