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

export type LessonsSyncTarget = 'claude-md' | 'conventions-md' | 'cursor-rules';

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
  };
}

export function setSkipClaudeMd(ctx: LessonsContext, skip: boolean): void {
  ctx.skipClaudeMd = skip;
  if (skip) {
    ctx.syncTargets = ctx.syncTargets.filter(t => t !== 'claude-md');
  }
}

export function setWorkdir(ctx: LessonsContext, workdir: string): void {
  ctx.workdir = workdir;
}

export function setSyncTargets(ctx: LessonsContext, targets: LessonsSyncTarget[]): void {
  ctx.syncTargets = targets;
}
