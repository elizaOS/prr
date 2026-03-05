/**
 * Distributed lock functions for coordinating multiple prr instances.
 * 
 * WHY: When multiple prr instances work on the same PR, they might duplicate
 * work or conflict. This lock system allows claiming specific issues.
 * 
 * Design:
 * - Lock file stored in PR repo: .prr-lock.json
 * - Issue-level claiming (not whole PR)
 * - Time-based expiration (default 15 minutes)
 * - Lock includes machine identifier for debugging
 */
import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import type { SimpleGit } from 'simple-git';
import { debug } from '../../../shared/logger.js';

const LOCK_FILENAME = '.prr-lock.json';
const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export interface IssueClaim {
  issueId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface LockFile {
  version: 1;
  instanceId: string;
  hostname: string;
  startedAt: string;
  lastHeartbeat: string;
  claims: IssueClaim[];
}

export interface LockConfig {
  workdir: string;
  instanceId: string;
  hostName: string;
  lockDurationMs: number;
  enabled: boolean;
}

export function createLockConfig(workdir: string, options: { enabled?: boolean; lockDurationMs?: number } = {}): LockConfig {
  return {
    workdir,
    instanceId: randomUUID().slice(0, 8),
    hostName: hostname(),
    lockDurationMs: options.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS,
    enabled: options.enabled ?? true,
  };
}

function getLockPath(config: LockConfig): string {
  return join(config.workdir, LOCK_FILENAME);
}

export function isLockEnabled(config: LockConfig): boolean {
  return config.enabled;
}

export async function readLock(config: LockConfig): Promise<LockFile | null> {
  const lockPath = getLockPath(config);
  if (!existsSync(lockPath)) {
    return null;
  }
  
  try {
    const content = await readFile(lockPath, 'utf-8');
    return JSON.parse(content) as LockFile;
  } catch (error) {
    debug('Failed to read lock file', { error: String(error) });
    return null;
  }
}

async function writeLock(config: LockConfig, lock: LockFile): Promise<void> {
  const lockPath = getLockPath(config);
  await writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf-8');
}

export async function claimIssues(config: LockConfig, issueIds: string[]): Promise<{ claimed: string[]; alreadyClaimed: string[] }> {
  if (!config.enabled) {
    return { claimed: issueIds, alreadyClaimed: [] };
  }
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.lockDurationMs);
  
  let lock = await readLock(config);
  
  const validClaims: IssueClaim[] = [];
  const alreadyClaimed: string[] = [];
  
  if (lock && lock.instanceId !== config.instanceId) {
    for (const claim of lock.claims) {
      if (new Date(claim.expiresAt) > now) {
        validClaims.push(claim);
        if (issueIds.includes(claim.issueId)) {
          alreadyClaimed.push(claim.issueId);
        }
      }
    }
  }
  
  const claimableIssues = issueIds.filter(id => !alreadyClaimed.includes(id));
  
  const ourClaims: IssueClaim[] = claimableIssues.map(issueId => ({
    issueId,
    claimedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }));
  
  if (lock && lock.instanceId === config.instanceId) {
    for (const claim of lock.claims) {
      if (new Date(claim.expiresAt) > now && !claimableIssues.includes(claim.issueId)) {
        ourClaims.push(claim);
      }
    }
  }
  
  const newLock: LockFile = {
    version: 1,
    instanceId: config.instanceId,
    hostname: config.hostName,
    startedAt: lock?.instanceId === config.instanceId ? lock.startedAt : now.toISOString(),
    lastHeartbeat: now.toISOString(),
    claims: [...validClaims.filter(c => lock?.instanceId !== config.instanceId), ...ourClaims],
  };
  
  await writeLock(config, newLock);
  debug('Claimed issues', { claimed: claimableIssues, alreadyClaimed });
  
  return { claimed: claimableIssues, alreadyClaimed };
}

export async function releaseClaims(config: LockConfig, issueIds?: string[]): Promise<void> {
  if (!config.enabled) return;
  
  const lock = await readLock(config);
  if (!lock || lock.instanceId !== config.instanceId) {
    return;
  }
  
  if (issueIds) {
    lock.claims = lock.claims.filter(c => !issueIds.includes(c.issueId));
  } else {
    lock.claims = [];
  }
  
  lock.lastHeartbeat = new Date().toISOString();
  await writeLock(config, lock);
  debug('Released claims', { issueIds: issueIds ?? 'all' });
}

export async function heartbeat(config: LockConfig): Promise<void> {
  if (!config.enabled) return;
  
  const lock = await readLock(config);
  if (!lock || lock.instanceId !== config.instanceId) {
    return;
  }
  
  const now = new Date();
  const newExpiry = new Date(now.getTime() + config.lockDurationMs);
  
  lock.lastHeartbeat = now.toISOString();
  lock.claims = lock.claims.map(claim => ({
    ...claim,
    expiresAt: newExpiry.toISOString(),
  }));
  
  await writeLock(config, lock);
  debug('Heartbeat updated', { instanceId: config.instanceId });
}

export async function getClaimedByOthers(config: LockConfig): Promise<string[]> {
  if (!config.enabled) return [];
  
  const lock = await readLock(config);
  if (!lock || lock.instanceId === config.instanceId) {
    return [];
  }
  
  const now = new Date();
  return lock.claims
    .filter(c => new Date(c.expiresAt) > now)
    .map(c => c.issueId);
}

export async function clearLock(config: LockConfig, git?: SimpleGit): Promise<void> {
  const lockPath = getLockPath(config);
  if (existsSync(lockPath)) {
    if (git) {
      try {
        const tracked = await git.raw(['ls-files', LOCK_FILENAME]).catch(() => '');
        if (tracked.trim()) {
          await git.raw(['rm', '--cached', LOCK_FILENAME]);
          debug('Removed lock file from git tracking');
        }
      } catch {
        // Ignore
      }
    }
    
    await unlink(lockPath);
    debug('Deleted lock file');
  }
}

export async function getLockStatus(config: LockConfig): Promise<{
  isLocked: boolean;
  isOurs: boolean;
  holder?: { instanceId: string; hostname: string; startedAt: string };
  claimedIssues: string[];
  expiredClaims: number;
}> {
  const lock = await readLock(config);
  
  if (!lock) {
    return { isLocked: false, isOurs: false, claimedIssues: [], expiredClaims: 0 };
  }
  
  const now = new Date();
  const validClaims = lock.claims.filter(c => new Date(c.expiresAt) > now);
  const expiredClaims = lock.claims.length - validClaims.length;
  
  return {
    isLocked: validClaims.length > 0,
    isOurs: lock.instanceId === config.instanceId,
    holder: {
      instanceId: lock.instanceId,
      hostname: lock.hostname,
      startedAt: lock.startedAt,
    },
    claimedIssues: validClaims.map(c => c.issueId),
    expiredClaims,
  };
}
