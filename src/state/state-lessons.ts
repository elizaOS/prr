/**
 * Lessons learned tracking
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';

export function addLesson(ctx: StateContext, lesson: string): void {
  const state = getState(ctx);
  
  const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
  const key = keyMatch ? keyMatch[1] : null;
  
  if (key) {
    const existingIndex = state.lessonsLearned.findIndex(l => l.startsWith(`Fix for ${key}`));
    if (existingIndex !== -1) {
      state.lessonsLearned[existingIndex] = lesson;
      return;
    }
  }
  
  if (!state.lessonsLearned.includes(lesson)) {
    state.lessonsLearned.push(lesson);
  }
}

export function getLessons(ctx: StateContext): string[] {
  return ctx.state?.lessonsLearned || [];
}

export function getLessonCount(ctx: StateContext): number {
  return ctx.state?.lessonsLearned.length || 0;
}

export function compactLessons(ctx: StateContext): number {
  const state = ctx.state;
  if (!state) return 0;
  
  const lessonsByKey = new Map<string, string>();
  const before = state.lessonsLearned.length;
  let uniqueCounter = 0;
  
  for (const lesson of state.lessonsLearned) {
    const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
    const key = keyMatch ? keyMatch[1] : `unique_${uniqueCounter++}`;
    
    lessonsByKey.set(key, lesson);
  }

  state.lessonsLearned = Array.from(lessonsByKey.values());
  return before - state.lessonsLearned.length;
}
