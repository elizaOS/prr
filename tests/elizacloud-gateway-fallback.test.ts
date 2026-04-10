import { afterEach, describe, expect, it } from 'vitest';
import { getElizacloudGatewayFallbackModels } from '../shared/constants.js';

afterEach(() => {
  delete process.env.PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS;
  delete process.env.PRR_ELIZACLOUD_INCLUDE_MODELS;
});

describe('getElizacloudGatewayFallbackModels', () => {
  it('default chain drops skip-listed mini/4o but keeps other ids for qwen primary', () => {
    const out = getElizacloudGatewayFallbackModels('alibaba/qwen-3-14b');
    expect(out.some((m) => m.includes('haiku'))).toBe(true);
    expect(out.some((m) => m.includes('sonnet'))).toBe(true);
    expect(out.some((m) => m.includes('gpt-4o-mini'))).toBe(false);
    expect(out.some((m) => m === 'openai/gpt-4o')).toBe(false);
  });

  it('returns off when PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS=off', () => {
    process.env.PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS = 'off';
    expect(getElizacloudGatewayFallbackModels('alibaba/qwen-3-14b')).toEqual([]);
  });

  it('excludes primary and dedupes', () => {
    process.env.PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS =
      'anthropic/claude-3-5-haiku-20241022,anthropic/claude-3-5-haiku-20241022';
    const out = getElizacloudGatewayFallbackModels('alibaba/qwen-3-14b');
    expect(out).toEqual(['anthropic/claude-3-5-haiku-20241022']);
  });

  it('excludes primary when it appears in list', () => {
    process.env.PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS =
      'alibaba/qwen-3-14b,anthropic/claude-3-5-haiku-20241022';
    expect(getElizacloudGatewayFallbackModels('alibaba/qwen-3-14b')).toEqual([
      'anthropic/claude-3-5-haiku-20241022',
    ]);
  });

  it('PRR_ELIZACLOUD_INCLUDE_MODELS can unblock skipped defaults for fallback list', () => {
    process.env.PRR_ELIZACLOUD_GATEWAY_FALLBACK_MODELS = 'openai/gpt-4o-mini';
    expect(getElizacloudGatewayFallbackModels('alibaba/qwen-3-14b')).toEqual([]);
    process.env.PRR_ELIZACLOUD_INCLUDE_MODELS = 'openai/gpt-4o-mini';
    expect(getElizacloudGatewayFallbackModels('alibaba/qwen-3-14b')).toEqual(['openai/gpt-4o-mini']);
  });
});
