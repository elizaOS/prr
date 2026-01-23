import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ResolverState, Iteration, VerificationResult } from './types.js';
import { createInitialState } from './types.js';

const STATE_FILENAME = '.pr-resolver-state.json';

export class StateManager {
  private statePath: string;
  private state: ResolverState | null = null;

  constructor(workdir: string) {
    this.statePath = join(workdir, STATE_FILENAME);
  }

  async load(pr: string, branch: string): Promise<ResolverState> {
    if (existsSync(this.statePath)) {
      try {
        const content = await readFile(this.statePath, 'utf-8');
        this.state = JSON.parse(content) as ResolverState;
        
        // Verify it's for the same PR
        if (this.state.pr !== pr) {
          console.warn(`State file is for different PR (${this.state.pr}), creating new state`);
          this.state = createInitialState(pr, branch);
        }
      } catch (error) {
        console.warn('Failed to load state file, creating new state:', error);
        this.state = createInitialState(pr, branch);
      }
    } else {
      this.state = createInitialState(pr, branch);
    }

    return this.state;
  }

  async save(): Promise<void> {
    if (!this.state) {
      throw new Error('No state to save. Call load() first.');
    }

    this.state.lastUpdated = new Date().toISOString();

    // Ensure directory exists
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getState(): ResolverState {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    return this.state;
  }

  isCommentVerifiedFixed(commentId: string): boolean {
    if (!this.state) return false;
    return this.state.verifiedFixed.includes(commentId);
  }

  markCommentVerifiedFixed(commentId: string): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    if (!this.state.verifiedFixed.includes(commentId)) {
      this.state.verifiedFixed.push(commentId);
    }
  }

  addLesson(lesson: string): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    if (!this.state.lessonsLearned.includes(lesson)) {
      this.state.lessonsLearned.push(lesson);
    }
  }

  getLessons(): string[] {
    return this.state?.lessonsLearned || [];
  }

  startIteration(): Iteration {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }

    const iteration: Iteration = {
      timestamp: new Date().toISOString(),
      commentsAddressed: [],
      changesMade: [],
      verificationResults: {},
    };

    this.state.iterations.push(iteration);
    return iteration;
  }

  getCurrentIteration(): Iteration | null {
    if (!this.state || this.state.iterations.length === 0) {
      return null;
    }
    return this.state.iterations[this.state.iterations.length - 1];
  }

  addCommentToIteration(commentId: string): void {
    const iteration = this.getCurrentIteration();
    if (iteration && !iteration.commentsAddressed.includes(commentId)) {
      iteration.commentsAddressed.push(commentId);
    }
  }

  addChangeToIteration(file: string, description: string): void {
    const iteration = this.getCurrentIteration();
    if (iteration) {
      iteration.changesMade.push({ file, description });
    }
  }

  addVerificationResult(commentId: string, result: VerificationResult): void {
    const iteration = this.getCurrentIteration();
    if (iteration) {
      iteration.verificationResults[commentId] = result;
    }
  }
}
