/**
 * Path resolution for lessons storage
 */
import { join } from 'path';
import { homedir } from 'os';
import type { LessonsSyncTarget, SyncTargetConfig } from './lessons-context.js';

/**
 * Get path to machine-local lessons JSON file
 */
export function getLocalLessonsPath(owner: string, repo: string, branch: string): string {
  const safeBranch = branch.replace(/[/\\:*?"<>|]/g, '_');
  return join(homedir(), '.prr', 'lessons', owner, repo, `${safeBranch}.json`);
}

/**
 * Get path to canonical lessons file (.prr/lessons.md)
 */
export function getPrrLessonsPath(workdir: string): string {
  if (!workdir) {
    throw new Error('Cannot get prr lessons path: workdir is required');
  }
  return join(workdir, '.prr', 'lessons.md');
}

/**
 * Sync target configurations
 */
export const SYNC_TARGETS: Record<LessonsSyncTarget, SyncTargetConfig> = {
  'claude-md': {
    path: (workdir) => {
      if (!workdir) throw new Error('workdir required for CLAUDE.md path');
      return join(workdir, 'CLAUDE.md');
    },
    description: 'CLAUDE.md',
    tools: ['Cursor', 'Claude Code'],
    createHeader: '# Project Configuration\n\n',
  },
  'agents-md': {
    path: (workdir) => {
      if (!workdir) throw new Error('workdir required for AGENTS.md path');
      return join(workdir, 'AGENTS.md');
    },
    description: 'AGENTS.md',
    tools: ['OpenAI Codex'],
    createHeader: '# Agent Instructions\n\n',
  },
  'conventions-md': {
    path: (workdir) => {
      if (!workdir) throw new Error('workdir required for CONVENTIONS.md path');
      return join(workdir, 'CONVENTIONS.md');
    },
    description: 'CONVENTIONS.md',
    tools: ['Aider'],
    createHeader: '# Coding Conventions\n\n',
  },
  'cursor-rules': {
    path: (workdir) => {
      if (!workdir) throw new Error('workdir required for cursor-rules path');
      return join(workdir, '.cursor', 'rules', 'prr-lessons.mdc');
    },
    description: '.cursor/rules/',
    tools: ['Cursor'],
    createHeader: '',
  },
};

/**
 * PRR section delimiters for syncing
 */
export const PRR_SECTION_START = '<!-- PRR_LESSONS_START -->';
export const PRR_SECTION_END = '<!-- PRR_LESSONS_END -->';

/**
 * Compaction limits for sync targets
 */
export const MAX_GLOBAL_LESSONS_FOR_SYNC = 20;
export const MAX_FILE_LESSONS_FOR_SYNC = 5;
// Review: maximum sync limits ensure efficient resource usage and prevent overload.
export const MAX_FILES_FOR_SYNC = 10;
