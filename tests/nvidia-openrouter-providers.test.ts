import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NVIDIA_LLM_MODEL,
  DEFAULT_OPENROUTER_LLM_MODEL,
  NVIDIA_API_BASE_URL,
  OPENROUTER_API_BASE_URL,
} from '../shared/constants.js';
import { openAiCompatMaxOutputFields } from '../shared/llm/openai-compat-chat-params.js';
import { getCheapModelForProvider } from '../tools/prr/llm/provider-probes.js';

describe('NVIDIA Cloud + OpenRouter provider defaults', () => {
  it('exposes documented default base URLs', () => {
    expect(NVIDIA_API_BASE_URL).toMatch(/^https:\/\/.+\/v1$/);
    expect(OPENROUTER_API_BASE_URL).toMatch(/^https:\/\/.+\/v1$/);
  });

  it('uses stable default model ids when PRR_LLM_MODEL is unset (shared/constants)', () => {
    expect(DEFAULT_NVIDIA_LLM_MODEL).toContain('/');
    expect(DEFAULT_OPENROUTER_LLM_MODEL).toContain('/');
  });

  it('maps cheap models for split-plan and low-stakes LLM calls', () => {
    expect(getCheapModelForProvider('nvidiacloud')).toBe('meta/llama-3.1-8b-instruct');
    expect(getCheapModelForProvider('openrouter')).toBe('openai/gpt-4o-mini');
  });

  it('uses max_tokens for NVIDIA/OpenRouter chat bodies and max_completion_tokens for OpenAI/ElizaCloud', () => {
    expect(openAiCompatMaxOutputFields(100, 'nvidiacloud')).toEqual({ max_tokens: 100 });
    expect(openAiCompatMaxOutputFields(100, 'openrouter')).toEqual({ max_tokens: 100 });
    expect(openAiCompatMaxOutputFields(100, 'openai')).toEqual({ max_completion_tokens: 100 });
    expect(openAiCompatMaxOutputFields(100, 'elizacloud')).toEqual({ max_completion_tokens: 100 });
  });
});
