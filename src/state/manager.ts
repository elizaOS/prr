import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ResolverState, Iteration, VerificationResult, TokenUsageRecord } from './types.js';
import { createInitialState } from './types.js';
import { loadOverallTimings, getOverallTimings, loadOverallTokenUsage, getOverallTokenUsage } from '../logger.js';

const STATE_FILENAME = '.pr-resolver-state.json';

export class StateManager {
  private statePath: string;
  private state: ResolverState | null = null;
  private currentPhase: string = 'init';

  constructor(workdir: string) {
    this.statePath = join(workdir, STATE_FILENAME);
  }

  async load(pr: string, branch: string, headSha: string): Promise<ResolverState> {
    if (existsSync(this.statePath)) {
      try {
        const content = await readFile(this.statePath, 'utf-8');
        this.state = JSON.parse(content) as ResolverState;
        
        // Verify it's for the same PR
        if (this.state.pr !== pr) {
          console.warn(`State file is for different PR (${this.state.pr}), creating new state`);
          this.state = createInitialState(pr, branch, headSha);
        } else {
          // Update headSha if PR has changed
          if (this.state.headSha !== headSha) {
            console.warn(`PR head has changed (${this.state.headSha?.slice(0, 7)} → ${headSha.slice(0, 7)}), some cached state may be stale`);
            this.state.headSha = headSha;
          }
          
          // Log if resuming from interrupted run, but DON'T clear the flags here
          // Callers should check wasInterrupted() and clear explicitly after handling
          if (this.state.interrupted) {
            console.log(`Resuming from interrupted run (phase: ${this.state.interruptPhase || 'unknown'})`);
            // Note: interrupted flag is NOT cleared here - caller must handle via clearInterrupted()
          }
          
          // Compact duplicate lessons from previous runs
          const removed = this.compactLessons();
          if (removed > 0) {
            console.log(`Compacted ${removed} duplicate lessons (${this.state.lessonsLearned.length} unique remaining)`);
          }
          
          // Load cumulative stats from previous sessions
          if (this.state.totalTimings) {
            loadOverallTimings(this.state.totalTimings);
          }
          if (this.state.totalTokenUsage) {
            loadOverallTokenUsage(this.state.totalTokenUsage);
          }
        }
      } catch (error) {
        console.warn('Failed to load state file, creating new state:', error);
        this.state = createInitialState(pr, branch, headSha);
      }
    } else {
      this.state = createInitialState(pr, branch, headSha);
    }

    return this.state;
  }

  setPhase(phase: string): void {
    this.currentPhase = phase;
  }

