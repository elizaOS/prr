import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../shared/config.js';
import { DEFAULT_OLLAMA_LLM_MODEL } from '../shared/constants.js';
import {
  getCheapModelForProvider,
  isLikelyLocalEndpointConnectionFailure,
} from '../tools/prr/llm/provider-probes.js';
import { openAiCompatMaxOutputFields, openAiCompatMaxOutputStyle } from '../shared/llm/openai-compat-chat-params.js';

describe('Ollama / LM Studio provider helpers', () => {
  it('openAiCompatMaxOutputStyle uses max_tokens for ollama and lmstudio', () => {
    expect(openAiCompatMaxOutputStyle('ollama')).toBe('max_tokens');
    expect(openAiCompatMaxOutputStyle('lmstudio')).toBe('max_tokens');
    expect(openAiCompatMaxOutputFields(100, 'ollama')).toEqual({ max_tokens: 100 });
    expect(openAiCompatMaxOutputFields(100, 'lmstudio')).toEqual({ max_tokens: 100 });
  });

  it('getCheapModelForProvider omits ollama and lmstudio (falls back to main model in LLMClient)', () => {
    expect(getCheapModelForProvider('ollama')).toBeUndefined();
    expect(getCheapModelForProvider('lmstudio')).toBeUndefined();
  });

  it('isLikelyLocalEndpointConnectionFailure reads nested Error.cause', () => {
    const inner = new Error('fetch failed');
    (inner as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    const outer = new Error('Connection error.');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(isLikelyLocalEndpointConnectionFailure(outer)).toBe(true);
  });
});

describe('loadConfig local providers', () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'GITHUB_TOKEN',
      'PRR_LLM_PROVIDER',
      'PRR_LLM_MODEL',
      'OLLAMA_API_KEY',
      'LMSTUDIO_API_KEY',
      'ELIZACLOUD_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'NVIDIA_API_KEY',
      'NVIDIA_CLOUD_API_KEY',
    ]) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GITHUB_TOKEN = 'ghp_test_token_for_unit_tests';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('requires PRR_LLM_MODEL when PRR_LLM_PROVIDER=lmstudio', () => {
    process.env.PRR_LLM_PROVIDER = 'lmstudio';
    expect(() => loadConfig()).toThrow(/PRR_LLM_MODEL is required/);
  });

  it('defaults ollama model when PRR_LLM_MODEL unset', () => {
    process.env.PRR_LLM_PROVIDER = 'ollama';
    const c = loadConfig();
    expect(c.llmProvider).toBe('ollama');
    expect(c.llmModel).toBe(DEFAULT_OLLAMA_LLM_MODEL);
    expect(c.ollamaApiKey).toBe('ollama');
  });

  it('accepts lmstudio when PRR_LLM_MODEL set', () => {
    process.env.PRR_LLM_PROVIDER = 'lmstudio';
    process.env.PRR_LLM_MODEL = 'my-local-model';
    const c = loadConfig();
    expect(c.llmProvider).toBe('lmstudio');
    expect(c.llmModel).toBe('my-local-model');
    expect(c.lmstudioApiKey).toBe('lm-studio');
  });
});
