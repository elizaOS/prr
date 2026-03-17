/**
 * Configuration for pill. Loads .env from target directory and ~/.pill/.env.
 * Auto-detects provider from API keys. Trims all env values (trailing newlines cause 401s).
 */
import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, statSync } from 'fs';
import type { PillConfig } from './types.js';

const DEFAULT_AUDIT_MODEL = 'claude-opus-4-6';
const DEFAULT_LLM_MODEL = 'claude-sonnet-4-5-20250929';

/** Default max context tokens for pill audit. Change this to alter the default (e.g. 20_000 for small-context models). Overridable via PILL_CONTEXT_BUDGET_TOKENS. */
export const DEFAULT_PILL_CONTEXT_BUDGET_TOKENS = 35_000;

function getEnv(key: string): string | undefined {
  const raw = process.env[key];
  return raw === undefined || raw === null ? undefined : raw.trim();
}

function getEnvOrThrow(key: string): string {
  const value = getEnv(key);
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}. Set it in .env or ~/.pill/.env`);
  }
  return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  const value = getEnv(key);
  return (value !== undefined && value !== '') ? value : defaultValue;
}

const MODEL_REGEX = /^[A-Za-z0-9._\/-]+$/;
function isValidModel(name: string): boolean {
  return MODEL_REGEX.test(name);
}

export interface LoadConfigInput {
  targetDir: string;
  auditModel: string;
  outputOnly: boolean;
  promptsOnly: boolean;
  dryRun: boolean;
  verbose: boolean;
  logPrefix?: string;
  instructionsOut?: string;
}

/**
 * Load config: .env from target dir, then ~/.pill/.env (override: false so target wins).
 * Auto-detect provider: ELIZACLOUD > ANTHROPIC > OPENAI.
 */
export function loadConfig(input: LoadConfigInput): PillConfig {
  if (!existsSync(input.targetDir) || !statSync(input.targetDir).isDirectory()) {
    throw new Error(`Target directory does not exist: ${input.targetDir}`);
  }
  const targetEnvPath = join(input.targetDir, '.env');
  const homeEnvPath = join(homedir(), '.pill', '.env');

  dotenv.config({ path: targetEnvPath });
  dotenv.config({ path: homeEnvPath, override: false });

  const explicitProvider = getEnv('PILL_LLM_PROVIDER');
  let llmProvider: PillConfig['llmProvider'];
  if (explicitProvider === 'elizacloud' || explicitProvider === 'anthropic' || explicitProvider === 'openai') {
    llmProvider = explicitProvider;
  } else if (getEnv('ELIZACLOUD_API_KEY')) {
    llmProvider = 'elizacloud';
  } else if (getEnv('ANTHROPIC_API_KEY')) {
    llmProvider = 'anthropic';
  } else if (getEnv('OPENAI_API_KEY')) {
    llmProvider = 'openai';
  } else {
    throw new Error(
      'Missing API key. Set one of: ELIZACLOUD_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY in .env or ~/.pill/.env'
    );
  }

  const auditModel = getEnvOrDefault('PILL_AUDIT_MODEL', input.auditModel);
  const llmModel = getEnvOrDefault('PILL_LLM_MODEL', DEFAULT_LLM_MODEL);
  if (!isValidModel(auditModel) || !isValidModel(llmModel)) {
    throw new Error('Invalid model name in config or env. Use only letters, numbers, dots, slashes, hyphens.');
  }

  // WHY configurable: Small-context models (e.g. 20k) need a lower budget to avoid 504/timeout; default 35k suits larger models.
  const contextBudgetEnv = getEnv('PILL_CONTEXT_BUDGET_TOKENS');
  const contextBudgetTokens =
    contextBudgetEnv !== undefined && contextBudgetEnv !== ''
      ? (() => {
          const n = parseInt(contextBudgetEnv, 10);
          if (!Number.isFinite(n) || n < 8_000 || n > 128_000) return undefined;
          return n;
        })()
      : undefined;

  const config: PillConfig = {
    targetDir: input.targetDir,
    llmProvider,
    auditModel,
    llmModel,
    logPrefix: input.logPrefix,
    contextBudgetTokens,
    outputOnly: input.outputOnly,
    promptsOnly: input.promptsOnly,
    dryRun: input.dryRun,
    verbose: input.verbose,
  };
  config.instructionsOut = input.instructionsOut;

  if (llmProvider === 'elizacloud') {
    config.elizacloudApiKey = getEnvOrThrow('ELIZACLOUD_API_KEY');
  } else if (llmProvider === 'anthropic') {
    config.anthropicApiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
  } else {
    config.openaiApiKey = getEnvOrThrow('OPENAI_API_KEY');
  }

  const otherEliza = getEnv('ELIZACLOUD_API_KEY');
  const otherAnthropic = getEnv('ANTHROPIC_API_KEY');
  const otherOpenai = getEnv('OPENAI_API_KEY');
  if (otherEliza && !config.elizacloudApiKey) config.elizacloudApiKey = otherEliza;
  if (otherAnthropic && !config.anthropicApiKey) config.anthropicApiKey = otherAnthropic;
  if (otherOpenai && !config.openaiApiKey) config.openaiApiKey = otherOpenai;

  return config;
}

/**
 * Load pill config for use from shared logger hook. Returns null on missing API key or invalid dir.
 * Never throws — allows prr/story to run pill analysis optionally.
 */
export function tryLoadPillConfig(input: {
  targetDir: string;
  logPrefix?: string;
}): PillConfig | null {
  try {
    return loadConfig({
      targetDir: input.targetDir,
      auditModel: 'claude-opus-4-6',
      outputOnly: false,
      promptsOnly: false,
      dryRun: false,
      verbose: false,
      logPrefix: input.logPrefix,
    });
  } catch {
    return null;
  }
}
