import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LLMAPIRunner } from '../shared/runners/llm-api.js';

describe('LLMAPIRunner explicit PRR_LLM_PROVIDER', () => {
  const keys = [
    'PRR_LLM_PROVIDER',
    'OPENROUTER_API_KEY',
    'ELIZACLOUD_API_KEY',
    'NVIDIA_API_KEY',
    'NVIDIA_CLOUD_API_KEY',
  ] as const;
  const prev: Partial<Record<(typeof keys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('checkStatus prefers openrouter when PRR_LLM_PROVIDER=openrouter and key is set', async () => {
    process.env.PRR_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.ELIZACLOUD_API_KEY = 'eliza-test';
    const r = new LLMAPIRunner();
    const st = await r.checkStatus();
    expect(st.ready).toBe(true);
    expect(r.provider).toBe('openrouter');
  });

  it('checkStatus fails when PRR_LLM_PROVIDER=openrouter without OPENROUTER_API_KEY', async () => {
    process.env.PRR_LLM_PROVIDER = 'openrouter';
    process.env.ELIZACLOUD_API_KEY = 'eliza-test';
    const r = new LLMAPIRunner();
    const st = await r.checkStatus();
    expect(st.ready).toBe(false);
    expect(st.error).toMatch(/OPENROUTER_API_KEY/);
  });

  it('isAvailable returns false for explicit openrouter without key even if ElizaCloud key exists', async () => {
    process.env.PRR_LLM_PROVIDER = 'openrouter';
    process.env.ELIZACLOUD_API_KEY = 'eliza-test';
    const r = new LLMAPIRunner();
    expect(await r.isAvailable()).toBe(false);
  });

  it('isAvailable sets public provider when explicit openrouter and key are set', async () => {
    process.env.PRR_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const r = new LLMAPIRunner();
    await r.isAvailable();
    expect(r.provider).toBe('openrouter');
  });

  it('checkStatus prefers nvidiacloud when PRR_LLM_PROVIDER=nvidiacloud and NVIDIA key is set', async () => {
    process.env.PRR_LLM_PROVIDER = 'nvidiacloud';
    process.env.NVIDIA_API_KEY = 'nv-test-key';
    process.env.ELIZACLOUD_API_KEY = 'eliza-test';
    const r = new LLMAPIRunner();
    const st = await r.checkStatus();
    expect(st.ready).toBe(true);
    expect(r.provider).toBe('nvidiacloud');
  });

  it('checkStatus fails when PRR_LLM_PROVIDER=nvidiacloud without NVIDIA keys', async () => {
    process.env.PRR_LLM_PROVIDER = 'nvidiacloud';
    process.env.ELIZACLOUD_API_KEY = 'eliza-test';
    const r = new LLMAPIRunner();
    const st = await r.checkStatus();
    expect(st.ready).toBe(false);
    expect(st.error).toMatch(/NVIDIA_API_KEY|NVIDIA_CLOUD_API_KEY/);
  });

  it('isAvailable returns false for explicit nvidiacloud without key even if ElizaCloud key exists', async () => {
    process.env.PRR_LLM_PROVIDER = 'nvidiacloud';
    process.env.ELIZACLOUD_API_KEY = 'eliza-test';
    const r = new LLMAPIRunner();
    expect(await r.isAvailable()).toBe(false);
  });
});
