/**
 * State persistence for prr resolver.
 * 
 * WHY per-workdir state: Each PR gets its own workdir (hash-based). State is
 * specific to that PR's resolution process.
 * 
 * WHY persist tool/model indices: Without this, every restart begins rotation
 * from scratch. With persistence, we continue from where we left off - important
 * for long-running resolutions interrupted by Ctrl+C.
 * 
 * WHY verification timestamps: Enables "verification expiry" - re-check old
 * verifications that might be stale. A fix verified 10 iterations ago might
 * no longer be valid if surrounding code changed.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ResolverState, Iteration, VerificationResult, TokenUsageRecord, ModelStats, ModelPerformance, DismissedIssue } from './types.js';
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
          
          // Log if resuming from interrupted run; keep flags set for callers
          if (this.state.interrupted) {
            console.log(`Resuming from interrupted run (phase: ${this.state.interruptPhase || 'unknown'})`);
            // Keep flags set; clear explicitly after handling.
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

          // Initialize new fields for backward compatibility
          if (!this.state.dismissedIssues) {
            this.state.dismissedIssues = [];
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
   * 
   * WHY: Called before final audit to ensure audit results are authoritative.
   * Without this, stale "verified fixed" entries from previous runs survive
   * even if the audit would have caught them as false positives.
   * 
   * The flow is:
   * 1. Regular verification marks issues as "fixed" (may have false positives)
   * 2. When all appear resolved, we clear this cache
   * 3. Final audit re-checks everything with stricter criteria
   * 4. Only audit results populate the new cache
   */
  clearVerificationCache(): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }

    this.state.verifiedFixed = [];
    this.state.verifiedComments = [];
  }

  /**
   * Add a dismissed issue with reason.
   *
   * WHY: Document issues that don't need fixing so there can be a dialog
   * between generator and judge. This helps the generator learn to avoid
   * false positives.
   */
  addDismissedIssue(
    commentId: string,
    reason: string,
    category: 'already-fixed' | 'not-an-issue' | 'file-unchanged' | 'false-positive' | 'duplicate',
    filePath: string,
    line: number | null,
    commentBody: string
  ): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }

    if (!this.state.dismissedIssues) {
      this.state.dismissedIssues = [];
    }

    // Remove existing record if any (we'll add a fresh one)
    this.state.dismissedIssues = this.state.dismissedIssues.filter(d => d.commentId !== commentId);

    this.state.dismissedIssues.push({
      commentId,
      reason,
      dismissedAt: new Date().toISOString(),
      dismissedAtIteration: this.state.iterations.length,
      category,
      filePath,
      line,
      commentBody,
    });
  }

  /**
   * Get dismissed issues, optionally filtered by category.
   */
  getDismissedIssues(category?: string): Array<{
    commentId: string;
    reason: string;
    dismissedAt: string;
    dismissedAtIteration: number;
    category: string;
    filePath: string;
    line: number | null;
    commentBody: string;
  }> {
    if (!this.state?.dismissedIssues) {
      return [];
    }

    if (!category) {
      return [...this.state.dismissedIssues];
    }

    return this.state.dismissedIssues.filter(d => d.category === category);
  }

  /**
   * Check if a comment was dismissed.
   */
  isCommentDismissed(commentId: string): boolean {
    if (!this.state?.dismissedIssues) {
      return false;
    }

    return this.state.dismissedIssues.some(d => d.commentId === commentId);
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
  
  /**
   * Deduplicate lessons - keep one per file:line.
   * 
   * WHY deduplicate: If we learn something new about line 45, we should
   * replace the old lesson, not accumulate them. Multiple lessons for the
   * same location bloat the prompt and confuse the LLM.
   * 
   * WHY separate uniqueCounter: Early bug used `removed` counter for both
   * generating unique keys AND calculating duplicates removed. Now we use
   * a separate counter to avoid miscounting.
   * 
   * @returns Number of duplicate lessons removed
   */
  compactLessons(): number {
    if (!this.state) return 0;
    
    const lessonsByKey = new Map<string, string>();
    const before = this.state.lessonsLearned.length;
    // WHY separate counter: Previously we used `removed` for both key generation
    // and return value calculation, causing incorrect counts
    let uniqueCounter = 0;
    
    for (const lesson of this.state.lessonsLearned) {
      const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
      const key = keyMatch ? keyMatch[1] : `unique_${uniqueCounter++}`;
      
      lessonsByKey.set(key, lesson);
    }

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

  // Tool/model rotation state persistence
  // WHY: Resume from where we left off if interrupted, don't restart from first model
  
  setCurrentRunnerIndex(index: number): void {
    if (!this.state) return;
    this.state.currentRunnerIndex = index;
  }
  
  getCurrentRunnerIndex(): number {
    return this.state?.currentRunnerIndex ?? 0;
  }
  
  setModelIndex(runnerName: string, index: number): void {
    if (!this.state) return;
    if (!this.state.modelIndices) {
      this.state.modelIndices = {};
    }
    this.state.modelIndices[runnerName] = index;
  }
  
  getModelIndex(runnerName: string): number {
    return this.state?.modelIndices?.[runnerName] ?? 0;
  }
  
  getModelIndices(): Record<string, number> {
    return this.state?.modelIndices ?? {};
  }
  
  setModelIndices(indices: Record<string, number>): void {
    if (!this.state) return;
    this.state.modelIndices = indices;
  }
  
  // Model performance tracking
  // WHY: Track which models work well for this project so we can prioritize them
  
  /**
   * Get the key for model performance tracking.
   * Format: "tool/model" e.g., "cursor/claude-4-sonnet-thinking"
   */
  private getModelKey(tool: string, model?: string): string {
    return model ? `${tool}/${model}` : tool;
  }
  
  /**
   * Ensure model stats exist for a given key.
   */
  private ensureModelStats(key: string): ModelStats {
    if (!this.state) throw new Error('State not loaded');
    if (!this.state.modelPerformance) {
      this.state.modelPerformance = {};
    }
    if (!this.state.modelPerformance[key]) {
      this.state.modelPerformance[key] = {
        fixes: 0,
        failures: 0,
        noChanges: 0,
        errors: 0,
        lastUsed: new Date().toISOString(),
      };
    }
    return this.state.modelPerformance[key];
  }
  
  /**
   * Record a successful fix by a model.
   * Called when verification passes for an issue.
   */
  recordModelFix(tool: string, model?: string, count: number = 1): void {
    const key = this.getModelKey(tool, model);
    const stats = this.ensureModelStats(key);
    stats.fixes += count;
    stats.lastUsed = new Date().toISOString();
  }
  
  /**
   * Record a failed fix attempt by a model.
   * Called when verification fails for an issue.
   */
  recordModelFailure(tool: string, model?: string, count: number = 1): void {
    const key = this.getModelKey(tool, model);
    const stats = this.ensureModelStats(key);
    stats.failures += count;
    stats.lastUsed = new Date().toISOString();
  }
  
  /**
   * Record when a model made no changes.
   */
  recordModelNoChanges(tool: string, model?: string): void {
    const key = this.getModelKey(tool, model);
    const stats = this.ensureModelStats(key);
    stats.noChanges += 1;
    stats.lastUsed = new Date().toISOString();
  }
  
  /**
   * Record a tool error (connection, timeout, etc.)
   */
  recordModelError(tool: string, model?: string): void {
    const key = this.getModelKey(tool, model);
    const stats = this.ensureModelStats(key);
    stats.errors += 1;
    stats.lastUsed = new Date().toISOString();
  }
  
  /**
   * Get performance stats for all models.
   */
  getModelPerformance(): ModelPerformance {
    return this.state?.modelPerformance ?? {};
  }
  
  /**
   * Get stats for a specific model.
   */
  getModelStats(tool: string, model?: string): ModelStats | undefined {
    const key = this.getModelKey(tool, model);
    return this.state?.modelPerformance?.[key];
  }
  
  /**
   * Get models sorted by success rate (best first).
   * 
   * WHY: Use this to prioritize models that work well for this project.
   */
  getModelsBySuccessRate(): Array<{ key: string; stats: ModelStats; successRate: number }> {
    const perf = this.state?.modelPerformance ?? {};
    return Object.entries(perf)
      .map(([key, stats]) => {
        const total = stats.fixes + stats.failures;
        const successRate = total > 0 ? stats.fixes / total : 0;
        return { key, stats, successRate };
      })
      .sort((a, b) => {
        // Sort by success rate descending, then by total attempts descending
        if (b.successRate !== a.successRate) {
          return b.successRate - a.successRate;
        }
        return (b.stats.fixes + b.stats.failures) - (a.stats.fixes + a.stats.failures);
      });
  }
}
