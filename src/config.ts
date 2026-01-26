import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';

dotenv.config();

export type LLMProvider = 'anthropic' | 'openai';
export type FixerTool = 'cursor' | 'opencode' | 'claude-code' | 'aider' | 'codex' | 'llm-api';

export interface Config {
  githubToken: string;
  llmProvider: LLMProvider;
  llmModel: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  defaultTool?: FixerTool;
  workdirBase: string;
  anthropicThinkingBudget?: number;  // Extended thinking token budget
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

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
      llmProvider === 'anthropic' ? 'claude-sonnet-4-5-20250929' : 'gpt-5.2'
    ),
    defaultTool: validateTool(getEnvOrDefault('PRR_TOOL', 'cursor')),
    workdirBase: join(homedir(), '.prr', 'work'),
    anthropicThinkingBudget: thinkingBudget,
  };

  // Validate API key exists for chosen provider
  if (llmProvider === 'anthropic') {
    config.anthropicApiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
  } else {
    config.openaiApiKey = getEnvOrThrow('OPENAI_API_KEY');
  }

  return config;
}


export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._\/-]+$/;

export function isValidModelName(model: string): boolean {
  return MODEL_NAME_PATTERN.test(model);
}

export function validateTool(tool: string): FixerTool {
  if (!['cursor', 'opencode', 'claude-code', 'aider', 'codex', 'llm-api'].includes(tool as FixerTool)) {
    throw new Error(`Invalid tool: ${tool}. Must be one of: cursor, opencode, claude-code, aider, codex, llm-api`);
  }
  return tool as FixerTool;
}
