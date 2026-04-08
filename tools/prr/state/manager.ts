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
import type { ResolverState, Iteration, VerificationResult, TokenUsageRecord, ModelStats, ModelPerformance, DismissedIssue, BailOutRecord, IssueAttempt, IssueAttempts } from './types.js';
import { createInitialState } from './types.js';
import { loadOverallTimings, getOverallTimings, loadOverallTokenUsage, getOverallTokenUsage, formatNumber } from '../../../shared/logger.js';
import * as Normalize from './lessons-normalize.js';
import type { StateContext } from './state-context.js';
import { transitionIssue } from './state-transitions.js';

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
          // Update headSha if PR has changed. Clear verified state so we re-verify fixes.
          // WHY: If the branch was rebased, merged, or the fix was reverted, the workdir no longer
          // matches the state that was verified. We had a run where the log said "already verified"
          // and skipped the fixer, but the file still had the bug (output.log audit).
          if (this.state.headSha !== headSha) {
            const prevSha = this.state.headSha?.slice(0, 7);
            this.state.headSha = headSha;
            delete this.state.sessionSkippedModelKeys;
            delete this.state.sessionModelStats;
            delete this.state.sessionSkippedSinceFixIteration;
            const hadVerified = (this.state.verifiedFixed?.length ?? 0) + (this.state.verifiedComments?.length ?? 0) > 0;
            const hadPartial = Object.keys(this.state.partialConflictResolutions ?? {}).length > 0;
            // Pill #9: Also clear dismissed (especially already-fixed) on head change — stale dismissals can mask regressions
            const hadDismissed = (this.state.dismissedIssues?.length ?? 0) > 0;
            if (hadVerified) {
              const clearedVerifiedIds = [
                ...new Set([
                  ...(this.state.verifiedFixed ?? []),
                  ...(this.state.verifiedComments ?? []).map((v) => v.commentId),
                ]),
              ];
              const showN = 25;
              const idSample =
                clearedVerifiedIds.length === 0
                  ? ''
                  : ` — IDs (${formatNumber(clearedVerifiedIds.length)} total, showing up to ${formatNumber(showN)}): ${clearedVerifiedIds.slice(0, showN).join(', ')}${clearedVerifiedIds.length > showN ? ' …' : ''}`;
              this.state.verifiedFixed = [];
              this.state.verifiedComments = [];
              // Also clear verified/resolved entries in commentStatuses so callers don't see stale
              // 'resolved' or 'verified' statuses for comments that are no longer confirmed fixed.
              // WHY: Without this, commentStatuses retains 'status: resolved' for IDs that were just
              // cleared from verifiedFixed/verifiedComments, producing misleading state maps that show
              // a comment as resolved while the verified arrays say otherwise (Pattern H, 2026-04-05).
              if (this.state.commentStatuses) {
                let statusCleared = 0;
                for (const [id, st] of Object.entries(this.state.commentStatuses)) {
                  if ((st as { status?: string }).status === 'resolved' || (st as { status?: string }).status === 'verified') {
                    delete this.state.commentStatuses[id];
                    statusCleared++;
                  }
                }
                if (statusCleared > 0) {
                  console.warn(`PR head changed: also cleared ${formatNumber(statusCleared)} verified/resolved commentStatuses entries`);
                }
              }
              console.warn(
                `PR head changed (${prevSha} → ${headSha.slice(0, 7)}): cleared verified state so fixes are re-checked against current code${idSample}`,
              );
            }
            if (hadDismissed) {
              const clearAllRaw = process.env.PRR_CLEAR_ALL_DISMISSED_ON_HEAD?.trim().toLowerCase();
              const clearAll =
                clearAllRaw === '1' || clearAllRaw === 'true' || clearAllRaw === 'yes' || clearAllRaw === 'on';
              if (clearAll) {
                const priorDismissed = this.state.dismissedIssues ?? [];
                const n = priorDismissed.length;
                const showD = 25;
                const dismissedIdSample =
                  n === 0
                    ? ''
                    : ` — comment IDs (showing up to ${formatNumber(showD)}): ${priorDismissed
                        .slice(0, showD)
                        .map((d) => d.commentId)
                        .join(', ')}${n > showD ? ' …' : ''}`;
                this.state.dismissedIssues = [];
                console.warn(
                  `PR head changed (${prevSha} → ${headSha.slice(0, 7)}): cleared ${formatNumber(n)} dismissal(s) — PRR_CLEAR_ALL_DISMISSED_ON_HEAD${dismissedIdSample}`,
                );
              } else {
                // Clear code-/thread-dependent dismissals; keep e.g. not-an-issue, path-unresolved, false-positive.
                const prior = this.state.dismissedIssues ?? [];
                const before = prior.length;
                const dropCategories = new Set(['already-fixed', 'chronic-failure', 'stale']);
                const removedRows = prior.filter((d) => dropCategories.has(d.category));
                this.state.dismissedIssues = prior.filter((d) => !dropCategories.has(d.category));
                const cleared = before - (this.state.dismissedIssues?.length ?? 0);
                if (cleared > 0) {
                  const showD = 25;
                  const dismissedIdSample =
                    removedRows.length === 0
                      ? ''
                      : ` — removed comment IDs (showing up to ${formatNumber(showD)}): ${removedRows
                          .slice(0, showD)
                          .map((d) => d.commentId)
                          .join(', ')}${removedRows.length > showD ? ' …' : ''}`;
                  console.warn(
                    `PR head changed: cleared ${formatNumber(cleared)} already-fixed/chronic-failure/stale dismissal(s) so they are re-checked against current code${dismissedIdSample}`,
                  );
                }
              }
            }
            if (hadPartial) {
              this.state.partialConflictResolutions = {};
              this.state.partialConflictSavedOriginBaseSha = undefined;
              console.warn(`PR head changed: cleared partial conflict resolutions so they are re-applied against current merge`);
            }
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
          
          // Deduplicate verifiedFixed on load
          if (this.state.verifiedFixed && this.state.verifiedFixed.length > 0) {
            const before = this.state.verifiedFixed.length;
            this.state.verifiedFixed = [...new Set(this.state.verifiedFixed)];
            const dupsRemoved = before - this.state.verifiedFixed.length;
            if (dupsRemoved > 0) {
              console.log(`Deduplicated verifiedFixed: removed ${dupsRemoved} duplicate(s) (${this.state.verifiedFixed.length} unique)`);
            }
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

          // Keep verifiedFixed and dismissedIssues mutually exclusive (pill #3; output.log audit).
          const verifiedAll = new Set([
            ...(this.state.verifiedFixed ?? []),
            ...(this.state.verifiedComments?.map((v) => v.commentId) ?? []),
          ]);
          const dismissedIds = new Set((this.state.dismissedIssues ?? []).map((d) => d.commentId));
          if (verifiedAll.size > 0 && (this.state.dismissedIssues?.length ?? 0) > 0) {
            const overlapDismissed = this.state.dismissedIssues!.filter((d) => verifiedAll.has(d.commentId));
            const beforeD = this.state.dismissedIssues!.length;
            this.state.dismissedIssues = this.state.dismissedIssues!.filter((d) => !verifiedAll.has(d.commentId));
            const removedD = beforeD - this.state.dismissedIssues.length;
            if (removedD > 0) {
              const ids = overlapDismissed.map((d) => d.commentId);
              const show = ids.slice(0, 15).join(', ');
              const more = ids.length > 15 ? ` …(+${formatNumber(ids.length - 15)} more)` : '';
              console.log(
                `Cleaned ${formatNumber(removedD)} overlap (removed from dismissed; already in verified) — comment id(s): ${show}${more}`,
              );
            }
          }
          if (dismissedIds.size > 0 && this.state.verifiedFixed?.length) {
            const removedIds = this.state.verifiedFixed.filter((id) => dismissedIds.has(id));
            const before = this.state.verifiedFixed.length;
            this.state.verifiedFixed = this.state.verifiedFixed.filter((id) => !dismissedIds.has(id));
            const removed = before - this.state.verifiedFixed.length;
            if (removed > 0) {
              const show = removedIds.slice(0, 15).join(', ');
              const more = removedIds.length > 15 ? ` …(+${formatNumber(removedIds.length - 15)} more)` : '';
              console.warn(
                `State load: removed ${formatNumber(removed)} ID(s) from verifiedFixed (already in dismissed — overlap cleaned): ${show}${more}`,
              );
            }
          }
          if (dismissedIds.size > 0 && this.state.verifiedComments?.length) {
            const removedVcRows = this.state.verifiedComments.filter((v) => dismissedIds.has(v.commentId));
            const beforeVc = this.state.verifiedComments.length;
            this.state.verifiedComments = this.state.verifiedComments.filter((v) => !dismissedIds.has(v.commentId));
            const removedVc = beforeVc - this.state.verifiedComments.length;
            if (removedVc > 0) {
              const ids = removedVcRows.map((v) => v.commentId);
              const show = ids.slice(0, 15).join(', ');
              const more = ids.length > 15 ? ` …(+${formatNumber(ids.length - 15)} more)` : '';
              console.warn(
                `State load: removed ${formatNumber(removedVc)} verifiedComments record(s) (already in dismissed — overlap cleaned): ${show}${more}`,
              );
            }
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

  /** Minimal {@link StateContext} for shared transition helpers (no session Set). */
  private toStateContext(): StateContext {
    return {
      statePath: this.statePath,
      state: this.state,
      currentPhase: this.currentPhase,
    };
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
    transitionIssue(this.toStateContext(), commentId, {
      kind: 'verified',
      forceVerificationRefresh: true,
    });
  }

  unmarkCommentVerifiedFixed(commentId: string): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    transitionIssue(this.toStateContext(), commentId, { kind: 'unverified' });
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
    category: 'already-fixed' | 'not-an-issue' | 'file-unchanged' | 'false-positive' | 'duplicate' | 'stale' | 'exhausted' | 'remaining' | 'chronic-failure' | 'missing-file' | 'path-unresolved' | 'out-of-scope',
    filePath: string,
    line: number | null,
    commentBody: string
  ): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    transitionIssue(this.toStateContext(), commentId, {
      kind: 'dismissed',
      reason,
      category,
      filePath,
      line,
      commentBody,
      replaceExistingDismissal: true,
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

  /**
   * Get all verified comment IDs.
   */
  getVerifiedComments(): string[] {
    if (!this.state) return [];
    
    // Combine legacy and new records
    const fromLegacy = this.state.verifiedFixed || [];
    const fromNew = this.state.verifiedComments?.map(v => v.commentId) || [];
    
    // Return unique IDs
    return [...new Set([...fromLegacy, ...fromNew])];
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
   * Deduplicate lessons - keep one per normalized key.
   * 
   * WHY deduplicate: If we learn something new about line 45, we should
   * replace the old lesson, not accumulate them. Multiple lessons for the
   * same location bloat the prompt and confuse the LLM.
   * 
   * @returns Number of duplicate lessons removed
   */
  compactLessons(): number {
    if (!this.state) return 0;
    
    const seenKeys = new Set<string>();
    const seenNear = new Set<string>();
    const compacted: string[] = [];
    const before = this.state.lessonsLearned.length;
    for (const lesson of this.state.lessonsLearned) {
      const normalized = Normalize.normalizeLessonText(lesson);
      if (!normalized) continue;
      const key = Normalize.lessonKey(normalized);
      const nearKey = Normalize.lessonNearKey(normalized);
      if (seenKeys.has(key) || seenNear.has(nearKey)) continue;
      seenKeys.add(key);
      seenNear.add(nearKey);
      compacted.push(normalized);
    }

    this.state.lessonsLearned = compacted;
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
  
  /**
   * Get a formatted summary of model performance for LLM context.
   * Used for smart model selection - helps LLM recommend appropriate models.
   * 
   * WHY: LLM can make better model recommendations when it knows what's worked
   * on this codebase before.
   */
  getModelHistorySummary(): string | undefined {
    const models = this.getModelsBySuccessRate();
    if (models.length === 0) {
      return undefined;
    }
    
    const lines: string[] = [];
    for (const { key, stats, successRate } of models) {
      const total = stats.fixes + stats.failures;
      if (total === 0) continue;  // Skip models with no attempts
      
      const rate = (successRate * 100).toFixed(0);
      let line = `${key}: ${stats.fixes} fixes, ${stats.failures} failures (${rate}% success)`;
      
      // Add additional context if available
      if (stats.noChanges > 0) {
        line += `, ${stats.noChanges} no-changes`;
      }
      if (stats.errors > 0) {
        line += `, ${stats.errors} errors`;
      }
      
      lines.push(line);
    }
    
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  // ============================================================================
  // Per-issue attempt tracking
  // WHY: Tell the LLM what's already been tried on each issue so it can make
  // better model recommendations (e.g., skip models that already failed).
  // ============================================================================

  /**
   * Record a fix attempt on an issue.
   * Optional fileContentHash enables chronic-escalation to count only same-version attempts.
   */
  recordIssueAttempt(
    commentId: string,
    tool: string,
    model: string | undefined,
    result: 'fixed' | 'failed' | 'no-changes' | 'error',
    lessonLearned?: string,
    rejectionCount?: number,
    fileContentHash?: string
  ): void {
    if (!this.state) throw new Error('State not loaded');
    if (!this.state.issueAttempts) {
      this.state.issueAttempts = {};
    }
    if (!this.state.issueAttempts[commentId]) {
      this.state.issueAttempts[commentId] = [];
    }
    const attempt: IssueAttempt = {
      commentId,
      tool,
      model,
      timestamp: new Date().toISOString(),
      result,
      lessonLearned,
      rejectionCount,
    };
    if (fileContentHash !== undefined) attempt.fileContentHash = fileContentHash;
    this.state.issueAttempts[commentId].push(attempt);
  }

  /**
   * Get attempt history for a set of issues, formatted for LLM context.
   * 
   * WHY: The LLM needs to see what's been tried so it can recommend different models.
   * Format is human-readable for the prompt.
   */
  getAttemptHistoryForIssues(commentIds: string[]): string | undefined {
    if (!this.state?.issueAttempts) return undefined;
    
    const lines: string[] = [];
    
    for (const commentId of commentIds) {
      const attempts = this.state.issueAttempts[commentId];
      if (!attempts || attempts.length === 0) continue;
      
      // Summarize attempts for this issue
      const summaries = attempts.map(a => {
        const modelKey = a.model ? `${a.tool}/${a.model}` : a.tool;
        let summary = `${modelKey}: ${a.result}`;
        if (a.rejectionCount && a.rejectionCount > 0) {
          summary += ` (${a.rejectionCount} rejections)`;
        }
        if (a.lessonLearned) {
          summary += ` [lesson: ${a.lessonLearned.substring(0, 50)}...]`;
        }
        return summary;
      });
      
      lines.push(`Issue ${commentId}: ${summaries.join(', ')}`);
    }
    
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  /**
   * Get all attempts for a specific issue.
   */
  getIssueAttempts(commentId: string): IssueAttempt[] {
    return this.state?.issueAttempts?.[commentId] ?? [];
  }
  
  // No-progress cycle tracking for bail-out mechanism
  // WHY: Detect stalemates where all tools/models have been tried with zero progress
  
  /**
   * Get the current count of no-progress cycles.
   */
  getNoProgressCycles(): number {
    return this.state?.noProgressCycles ?? 0;
  }
  
  /**
   * Increment the no-progress cycle counter.
   * Called when a full rotation through all tools/models yields zero fixes.
   */
  incrementNoProgressCycles(): number {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    if (!this.state.noProgressCycles) {
      this.state.noProgressCycles = 0;
    }
    this.state.noProgressCycles++;
    return this.state.noProgressCycles;
  }
  
  /**
   * Reset the no-progress cycle counter.
   * Called when any progress is made (verified fixes > 0).
   */
  resetNoProgressCycles(): void {
    if (!this.state) return;
    this.state.noProgressCycles = 0;
  }
  
  /**
   * Record a bail-out event with details for human follow-up.
   * 
   * WHY: Document exactly what was tried and what remains so:
   * 1. Humans know where to pick up
   * 2. We can analyze patterns in bail-outs
   * 3. Future runs can learn from past failures
   */
  recordBailOut(
    reason: BailOutRecord['reason'],
    cyclesCompleted: number,
    remainingIssues: BailOutRecord['remainingIssues'],
    issuesFixed: number,
    toolsExhausted: string[]
  ): void {
    if (!this.state) {
      throw new Error('State not loaded. Call load() first.');
    }
    
    this.state.bailOutRecord = {
      timestamp: new Date().toISOString(),
      reason,
      cyclesCompleted,
      remainingIssues,
      partialProgress: {
        issuesFixed,
        issuesRemaining: remainingIssues.length,
        lessonsLearned: this.state.lessonsLearned.length,
      },
      toolsExhausted,
    };
  }
  
  /**
   * Get the last bail-out record if any.
   */
  getBailOutRecord(): BailOutRecord | undefined {
    return this.state?.bailOutRecord;
  }
  
  /**
   * Clear bail-out record (e.g., when resuming with different settings).
   */
  clearBailOutRecord(): void {
    if (this.state) {
      this.state.bailOutRecord = undefined;
    }
  }
}
