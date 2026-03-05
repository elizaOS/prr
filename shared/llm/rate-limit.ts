/**
 * Concurrency limiter for ElizaCloud API.
 * WHY: ElizaCloud returns 429 when too many requests are in flight.
 * We cap in-flight requests and space out starts.
 */
import { ELIZACLOUD_MAX_CONCURRENT_REQUESTS, ELIZACLOUD_MIN_DELAY_MS } from '../constants.js';

let elizacloudInFlight = 0;
let elizacloudLastStartTime = 0;
const elizacloudQueue: Array<() => void> = [];

/** Acquire ElizaCloud rate-limit slot (used by llm-api runner and LLM client). */
export async function acquireElizacloud(): Promise<void> {
  if (elizacloudInFlight < ELIZACLOUD_MAX_CONCURRENT_REQUESTS) {
    elizacloudInFlight++;
    const now = Date.now();
    const sinceLast = now - elizacloudLastStartTime;
    if (sinceLast < ELIZACLOUD_MIN_DELAY_MS) {
      await new Promise(r => setTimeout(r, ELIZACLOUD_MIN_DELAY_MS - sinceLast));
    }
    elizacloudLastStartTime = Date.now();
    return;
  }
  await new Promise<void>(resolve => {
    elizacloudQueue.push(() => {
      elizacloudInFlight++;
      const now = Date.now();
      const sinceLast = now - elizacloudLastStartTime;
      if (sinceLast < ELIZACLOUD_MIN_DELAY_MS) {
        setTimeout(() => {
          elizacloudLastStartTime = Date.now();
          resolve();
        }, ELIZACLOUD_MIN_DELAY_MS - sinceLast);
      } else {
        elizacloudLastStartTime = Date.now();
        resolve();
      }
    });
  });
}

/** Release ElizaCloud rate-limit slot. */
export function releaseElizacloud(): void {
  if (elizacloudInFlight > 0) {
    elizacloudInFlight--;
    const next = elizacloudQueue.shift();
    if (next) next();
  }
}
