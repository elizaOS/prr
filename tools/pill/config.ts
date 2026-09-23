/**
 * Configuration for pill. Loads .env from target directory and ~/.pill/.env.
 * Auto-detects provider from API keys. Trims all env values (trailing newlines cause 401s).
 *
 * WHY provider-specific defaults: The pill CLI still ships with an Anthropic-heavy **`--audit-model`**
 * default (`cli.ts`). Operators who only set **`OPENROUTER_API_KEY`** (or NVIDIA / OpenAI) would otherwise
 * POST that Claude id to a non-Anthropic **`/v1/chat/completions`** host — instant 4xx and confusing “pill
 * broken” reports. **`loadConfig`** substitutes **`shared/constants`** defaults when **`PILL_AUDIT_MODEL`**
 * is unset and the incoming audit model is still that legacy CLI default; **`PILL_LLM_MODEL`** defaults
 * per provider for story-read. See **`tools/pill/README.md`** and **DEVELOPMENT.md** (Pill LLM provider…).
 */
import dotenv from 'dotenv';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { existsSync, statSync } from 'fs';
import type { PillConfig } from './types.js';
import { resolveToolRepoScopeFilter } from './tool-repo-scope.js';
import { getNvidiaApiKeyFromEnv } from '../../shared/config.js';
import {
  DEFAULT_NVIDIA_LLM_MODEL,
  DEFAULT_OLLAMA_LLM_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_LLM_MODEL,
} from '../../shared/constants.js';

/** Matches Commander `--audit-model` default in `cli.ts` — replaced when backend is not Anthropic/ElizaCloud. */
export const PILL_CLI_DEFAULT_AUDIT_MODEL = 'claude-opus-4-6';

const DEFAULT_ANTHROPIC_AUDIT_MODEL = 'claude-opus-4-6';
const DEFAULT_ANTHROPIC_LLM_MODEL = 'claude-sonnet-4-5-20250929';

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

/** Align with `shared/config.ts` `MODEL_NAME_PATTERN` (colon for Ollama/LM Studio tags). */
const MODEL_REGEX = /^(?!.*\/\/)[A-Za-z0-9._\/:-]+$/;
function isValidModel(name: string): boolean {
  return MODEL_REGEX.test(name);
}

function pillProviderDefaultModels(
  provider: PillConfig['llmProvider'],
): { auditModel: string; llmModel: string } {
  switch (provider) {
    case 'nvidiacloud':
      return { auditModel: DEFAULT_NVIDIA_LLM_MODEL, llmModel: DEFAULT_NVIDIA_LLM_MODEL };
    case 'openrouter':
      return { auditModel: DEFAULT_OPENROUTER_LLM_MODEL, llmModel: DEFAULT_OPENROUTER_LLM_MODEL };
    case 'ollama':
      return { auditModel: DEFAULT_OLLAMA_LLM_MODEL, llmModel: DEFAULT_OLLAMA_LLM_MODEL };
    case 'lmstudio': {
      const m = getEnv('PILL_LLM_MODEL')!.trim();
      return { auditModel: m, llmModel: m };
    }
    case 'openai':
      return { auditModel: DEFAULT_OPENAI_MODEL, llmModel: DEFAULT_OPENAI_MODEL };
    case 'elizacloud':
    case 'anthropic':
    default:
      return { auditModel: DEFAULT_ANTHROPIC_AUDIT_MODEL, llmModel: DEFAULT_ANTHROPIC_LLM_MODEL };
  }
}

/** When CLI left `--audit-model` at the Anthropic default but the active provider is OpenAI-compatible non-Claude. */
function useProviderAuditDefaultInsteadOfCliDefault(
  provider: PillConfig['llmProvider'],
  inputAuditModel: string,
): boolean {
  if (getEnv('PILL_AUDIT_MODEL')) return false;
  if (inputAuditModel !== PILL_CLI_DEFAULT_AUDIT_MODEL) return false;
  return (
    provider === 'openai' ||
    provider === 'nvidiacloud' ||
    provider === 'openrouter' ||
    provider === 'ollama' ||
    provider === 'lmstudio'
  );
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
  /** Resolved absolute path; wins over PILL_OUTPUT_LOG_PATH */
  outputLogPath?: string;
  /** Resolved absolute path; wins over PILL_PROMPTS_LOG_PATH */
  promptsLogPath?: string;
}

