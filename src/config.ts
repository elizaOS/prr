import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';

dotenv.config();

export type LLMProvider = 'anthropic' | 'openai';
export type FixerTool = 'cursor' | 'opencode';

// Default bot usernames to look for in PR reviews
// These are matched as substrings (case-insensitive)
const DEFAULT_BOT_USERS = [
  'copilot',                    // GitHub Copilot, copilot-pull-request-reviewer
  'coderabbitai',               // CodeRabbit
  'greptile',                   // Greptile
  'codex-connector',            // ChatGPT Codex Connector
  'sourcery',                   // Sourcery
  'codiumai',                   // CodiumAI / Qodo
];

export interface Config {
  githubToken: string;
  llmProvider: LLMProvider;
  llmModel: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  defaultTool: FixerTool;
  workdirBase: string;
  botUsers: string[];
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

function parseBotUsers(envValue: string | undefined): string[] {
  if (!envValue) {
    return DEFAULT_BOT_USERS;
  }
  return envValue.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function loadConfig(): Config {
  const llmProvider = getEnvOrDefault('PRR_LLM_PROVIDER', 'anthropic') as LLMProvider;
  
  if (llmProvider !== 'anthropic' && llmProvider !== 'openai') {
    throw new Error(`Invalid LLM provider: ${llmProvider}. Must be 'anthropic' or 'openai'`);
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
    botUsers: parseBotUsers(process.env.PRR_BOT_USERS),
  };

  // Validate API key exists for chosen provider
  if (llmProvider === 'anthropic') {
    config.anthropicApiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
  } else {
    config.openaiApiKey = getEnvOrThrow('OPENAI_API_KEY');
  }

  return config;
}

export function validateTool(tool: string): FixerTool {
  if (tool !== 'cursor' && tool !== 'opencode') {
    throw new Error(`Invalid tool: ${tool}. Must be 'cursor' or 'opencode'`);
  }
  return tool;
}
