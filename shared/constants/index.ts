/**
 * Global constants for PRR (PR Resolver).
 *
 * WHY: Domain-scoped modules under `constants/`; this barrel re-exports the former
 * `shared/constants.ts` surface so existing `from '../shared/constants.js'` imports unchanged.
 */
export * from './clone.js';
export * from './llm.js';
export * from './models.js';
export * from './fix-loop.js';
export * from './verification.js';
export * from './polling.js';
export * from './git-constants.js';
export * from './snippets.js';
export * from './state-constants.js';
export * from './runners.js';
