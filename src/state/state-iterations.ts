/**
 * Iteration tracking
 */
import type { StateContext } from './state-context.js';
import { getState } from './state-context.js';
import type { Iteration, VerificationResult } from './types.js';

export function startIteration(ctx: StateContext): Iteration {
  const state = getState(ctx);

  const iteration: Iteration = {
    timestamp: new Date().toISOString(),
    commentsAddressed: [],
    changesMade: [],
    verificationResults: {},
  };

  state.iterations.push(iteration);
  return iteration;
}

export function getCurrentIteration(ctx: StateContext): Iteration | null {
  const state = ctx.state;
  if (!state || state.iterations.length === 0) {
    return null;
  }
  return state.iterations[state.iterations.length - 1];
}

export function addCommentToIteration(ctx: StateContext, commentId: string): void {
  const iteration = getCurrentIteration(ctx);
  if (iteration && !iteration.commentsAddressed.includes(commentId)) {
    iteration.commentsAddressed.push(commentId);
  }
}

export function addChangeToIteration(ctx: StateContext, file: string, description: string): void {
  const iteration = getCurrentIteration(ctx);
  if (iteration) {
    iteration.changesMade.push({ file, description });
  }
}

export function addVerificationResult(ctx: StateContext, commentId: string, result: VerificationResult): void {
  const iteration = getCurrentIteration(ctx);
  if (iteration) {
    iteration.verificationResults[commentId] = result;
  }
}