/** Resolve optional log path to absolute file path, or undefined. */
function resolveOptionalLogFilePath(raw: string | undefined, label: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const abs = resolve(raw);
  if (!existsSync(abs)) {
    throw new Error(`Pill: ${label} not found: ${abs}`);
  }
  if (!statSync(abs).isFile()) {
    throw new Error(`Pill: ${label} is not a regular file: ${abs}`);
  }
  return abs;
}

/**
 * Load config: .env from target dir, then ~/.pill/.env (**WHY** `override: false` on home: project **`.env`**
 * should win for keys and overrides; **`~/.pill/.env`** is for machine-wide fallbacks only).
 * Auto-detect provider: ELIZACLOUD > ANTHROPIC > OPENAI > OPENROUTER > NVIDIA (same priority spirit as PRR). **`ollama`** / **`lmstudio`** require explicit **`PILL_LLM_PROVIDER`** (not inferred from URLs).
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
  if (
    explicitProvider === 'elizacloud' ||
    explicitProvider === 'anthropic' ||
    explicitProvider === 'openai' ||
    explicitProvider === 'nvidiacloud' ||
    explicitProvider === 'openrouter' ||
    explicitProvider === 'ollama' ||
    explicitProvider === 'lmstudio'
  ) {
    llmProvider = explicitProvider;
  } else if (getEnv('ELIZACLOUD_API_KEY')) {
    llmProvider = 'elizacloud';
  } else if (getEnv('ANTHROPIC_API_KEY')) {
    llmProvider = 'anthropic';
  } else if (getEnv('OPENAI_API_KEY')) {
    llmProvider = 'openai';
  } else if (getEnv('OPENROUTER_API_KEY')) {
    llmProvider = 'openrouter';
  } else if (getNvidiaApiKeyFromEnv()) {
    llmProvider = 'nvidiacloud';
  } else {
    throw new Error(
      'Missing API key. Set one of: ELIZACLOUD_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY / NVIDIA_CLOUD_API_KEY, or PILL_LLM_PROVIDER=ollama|lmstudio for local OpenAI-compatible servers (see README).',
    );
  }

  if (llmProvider === 'lmstudio' && !getEnv('PILL_LLM_MODEL')?.trim()) {
    throw new Error(
      'PILL_LLM_MODEL is required when PILL_LLM_PROVIDER=lmstudio. Set it to the model id from LM Studio’s local server.',
    );
  }

  // WHY `pillDefs` + `useProviderAuditDefaultInsteadOfCliDefault`: see file-level doc — avoid Anthropic CLI
  // default on OpenAI-compat-only keys; env overrides (`PILL_AUDIT_MODEL` / `PILL_LLM_MODEL`) always win.
  const pillDefs = pillProviderDefaultModels(llmProvider);
  const auditModelDefault = useProviderAuditDefaultInsteadOfCliDefault(llmProvider, input.auditModel)
    ? pillDefs.auditModel
    : input.auditModel;
  const auditModel = getEnvOrDefault('PILL_AUDIT_MODEL', auditModelDefault);
  const llmModel = getEnvOrDefault('PILL_LLM_MODEL', pillDefs.llmModel);
  if (!isValidModel(auditModel) || !isValidModel(llmModel)) {
    throw new Error(
      'Invalid model name in config or env. Use only letters, numbers, dots, slashes, hyphens, colons (no //).',
    );
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

  const auditMaxUserEnv = getEnv('PILL_AUDIT_MAX_USER_CHARS');
  const auditMaxUserChars =
    auditMaxUserEnv !== undefined && auditMaxUserEnv !== ''
      ? (() => {
          const n = parseInt(auditMaxUserEnv, 10);
          if (!Number.isFinite(n) || n < 6_000 || n > 80_000) return undefined;
          return n;
        })()
      : undefined;

  const auditChunkConcurrencyEnv = getEnv('PILL_AUDIT_CHUNK_CONCURRENCY');
  const auditChunkConcurrency = (() => {
    if (auditChunkConcurrencyEnv === undefined || auditChunkConcurrencyEnv === '') return 4;
    const n = parseInt(auditChunkConcurrencyEnv, 10);
    if (!Number.isFinite(n) || n < 1 || n > 16) return 4;
    return n;
  })();

  const toolRepoScopeFilter = resolveToolRepoScopeFilter(input.targetDir, getEnv('PILL_TOOL_REPO_SCOPE_FILTER'));

  const outputLogPath = resolveOptionalLogFilePath(
    input.outputLogPath ?? getEnv('PILL_OUTPUT_LOG_PATH'),
    'Output log (PILL_OUTPUT_LOG_PATH or --output-log)'
  );
  const promptsLogPath = resolveOptionalLogFilePath(
    input.promptsLogPath ?? getEnv('PILL_PROMPTS_LOG_PATH'),
    'Prompts log (PILL_PROMPTS_LOG_PATH or --prompts-log)'
  );

  const config: PillConfig = {
    targetDir: input.targetDir,
    llmProvider,
    auditModel,
    llmModel,
    logPrefix: input.logPrefix,
    contextBudgetTokens,
    auditMaxUserChars,
    auditChunkConcurrency,
    toolRepoScopeFilter,
    outputOnly: input.outputOnly,
    promptsOnly: input.promptsOnly,
    dryRun: input.dryRun,
    verbose: input.verbose,
    outputLogPath,
    promptsLogPath,
  };
  config.instructionsOut = input.instructionsOut;

  if (llmProvider === 'elizacloud') {
    config.elizacloudApiKey = getEnvOrThrow('ELIZACLOUD_API_KEY');
  } else if (llmProvider === 'anthropic') {
    config.anthropicApiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
  } else if (llmProvider === 'openai') {
    config.openaiApiKey = getEnvOrThrow('OPENAI_API_KEY');
  } else if (llmProvider === 'openrouter') {
    config.openrouterApiKey = getEnvOrThrow('OPENROUTER_API_KEY');
  } else if (llmProvider === 'nvidiacloud') {
    const nk = getNvidiaApiKeyFromEnv();
    if (!nk) {
      throw new Error('Missing NVIDIA_API_KEY or NVIDIA_CLOUD_API_KEY for PILL_LLM_PROVIDER=nvidiacloud.');
    }
    config.nvidiaApiKey = nk;
  } else if (llmProvider === 'ollama') {
    config.ollamaApiKey = getEnvOrDefault('OLLAMA_API_KEY', 'ollama');
  } else if (llmProvider === 'lmstudio') {
    config.lmstudioApiKey = getEnvOrDefault('LMSTUDIO_API_KEY', 'lm-studio');
  }

  const otherEliza = getEnv('ELIZACLOUD_API_KEY');
  const otherAnthropic = getEnv('ANTHROPIC_API_KEY');
  const otherOpenai = getEnv('OPENAI_API_KEY');
  const otherOpenrouter = getEnv('OPENROUTER_API_KEY');
  const otherNvidia = getNvidiaApiKeyFromEnv();
  if (otherEliza && !config.elizacloudApiKey) config.elizacloudApiKey = otherEliza;
  if (otherAnthropic && !config.anthropicApiKey) config.anthropicApiKey = otherAnthropic;
  if (otherOpenai && !config.openaiApiKey) config.openaiApiKey = otherOpenai;
  if (otherOpenrouter && !config.openrouterApiKey) config.openrouterApiKey = otherOpenrouter;
  if (otherNvidia && !config.nvidiaApiKey) config.nvidiaApiKey = otherNvidia;
  const otherOllama = getEnv('OLLAMA_API_KEY');
  const otherLmstudio = getEnv('LMSTUDIO_API_KEY');
  if (otherOllama && !config.ollamaApiKey) config.ollamaApiKey = otherOllama;
  if (otherLmstudio && !config.lmstudioApiKey) config.lmstudioApiKey = otherLmstudio;

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
      auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
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
