import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Runner } from '../shared/runners/types.js';

const lmFetch = vi.fn(() => Promise.resolve(new Set<string>()));
const elizaFetch = vi.fn(() => Promise.resolve(new Set(['openai/gpt-4o'])));

vi.mock('../tools/prr/llm/provider-probes.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../tools/prr/llm/provider-probes.js')>();
  return {
    ...orig,
    fetchAvailableLmStudioModels: (...args: Parameters<typeof orig.fetchAvailableLmStudioModels>) =>
      lmFetch(...args),
    fetchAvailableElizaCloudModels: (...args: Parameters<typeof orig.fetchAvailableElizaCloudModels>) =>
      elizaFetch(...args),
  };
});

import { validateAndFilterModels } from '../tools/prr/models/rotation.js';

describe('validateAndFilterModels — LM Studio empty model list', () => {
  let prevLlm: string | undefined;

  beforeEach(() => {
    prevLlm = process.env.PRR_LLM_PROVIDER;
    process.env.PRR_LLM_PROVIDER = 'lmstudio';
    lmFetch.mockClear();
    elizaFetch.mockClear();
  });

  afterEach(() => {
    if (prevLlm === undefined) delete process.env.PRR_LLM_PROVIDER;
    else process.env.PRR_LLM_PROVIDER = prevLlm;
  });

  it('keeps pinned fallback when /v1/models returns nothing (rotation must not strip all)', async () => {
    const pinned = 'local-model-id-123';
    const runner: Runner = {
      name: 'llm-api',
      displayName: 'Direct LLM API',
      provider: 'lmstudio',
      run: async () => ({ success: false, output: '' }),
      isAvailable: async () => true,
      checkStatus: async () => ({ installed: true, ready: true }),
    };
    const { removed } = await validateAndFilterModels(
      [runner],
      undefined,
      undefined,
      'eliza-test-key',
      pinned,
      undefined,
      undefined,
    );
    expect(lmFetch).toHaveBeenCalled();
    expect(runner.supportedModels).toEqual([pinned]);
    expect(removed.filter((r) => r.model === pinned)).toHaveLength(0);
  });
});
