/**
 * Sync target detection
 */
import { existsSync } from 'fs';
import { join } from 'path';
import type { LessonsContext, LessonsSyncTarget } from './lessons-context.js';

export function autoDetectSyncTargets(ctx: LessonsContext): void {
  if (!ctx.workdir) {
    throw new Error('Cannot detect sync targets: workdir is required');
  }

  const detected: LessonsSyncTarget[] = [];

  if (!ctx.skipClaudeMd) {
    const claudeMdPath = join(ctx.workdir, 'CLAUDE.md');
    const claudeMdExists = existsSync(claudeMdPath);
    ctx.originalSyncTargetState.set('claude-md', claudeMdExists);
    detected.push('claude-md');
  }

  // AGENTS.md — used by OpenAI Codex CLI
  if (!ctx.skipAgentsMd) {
    const agentsMdPath = join(ctx.workdir, 'AGENTS.md');
    const agentsMdExists = existsSync(agentsMdPath);
    ctx.originalSyncTargetState.set('agents-md', agentsMdExists);
    if (agentsMdExists) {
      detected.push('agents-md');
    }
  }

  const conventionsMdPath = join(ctx.workdir, 'CONVENTIONS.md');
  const conventionsMdExists = existsSync(conventionsMdPath);
  ctx.originalSyncTargetState.set('conventions-md', conventionsMdExists);
  if (conventionsMdExists || existsSync(join(ctx.workdir, '.aider.conf.yml'))) {
    detected.push('conventions-md');
  }

  const cursorRulesPath = join(ctx.workdir, '.cursor', 'rules');
  const cursorRulesExists = existsSync(cursorRulesPath);
  ctx.originalSyncTargetState.set('cursor-rules', cursorRulesExists);
  if (cursorRulesExists) {
    detected.push('cursor-rules');
  }

  ctx.syncTargets = [...new Set(detected)];
}

export function didSyncTargetExist(ctx: LessonsContext, target: LessonsSyncTarget): boolean {
  return ctx.originalSyncTargetState.get(target) ?? false;
}
