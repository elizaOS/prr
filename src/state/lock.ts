/**
 * Distributed lock manager for coordinating multiple prr instances.
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
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

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

export class LockManager {
  private workdir: string;
  private lockPath: string;
  private instanceId: string;
  private hostName: string;
  private lockDurationMs: number;
  private enabled: boolean;
  
  constructor(workdir: string, options: { enabled?: boolean; lockDurationMs?: number } = {}) {
    this.workdir = workdir;
    this.lockPath = join(workdir, LOCK_FILENAME);
    this.instanceId = randomUUID().slice(0, 8);
    this.hostName = hostname();
    this.lockDurationMs = options.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;
    this.enabled = options.enabled ?? true;
  }
  
  /**
   * Check if locking is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
  
  /**
   * Read the current lock file
   */
  async readLock(): Promise<LockFile | null> {
    if (!existsSync(this.lockPath)) {
      return null;
    }
    
    try {
      const content = await readFile(this.lockPath, 'utf-8');
      return JSON.parse(content) as LockFile;
    } catch (error) {
      debug('Failed to read lock file', { error: String(error) });
      return null;
    }
  }
  
  /**
   * Write the lock file
   */
  private async writeLock(lock: LockFile): Promise<void> {
    await writeFile(this.lockPath, JSON.stringify(lock, null, 2), 'utf-8');
  }
  
  /**
   * Create or update our lock, claiming specific issues
   */
  async claimIssues(issueIds: string[]): Promise<{ claimed: string[]; alreadyClaimed: string[] }> {
    if (!this.enabled) {
      return { claimed: issueIds, alreadyClaimed: [] };
    }
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.lockDurationMs);
    
    let lock = await this.readLock();
    
    // If lock exists from another instance, check what's still valid
    const validClaims: IssueClaim[] = [];
    const alreadyClaimed: string[] = [];
    
    if (lock && lock.instanceId !== this.instanceId) {
      // Filter out expired claims from other instance
      for (const claim of lock.claims) {
        if (new Date(claim.expiresAt) > now) {
          validClaims.push(claim);
          if (issueIds.includes(claim.issueId)) {
            alreadyClaimed.push(claim.issueId);
          }
        }
      }
    }
    
    // Determine which issues we can claim
    const claimableIssues = issueIds.filter(id => !alreadyClaimed.includes(id));
    
    // Create new claims for our instance
    const ourClaims: IssueClaim[] = claimableIssues.map(issueId => ({
      issueId,
      claimedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }));
    
    // Also preserve our existing unexpired claims
    if (lock && lock.instanceId === this.instanceId) {
      for (const claim of lock.claims) {
        if (new Date(claim.expiresAt) > now && !claimableIssues.includes(claim.issueId)) {
          ourClaims.push(claim);
        }
      }
    }
    
    // Write the new lock file
    const newLock: LockFile = {
      version: 1,
      instanceId: this.instanceId,
      hostname: this.hostName,
      startedAt: lock?.instanceId === this.instanceId ? lock.startedAt : now.toISOString(),
      lastHeartbeat: now.toISOString(),
      claims: [...validClaims.filter(c => lock?.instanceId !== this.instanceId), ...ourClaims],
    };
    
    await this.writeLock(newLock);
    debug('Claimed issues', { claimed: claimableIssues, alreadyClaimed });
    
    return { claimed: claimableIssues, alreadyClaimed };
  }
  
  /**
   * Release our claims (call when done or on shutdown)
   */
  async releaseClaims(issueIds?: string[]): Promise<void> {
    if (!this.enabled) return;
    
    const lock = await this.readLock();
    if (!lock || lock.instanceId !== this.instanceId) {
      return; // Not our lock
    }
    
    if (issueIds) {
      // Release specific issues
      lock.claims = lock.claims.filter(c => !issueIds.includes(c.issueId));
    } else {
      // Release all our claims
      lock.claims = [];
    }
    
    lock.lastHeartbeat = new Date().toISOString();
    
    if (lock.claims.length === 0) {
      // No more claims - we could delete the file, but leave it for debugging
      await this.writeLock(lock);
    } else {
      await this.writeLock(lock);
    }
    
    debug('Released claims', { issueIds: issueIds ?? 'all' });
  }
  
  /**
   * Update heartbeat to show we're still active
   */
  async heartbeat(): Promise<void> {
    if (!this.enabled) return;
    
    const lock = await this.readLock();
    if (!lock || lock.instanceId !== this.instanceId) {
      return;
    }
    
    // Extend expiration on all our claims
    const now = new Date();
    const newExpiry = new Date(now.getTime() + this.lockDurationMs);
    
    lock.lastHeartbeat = now.toISOString();
    lock.claims = lock.claims.map(claim => ({
      ...claim,
      expiresAt: newExpiry.toISOString(),
    }));
    
    await this.writeLock(lock);
    debug('Heartbeat updated', { instanceId: this.instanceId });
  }
  
  /**
   * Check which issues are claimed by others (not expired)
   */
  async getClaimedByOthers(): Promise<string[]> {
    if (!this.enabled) return [];
    
    const lock = await this.readLock();
    if (!lock || lock.instanceId === this.instanceId) {
      return [];
    }
    
    const now = new Date();
    return lock.claims
      .filter(c => new Date(c.expiresAt) > now)
      .map(c => c.issueId);
  }
  
  /**
   * Force clear all locks (--clear-lock option)
   */
  async clearLock(git?: SimpleGit): Promise<void> {
    if (existsSync(this.lockPath)) {
      // Remove from git if tracked
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
      
      // Delete the file
      const { unlink } = await import('fs/promises');
      await unlink(this.lockPath);
      debug('Deleted lock file');
    }
  }
  
  /**
   * Get lock status for display
   */
  async getStatus(): Promise<{
    isLocked: boolean;
    isOurs: boolean;
    holder?: { instanceId: string; hostname: string; startedAt: string };
    claimedIssues: string[];
    expiredClaims: number;
  }> {
    const lock = await this.readLock();
    
    if (!lock) {
      return { isLocked: false, isOurs: false, claimedIssues: [], expiredClaims: 0 };
    }
    
    const now = new Date();
    const validClaims = lock.claims.filter(c => new Date(c.expiresAt) > now);
    const expiredClaims = lock.claims.length - validClaims.length;
    
    return {
      isLocked: validClaims.length > 0,
      isOurs: lock.instanceId === this.instanceId,
      holder: {
        instanceId: lock.instanceId,
        hostname: lock.hostname,
        startedAt: lock.startedAt,
      },
      claimedIssues: validClaims.map(c => c.issueId),
      expiredClaims,
    };
  }
}
