import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';

export function computeWorkdirHash(owner: string, repo: string, prNumber: number): string {
  const input = `${owner}/${repo}#${prNumber}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

export function getWorkdirPath(baseDir: string, owner: string, repo: string, prNumber: number): string {
  const hash = computeWorkdirHash(owner, repo, prNumber);
  return join(baseDir, hash);
}

export async function ensureWorkdir(workdir: string): Promise<void> {
  if (!existsSync(workdir)) {
    await mkdir(workdir, { recursive: true });
  }
}

export function workdirExists(workdir: string): boolean {
  return existsSync(workdir);
}

export async function cleanupWorkdir(workdir: string): Promise<void> {
  if (existsSync(workdir)) {
    await rm(workdir, { recursive: true, force: true });
  }
}

export interface WorkdirInfo {
  path: string;
  hash: string;
  exists: boolean;
}

export function getWorkdirInfo(baseDir: string, owner: string, repo: string, prNumber: number): WorkdirInfo {
  const hash = computeWorkdirHash(owner, repo, prNumber);
  const path = join(baseDir, hash);
  return {
    path,
    hash,
    exists: existsSync(path),
  };
}
