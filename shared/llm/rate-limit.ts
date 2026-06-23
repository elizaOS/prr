/**
 * Concurrency limiter for ElizaCloud API.
 * WHY: ElizaCloud returns 429 when too many requests are in flight.
 * We cap in-flight requests and space out starts. All caps use getEffectiveMaxConcurrentLLM()
 * so operators can tune via PRR_MAX_CONCURRENT_LLM. On 429, notifyRateLimitHit() reduces
 * effective concurrency temporarily so the next run self-corrects without code change.
 */
import { getEffectiveMaxConcurrentLLM, getEffectiveMinDelayMs } from '../constants.js';
import { debug } from '../logger.js';

let elizacloudInFlight = 0;
/** Time of the most recent slot acquisition (start of a request). Used to stagger starts. */
let elizacloudLastStartTime = 0;
const elizacloudQueue: Array<() => void> = [];

/** After a 429, we use halved concurrency for at least this long (plus jitter). */
const RATE_LIMIT_BACKOFF_MS = 60_000;
/** Extra random delay up to this many ms so concurrent processes don't wake in lockstep. */
const RATE_LIMIT_BACKOFF_JITTER_MS = 30_000;
let rateLimitBackoffUntil = 0;
let wasIn429Backoff = false;

function getMaxInFlight(): number {
  const cap = getEffectiveMaxConcurrentLLM();
  const inBackoff = Date.now() < rateLimitBackoffUntil;
  if (inBackoff) {
    wasIn429Backoff = true;
    return Math.max(1, Math.floor(cap / 2));
  }
  if (wasIn429Backoff && cap > 1) {
    debug('ElizaCloud 429 cooldown ended — restored full LLM concurrency', { cap });
  }
  wasIn429Backoff = false;
  return cap;
}

/** Call when a 429 (or rate-limit) response is received. Reduces effective concurrency for ~60s + jitter. */
export function notifyRateLimitHit(): void {
  const jitter = Math.floor(Math.random() * (RATE_LIMIT_BACKOFF_JITTER_MS + 1));
  rateLimitBackoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS + jitter;
}

/** Acquire ElizaCloud rate-limit slot (used by llm-api runner and LLM client). */
export async function acquireElizacloud(): Promise<void> {
  const maxInFlight = getMaxInFlight();
  const minDelayMs = getEffectiveMinDelayMs();

  if (elizacloudInFlight < maxInFlight) {
    elizacloudInFlight++;
    const now = Date.now();
    const sinceLast = now - elizacloudLastStartTime;
    if (sinceLast < minDelayMs) {
      await new Promise(r => setTimeout(r, minDelayMs - sinceLast));
    }
    elizacloudLastStartTime = Date.now();
    return;
  }
  await new Promise<void>(resolve => {
    elizacloudQueue.push(() => {
      elizacloudInFlight++;
      const now = Date.now();
      const sinceLast = now - elizacloudLastStartTime;
      if (sinceLast < minDelayMs) {
        setTimeout(() => {
          elizacloudLastStartTime = Date.now();
          resolve();
        }, minDelayMs - sinceLast);
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
