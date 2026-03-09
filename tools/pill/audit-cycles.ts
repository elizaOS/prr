/**
 * Audit-cycle storage per directory (AUDIT-CYCLES.md–like data structure).
 * Each directory passed to pill can have a .pill/audit-cycles.json store that holds
 * recorded cycles (artifacts, findings, improvements, flip-flop check).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { AuditCycle, PillAuditStore } from './types.js';

const AUDIT_DIR = '.pill';
const AUDIT_FILENAME = 'audit-cycles.json';

/** Path to the audit-cycles.json file for the given target directory. */
export function getAuditCyclesPath(targetDir: string): string {
  return join(targetDir, AUDIT_DIR, AUDIT_FILENAME);
}

/** Load the audit store for the directory, or null if missing/invalid. */
export function loadAuditCycles(targetDir: string): PillAuditStore | null {
  const path = getAuditCyclesPath(targetDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object' || !Array.isArray((data as PillAuditStore).cycles)) {
      return null;
    }
    const store = data as PillAuditStore;
    // Normalize: ensure directory is current target (in case dir was moved)
    store.directory = targetDir;
    store.lastUpdated = typeof store.lastUpdated === 'string' ? store.lastUpdated : new Date().toISOString();
    store.recordedCycles = Array.isArray(store.cycles) ? store.cycles.length : 0;
    return store;
  } catch {
    return null;
  }
}

/** Save the audit store for the directory. Creates .pill if needed. */
export function saveAuditCycles(targetDir: string, store: PillAuditStore): void {
  const dir = join(targetDir, AUDIT_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = getAuditCyclesPath(targetDir);
  const toWrite: PillAuditStore = {
    ...store,
    directory: targetDir,
    lastUpdated: new Date().toISOString(),
    recordedCycles: store.cycles.length,
  };
  writeFileSync(path, JSON.stringify(toWrite, null, 2), 'utf-8');
}

/** Append a cycle to the store for the directory; creates store if missing. Returns the updated store. */
export function appendCycle(targetDir: string, cycle: AuditCycle): PillAuditStore {
  const existing = loadAuditCycles(targetDir);
  const store: PillAuditStore = existing ?? {
    directory: targetDir,
    lastUpdated: new Date().toISOString(),
    recordedCycles: 0,
    cycles: [],
  };
  store.cycles.push(cycle);
  store.lastUpdated = new Date().toISOString();
  store.recordedCycles = store.cycles.length;
  saveAuditCycles(targetDir, store);
  return store;
}

/** Create an empty store for the directory (e.g. first run). Optionally set recurring patterns / watchlist. */
export function initAuditStore(
  targetDir: string,
  options?: { recurringPatterns?: PillAuditStore['recurringPatterns']; regressionWatchlist?: string[] }
): PillAuditStore {
  const store: PillAuditStore = {
    directory: targetDir,
    lastUpdated: new Date().toISOString(),
    recordedCycles: 0,
    cycles: [],
    ...(options?.recurringPatterns && { recurringPatterns: options.recurringPatterns }),
    ...(options?.regressionWatchlist && { regressionWatchlist: options.regressionWatchlist }),
  };
  saveAuditCycles(targetDir, store);
  return store;
}
