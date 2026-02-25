/**
 * Lessons context - replaces LessonsManager instance properties
 */

export interface LessonsStore {
  owner: string;
  repo: string;
  branch: string;
  lastUpdated: string;
  global: string[];
  files: Record<string, string[]>;
}

export type LessonsSyncTarget = 'claude-md' | 'agents-md' | 'conventions-md' | 'cursor-rules';

export interface SyncTargetConfig {
  path: (workdir: string) => string;
  description: string;
  tools: string[];
  createHeader?: string;
}

export interface LessonsContext {
  store: LessonsStore;
  localStorePath: string;
  workdir: string | null;
  dirty: boolean;
  repoLessonsDirty: boolean;
  syncTargets: LessonsSyncTarget[];
  initialLessonCount: number;
  newLessonsThisSession: number;
  originalSyncTargetState: Map<LessonsSyncTarget, boolean>;
  skipClaudeMd: boolean;
  skipAgentsMd: boolean;
}

export function createLessonsContext(
  owner: string,
  repo: string,
  branch: string,
  localStorePath: string
): LessonsContext {
  return {
    store: {
      owner,
      repo,
      branch,
      lastUpdated: new Date().toISOString(),
      global: [],
      files: {},
    },
    localStorePath,
    workdir: null,
    dirty: false,
    repoLessonsDirty: false,
    syncTargets: ['claude-md'],
    initialLessonCount: 0,
    newLessonsThisSession: 0,
    originalSyncTargetState: new Map(),
    skipClaudeMd: false,
    skipAgentsMd: false,
  };
}

export function setSkipClaudeMd(ctx: LessonsContext, skip: boolean): void {
  ctx.skipClaudeMd = skip;
  if (skip) {
    ctx.syncTargets = ctx.syncTargets.filter(t => t !== 'claude-md');
  }
}

export function setSkipAgentsMd(ctx: LessonsContext, skip: boolean): void {
  ctx.skipAgentsMd = skip;
  if (skip) {
    ctx.syncTargets = ctx.syncTargets.filter(t => t !== 'agents-md');
  }
}

export function setWorkdir(ctx: LessonsContext, workdir: string): void {
  ctx.workdir = workdir;
  // Auto-detect sync targets based on files present in workdir
  autoDetectSyncTargets(ctx);
}

/**
 * Auto-detect which sync targets exist in the workdir.
 * Called automatically by setWorkdir to restore the old LessonsManager behavior.
 */
function autoDetectSyncTargets(ctx: LessonsContext): void {
  if (!ctx.workdir) return;
  
  const { existsSync } = require('fs');
  const { join } = require('path');
  
  const targets: LessonsSyncTarget[] = [];
  
  // Check for CLAUDE.md
  if (!ctx.skipClaudeMd && existsSync(join(ctx.workdir, 'CLAUDE.md'))) {
    targets.push('claude-md');
  }
  
  // Check for AGENTS.md
  if (!ctx.skipAgentsMd && existsSync(join(ctx.workdir, 'AGENTS.md'))) {
    targets.push('agents-md');
  }
  
  // Check for CONVENTIONS.md
  if (existsSync(join(ctx.workdir, 'CONVENTIONS.md'))) {
    targets.push('conventions-md');
  }
  
  // Check for .cursor/rules (cursor rules)
  if (existsSync(join(ctx.workdir, '.cursor', 'rules'))) {
    targets.push('cursor-rules');
  }
  
  // Default to claude-md if nothing detected but not skipped
  if (targets.length === 0 && !ctx.skipClaudeMd) {
    targets.push('claude-md');
  }
  
  ctx.syncTargets = targets;
}

export function setSyncTargets(ctx: LessonsContext, targets: LessonsSyncTarget[]): void {
  ctx.syncTargets = targets;
}
