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
  defaultTool: FixerTool;
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
    const parsed = parseInt(thinkingBudgetStr, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid PRR_THINKING_BUDGET: "${thinkingBudgetStr}". Must be a positive integer.`);
    }
    thinkingBudget = parsed;
  }

  const config: Config = {
    githubToken: getEnvOrThrow('GITHUB_TOKEN'),
    llmProvider,
    llmModel: getEnvOrDefault(
      'PRR_LLM_MODEL',
      llmProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o'
    ),
    defaultTool: getEnvOrDefault('PRR_TOOL', 'cursor') as FixerTool,
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

const VALID_TOOLS: readonly FixerTool[] = ['cursor', 'opencode', 'claude-code', 'aider', 'codex', 'llm-api'];

export function validateTool(tool: string): FixerTool {
  if (!VALID_TOOLS.includes(tool as FixerTool)) {
    throw new Error(`Invalid tool: ${tool}. Must be one of: ${VALID_TOOLS.join(', ')}`);
  }
  return tool as FixerTool;
}
