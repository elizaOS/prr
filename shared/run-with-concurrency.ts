/**
 * Run an array of promise-returning tasks with a concurrency limit.
 * Results are returned in the same order as the input tasks.
 * WHY: Single worker-pool implementation for analysis batches, parallel fix groups, etc.;
 * order preservation keeps issue-to-result mapping correct without extra bookkeeping.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
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
  limit: number
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      const result = await Promise.resolve(tasks[i]!()).then(
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