  async markInterrupted(): Promise<void> {
    if (!this.state) return;
    
    this.state.interrupted = true;
    this.state.interruptPhase = this.currentPhase;
    this.state.lastUpdated = new Date().toISOString();
    
    // Save immediately
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  wasInterrupted(): boolean {
    return this.state?.interrupted ?? false;
  }

  getInterruptPhase(): string | undefined {
    return this.state?.interruptPhase;
  }

  clearInterrupted(): void {
    if (this.state) {
      this.state.interrupted = false;
      this.state.interruptPhase = undefined;
    }
  }

  async save(): Promise<void> {
    if (!this.state) {
      throw new Error('No state to save. Call load() first.');
    }

    this.state.lastUpdated = new Date().toISOString();
    
    // Save cumulative stats
    this.state.totalTimings = getOverallTimings();
    this.state.totalTokenUsage = getOverallTokenUsage();

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

  /**
   * Check if a comment is verified as fixed.
   * @param commentId The comment ID to check
   * @param maxIterationsAgo Optional: If set, only return true if verified within this many iterations
   */
  isCommentVerifiedFixed(commentId: string, maxIterationsAgo?: number): boolean {
    if (!this.state) return false;
    
    // Check new detailed records first
    if (this.state.verifiedComments) {
      const record = this.state.verifiedComments.find(v => v.commentId === commentId);
      if (record) {
        if (maxIterationsAgo !== undefined) {
          const currentIteration = this.state.iterations.length;
          const iterationsSince = currentIteration - record.verifiedAtIteration;
          return iterationsSince <= maxIterationsAgo;
        }
        return true;
      }
    }
    
    // Fall back to legacy array (for backwards compatibility)
    return this.state.verifiedFixed.includes(commentId);
  }

  markCommentVerifiedFixed(commentId: string): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    
    // Update legacy array for backwards compatibility
    if (!this.state.verifiedFixed.includes(commentId)) {
      this.state.verifiedFixed.push(commentId);
    }
    
    // Update new detailed records
    if (!this.state.verifiedComments) {
      this.state.verifiedComments = [];
    }
    
    // Remove existing record if any (we'll add a fresh one)
    this.state.verifiedComments = this.state.verifiedComments.filter(v => v.commentId !== commentId);
    
    this.state.verifiedComments.push({
      commentId,
      verifiedAt: new Date().toISOString(),
      verifiedAtIteration: this.state.iterations.length,
    });
  }

  unmarkCommentVerifiedFixed(commentId: string): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    
    // Remove from legacy array
    const index = this.state.verifiedFixed.indexOf(commentId);
    if (index !== -1) {
      this.state.verifiedFixed.splice(index, 1);
    }
    
    // Remove from new detailed records
    if (this.state.verifiedComments) {
      this.state.verifiedComments = this.state.verifiedComments.filter(v => v.commentId !== commentId);
    }
  }

  /**
   * Clear all verification cache entries.
   * Called before final audit to ensure audit results are authoritative.
   */
  clearVerificationCache(): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    
    this.state.verifiedFixed = [];
    this.state.verifiedComments = [];
  }
  
  /**
   * Get comment IDs that were verified more than N iterations ago (stale verifications)
   */
  getStaleVerifications(maxIterationsAgo: number): string[] {
    if (!this.state || !this.state.verifiedComments) return [];
    
    const currentIteration = this.state.iterations.length;
    return this.state.verifiedComments
      .filter(v => (currentIteration - v.verifiedAtIteration) > maxIterationsAgo)
      .map(v => v.commentId);
  }

  addLesson(lesson: string): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    
    // Extract file:line key from lesson (format: "Fix for path/file.ext:line rejected: ...")
    const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
    const key = keyMatch ? keyMatch[1] : null;
    
    if (key) {
      // Remove existing lessons for the same file:line (keep only latest)
      const existingIndex = this.state.lessonsLearned.findIndex(l => l.startsWith(`Fix for ${key}`));
      if (existingIndex !== -1) {
        // Replace with newer lesson (better explanation usually)
        this.state.lessonsLearned[existingIndex] = lesson;
        return;
      }
    }
    
    // No duplicate found, add new lesson
    if (!this.state.lessonsLearned.includes(lesson)) {
      this.state.lessonsLearned.push(lesson);
    }
  }

  getLessons(): string[] {
    return this.state?.lessonsLearned || [];
  }
  
  getLessonCount(): number {
    return this.state?.lessonsLearned.length || 0;
  }
  
  // Deduplicate and compact existing lessons (one per file:line)
  compactLessons(): number {
    if (!this.state) return 0;
    
    const lessonsByKey = new Map<string, string>();
    let uniqueCounter = 0;  // Separate counter for generating unique keys
    
    for (const lesson of this.state.lessonsLearned) {
      const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
      const key = keyMatch ? keyMatch[1] : `unique_${uniqueCounter++}`;
      
      // Keep the latest (last seen) lesson for each key
      lessonsByKey.set(key, lesson);
    }
    
    const before = this.state.lessonsLearned.length;
    this.state.lessonsLearned = Array.from(lessonsByKey.values());
    return before - this.state.lessonsLearned.length;
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
