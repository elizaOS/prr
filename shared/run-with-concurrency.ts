/**
 * Run an array of promise-returning tasks with a concurrency limit.
 * Results are returned in the same order as the input tasks.
 * WHY: Single worker-pool implementation for analysis batches, parallel fix groups, etc.;
 * order preservation keeps issue-to-result mapping correct without extra bookkeeping.
 */
import { debug, formatNumber } from './logger.js';

/**
 * Optional per-task wall-clock cap for pool workers (batch analysis, parallel fix groups).
 * Unset or non-positive: no cap (default). Invalid values log a debug line when verbose and disable the cap.
 * WHY: Rare hung HTTP/stream paths can stall one worker indefinitely; this fails that slot so AllSettled can merge partial results.
 */
export function parsePoolTaskTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.PRR_LLM_TASK_TIMEOUT_MS;
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    debug('PRR_LLM_TASK_TIMEOUT_MS is set but not a valid integer; pool task timeout disabled', { raw });
    return undefined;
  }
  if (n <= 0) return undefined;
  return Math.max(5000, n);
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    id = setTimeout(() => {
      reject(new Error(`Task exceeded timeout of ${formatNumber(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (id !== undefined) clearTimeout(id);
  });
}

async function runTask<T>(task: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return task();
  return raceWithTimeout(task(), timeoutMs);
}

/** Optional per-invocation overrides (e.g. tests). */
export interface RunWithConcurrencyOptions {
  /**
   * Per-task timeout for this call only; skips `PRR_LLM_TASK_TIMEOUT_MS`.
   * Positive ms values apply as-is (tests may use small values). Omit for env/default.
   */
  taskTimeoutMs?: number;
}

function resolveTaskTimeoutMs(options?: RunWithConcurrencyOptions): number | undefined {
  if (options?.taskTimeoutMs !== undefined) {
    return options.taskTimeoutMs > 0 ? options.taskTimeoutMs : undefined;
  }
  return parsePoolTaskTimeoutMs();
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  /** Optional; use `taskTimeoutMs` to override env for this call. */
  options?: RunWithConcurrencyOptions
): Promise<T[]> {
  const taskTimeoutMs = resolveTaskTimeoutMs(options);
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await runTask(tasks[i]!, taskTimeoutMs);
    }
  }
  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Like runWithConcurrency but uses Promise.allSettled per task so that
 * results are returned in order and partial results are available when some tasks reject.
 * WHY: Batch analysis can have one failing batch; we still want verdicts for the rest
 * and to avoid one 429/timeout failing the whole analysis phase.
 */
export async function runWithConcurrencyAllSettled<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  options?: RunWithConcurrencyOptions
): Promise<Array<PromiseSettledResult<T>>> {
  const taskTimeoutMs = resolveTaskTimeoutMs(options);
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      const result = await runTask(() => tasks[i]!(), taskTimeoutMs).then(
        (value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
        (reason): PromiseRejectedResult => ({ status: 'rejected', reason })
      );
      results[i] = result;
    }
  }
  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
