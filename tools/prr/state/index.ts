/**
 * State management exports - procedural functions
 */

export { transitionIssue, type IssueStateTransition } from './state-transitions.js';
export type { MarkVerifiedOptions } from './state-verification.js';

// Core
export * from './state-context.js';
export * as Core from './state-core.js';

// Functional areas
export * as Verification from './state-verification.js';
export * as Dismissed from './state-dismissed.js';
export * as Lessons from './state-lessons.js';
export * as Iterations from './state-iterations.js';
export * as Rotation from './state-rotation.js';
export * as Performance from './state-performance.js';
export * as Bailout from './state-bailout.js';

// New lessons procedural API
export * from './lessons-index.js';

// Types
export * from './types.js';
