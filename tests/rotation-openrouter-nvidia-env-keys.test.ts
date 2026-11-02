import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Runner } from '../shared/runners/types.js';

const orFetch = vi.fn(() => Promise.resolve(new Set<string>(['openai/gpt-4o-mini'])));
const nvidiaFetch = vi.fn(() => Promise.resolve(new Set<string>(['meta/llama-3.1-8b-instruct'])));

vi.mock('../tools/prr/llm/provider-probes.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../tools/prr/llm/provider-probes.js')>();
  return {
    ...orig,
    fetchAvailableOpenRouterModels: (...args: Parameters<typeof orig.fetchAvailableOpenRouterModels>) =>
      orFetch(...args),
    fetchAvailableNvidiaCloudModels: (...args: Parameters<typeof orig.fetchAvailableNvidiaCloudModels>) =>
      nvidiaFetch(...args),
    fetchAvailableElizaCloudModels: () => Promise.resolve(new Set(['x'])),
  };
});

import { validateAndFilterModels } from '../tools/prr/models/rotation.js';

describe('validateAndFilterModels — OpenRouter / NVIDIA keys from env', () => {
  const keys = ['OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'NVIDIA_CLOUD_API_KEY', 'PRR_LLM_PROVIDER'] as const;
  const prev: Partial<Record<(typeof keys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    orFetch.mockClear();
    nvidiaFetch.mockClear();
  });

  afterEach(() => {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('uses OPENROUTER_API_KEY from env when validateAndFilterModels openrouter param is omitted', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-from-env';
    process.env.PRR_LLM_PROVIDER = 'openrouter';
    const runner: Runner = {
      name: 'llm-api',
      displayName: 'Direct LLM API',
      provider: 'openrouter',
      run: async () => ({ success: false, output: '' }),
      isAvailable: async () => true,
      checkStatus: async () => ({ installed: true, ready: true }),
    };
    await validateAndFilterModels(
      [runner],
      undefined,
      undefined,
      'eliza-key',
      'openai/gpt-4o-mini',
      undefined,
      undefined,
    );
    expect(orFetch).toHaveBeenCalledWith('sk-from-env');
  });

  it('uses NVIDIA_API_KEY from env when validateAndFilterModels nvidia param is omitted', async () => {
    process.env.NVIDIA_API_KEY = 'nv-from-env';
    process.env.PRR_LLM_PROVIDER = 'nvidiacloud';
    const runner: Runner = {
      name: 'llm-api',
      displayName: 'Direct LLM API',
      provider: 'nvidiacloud',
      run: async () => ({ success: false, output: '' }),
      isAvailable: async () => true,
      checkStatus: async () => ({ installed: true, ready: true }),
    };
    await validateAndFilterModels(
      [runner],
      undefined,
      undefined,
      'eliza-key',
      'meta/llama-3.1-8b-instruct',
      undefined,
      undefined,
    );
    expect(nvidiaFetch).toHaveBeenCalledWith('nv-from-env');
  });

  it('uses NVIDIA_CLOUD_API_KEY from env when nvidia param is omitted', async () => {
    process.env.NVIDIA_CLOUD_API_KEY = 'nv-cloud-from-env';
    process.env.PRR_LLM_PROVIDER = 'nvidiacloud';
    const runner: Runner = {
      name: 'llm-api',
      displayName: 'Direct LLM API',
      provider: 'nvidiacloud',
      run: async () => ({ success: false, output: '' }),
      isAvailable: async () => true,
      checkStatus: async () => ({ installed: true, ready: true }),
    };
    await validateAndFilterModels(
      [runner],
      undefined,
      undefined,
      'eliza-key',
      'meta/llama-3.1-8b-instruct',
      undefined,
      undefined,
    );
    expect(nvidiaFetch).toHaveBeenCalledWith('nv-cloud-from-env');
  });
});
