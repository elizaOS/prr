import { afterEach, describe, expect, it } from 'vitest';
import { getElizacloudServerErrorMaxRetries } from '../shared/constants.js';

const keys = ['PRR_ELIZACLOUD_SERVER_ERROR_RETRIES', 'CI'] as const;

afterEach(() => {
  for (const k of keys) delete process.env[k];
});

describe('getElizacloudServerErrorMaxRetries', () => {
  it('defaults to 2 when not CI', () => {
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
  });

  it('defaults to 4 when CI=true', () => {
    process.env.CI = 'true';
    expect(getElizacloudServerErrorMaxRetries()).toBe(4);
  });

  it('env overrides CI default', () => {
    process.env.CI = 'true';
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '7';
    expect(getElizacloudServerErrorMaxRetries()).toBe(7);
  });

  it('invalid env falls through to non-CI default', () => {
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = 'not-a-number';
    expect(getElizacloudServerErrorMaxRetries()).toBe(2);
  });

  it('invalid env falls through to CI default', () => {
    process.env.CI = 'true';
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '999';
    expect(getElizacloudServerErrorMaxRetries()).toBe(4);
  });

  it('allows zero retries', () => {
    process.env.PRR_ELIZACLOUD_SERVER_ERROR_RETRIES = '0';
    expect(getElizacloudServerErrorMaxRetries()).toBe(0);
  });
});
