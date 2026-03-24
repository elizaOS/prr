import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parsePoolTaskTimeoutMs,
  runWithConcurrency,
  runWithConcurrencyAllSettled,
} from '../shared/run-with-concurrency.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('parsePoolTaskTimeoutMs', () => {
  const key = 'PRR_LLM_TASK_TIMEOUT_MS';
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[key];
    delete process.env[key];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });

  it('returns undefined when unset, empty, zero, or negative', () => {
    expect(parsePoolTaskTimeoutMs()).toBeUndefined();
    process.env[key] = '';
    expect(parsePoolTaskTimeoutMs()).toBeUndefined();
    process.env[key] = '0';
    expect(parsePoolTaskTimeoutMs()).toBeUndefined();
    process.env[key] = '-1';
    expect(parsePoolTaskTimeoutMs()).toBeUndefined();
  });

  it('returns undefined for invalid integer', () => {
    process.env[key] = 'nope';
    expect(parsePoolTaskTimeoutMs()).toBeUndefined();
  });

  it('clamps to minimum 5,000 ms', () => {
    process.env[key] = '100';
    expect(parsePoolTaskTimeoutMs()).toBe(5000);
  });

  it('accepts valid values', () => {
    process.env[key] = '60000';
    expect(parsePoolTaskTimeoutMs()).toBe(60_000);
  });
});

describe('runWithConcurrency per-task timeout (options.taskTimeoutMs)', () => {
  it('rejects a task that exceeds the timeout', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => sleep(500).then(() => 2),
    ];
    await expect(runWithConcurrency(tasks, 2, { taskTimeoutMs: 50 })).rejects.toThrow(/exceeded timeout/);
  });

  it('AllSettled marks slow tasks as rejected', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => sleep(500).then(() => 'b'),
    ];
    const settled = await runWithConcurrencyAllSettled(tasks, 2, { taskTimeoutMs: 50 });
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(settled[1]?.status).toBe('rejected');
    expect(String((settled[1] as PromiseRejectedResult).reason)).toMatch(/exceeded timeout/);
  });
});
