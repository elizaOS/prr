   1 | /**
   2 |  * Push iteration loop
   3 |  * 
   4 |  * Execute single push iteration:
   5 |  * 1. Process comments and prepare fix loop
   6 |  * 2. Run fix iterations until all fixed or max iterations
   7 |  * 3. Commit and push if changes
   8 |  */
   9 | 
  10 | import chalk from 'chalk';
  11 | import type { Ora } from 'ora';
  12 | import type { SimpleGit } from 'simple-git';
  13 | import type { Config } from '../config.js';
  14 | import type { CLIOptions } from '../cli.js';
  15 | import type { ReviewComment, PRInfo } from '../github/types.js';
  16 | import type { UnresolvedIssue } from '../analyzer/types.js';
  17 | import type { Runner } from '../runners/types.js';
  18 | import type { GitHubAPI } from '../github/api.js';
  19 | import type { StateContext } from '../state/state-context.js';
  20 | import { setPhase } from '../state/state-context.js';
  21 | import * as State from '../state/state-core.js';
  22 | import * as Verification from '../state/state-verification.js';
  23 | import * as Dismissed from '../state/state-dismissed.js';
  24 | import * as CommentStatusAPI from '../state/state-comment-status.js';
  25 | import * as Iterations from '../state/state-iterations.js';
  26 | import * as Lessons from '../state/state-lessons.js';
  27 | import * as Performance from '../state/state-performance.js';
  28 | import type { LessonsContext } from '../state/lessons-context.js';
  29 | import type { LLMClient } from '../llm/client.js';
  30 | import { hasChanges } from '../git/git-clone-index.js';
  31 | import { formatNumber, debugStep, startTimer, debug } from '../logger.ts';
  32 | import * as ResolverProc from '../resolver-proc.js';
  33 | import * as Bailout from '../state/state-bailout.js';
  34 | import * as LessonsAPI from '../state/lessons-index.js';
  35 | import { recheckSolvability } from './helpers/solvability.js';
  36 | 
  37 | /** Git and GitHub context for a push iteration */
  38 | export interface PushIterationGitContext {
  39 |   git: SimpleGit;
  40 |   github: GitHubAPI;
  41 |   owner: string;
  42 |   repo: string;
  43 |   number: number;
  44 |   workdir: string;
  45 | }
  46 | 
  47 | /** Mutable iteration state tracked across push iterations */
  48 | export interface PushIterationState {
  49 |   pushIteration: number;
  50 |   maxPushIterations: number;
  51 |   rapidFailureCount: number;
  52 |   lastFailureTime: number;
  53 |   consecutiveFailures: number;
  54 |   modelFailuresInCycle: number;
  55 |   progressThisCycle: number;
  56 |   expectedBotResponseTime: Date | null;
  57 | }
  58 | 
  59 | /** Contextual objects passed through the push iteration */
  60 | export interface PushIterationContexts {
  61 |   prInfo: PRInfo;
  62 |   stateContext: StateContext;
  63 |   lessonsContext: LessonsContext;
  64 |   finalUnresolvedIssues: UnresolvedIssue[];
  65 |   finalComments: ReviewComment[];
  66 |   /** Mutation refs for cross-iteration state */
  67 |   prInfoRef: { current: PRInfo };
  68 |   finalUnresolvedIssuesRef: { current: UnresolvedIssue[] };
  69 |   finalCommentsRef: { current: ReviewComment[] };
  70 |   expectedBotResponseTimeRef: { current: Date | null };
  71 |   /**
  72 |    * Comments already fetched during setup phase (e.g., CodeRabbit polling).
  73 |    * WHY: Avoids redundant GitHub API fetch (~3s, 3 pages) when the same data
  74 |    * was already retrieved. Consumed once on first push iteration, then cleared.
  75 |    */
  76 |   prefetchedComments?: ReviewComment[];
  77 |   /**
  78 |    * Cache of last analysis result (comment count + headSha → unresolved, duplicateMap).
  79 |    * When comment count and head SHA unchanged, reuse to skip expensive findUnresolvedIssues.
  80 |    */
  81 |   lastAnalysisCacheRef?: { current: { commentCount: number; headSha: string; unresolvedIssues: UnresolvedIssue[]; comments: ReviewComment[]; duplicateMap: Map<string, string[]> } | null };
  82 | }
  83 | 
  84 | /** Callback functions used during push iteration */
  85 | export interface PushIterationCallbacks {
  86 |   findUnresolvedIssues: (comments: ReviewComment[], totalCount: number) => Promise<{
  87 |     unresolved: UnresolvedIssue[];
  88 |     recommendedModels?: string[];
  89 |     recommendedModelIndex: number;
  90 |     modelRecommendationReasoning?: string;
  91 |     duplicateMap: Map<string, string[]>;
  92 |   }>;
  93 |   resolveConflictsWithLLM: (git: SimpleGit, files: string[], source: string) => Promise<{ success: boolean; remainingConflicts: string[] }>;
  94 |   getCodeSnippet: (path: string, line: number | null, commentBody?: string) => Promise<string>;
  95 |   printUnresolvedIssues: (issues: UnresolvedIssue[]) => void;
  96 |   getCurrentModel: () => string | undefined;
  97 |   getRunner: () => Runner;
  98 |   parseNoChangesExplanation: (output: string) => string | null;
  99 |   trySingleIssueFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
 100 |   tryRotation: (failureErrorType?: string) => boolean;
 101 |   tryDirectLLMFix: (issues: UnresolvedIssue[], git: SimpleGit, verifiedThisSession?: Set<string>) => Promise<boolean>;
 102 |   executeBailOut: (issues: UnresolvedIssue[], comments: ReviewComment[]) => Promise<void>;
 103 |   /** Called when a runner fails with tool_config (e.g. unknown option) so it's skipped for rest of run */
 104 |   onDisableRunner?: (runnerName: string) => void;
 105 |   checkForNewBotReviews: (owner: string, repo: string, number: number, existingIds: Set<string>) => Promise<{ newComments: ReviewComment[]; message: string } | null>;
 106 |   calculateExpectedBotResponseTime: (lastCommitTime: Date) => Date | null;
 107 |   waitForBotReviews: (owner: string, repo: string, number: number, sha: string) => Promise<void>;
 108 | }
 109 | 
 110 | /** Service dependencies for push iteration */
 111 | export interface PushIterationServices {
 112 |   llm: LLMClient;
 113 |   options: CLIOptions;
 114 |   config: Config;
 115 |   spinner: Ora;
 116 |   runner: Runner;
 117 | }
 118 | 
 119 | /**
 120 |  * Execute single push iteration
 121 |  * 
 122 |  * WORKFLOW:
 123 |  * 1. Process comments and prepare fix loop
 124 |  * 2. Initialize fix loop state
 125 |  * 3. While not all fixed and under max iterations:
 126 |  *    - Run pre-iteration checks
 127 |  *    - Execute fix iteration
 128 |  *    - Verify fixes
 129 |  *    - Handle iteration cleanup
 130 |  *    - Post-verification handling (rotation if needed)
 131 |  * 4. Commit and push if changes exist
 132 |  * 
 133 |  * @returns Exit control flow
 134 |  */
 135 | export async function executePushIteration(
 136 |   gitCtx: PushIterationGitContext,
 137 |   iterState: PushIterationState,
 138 |   contexts: PushIterationContexts,
 139 |   callbacks: PushIterationCallbacks,
 140 |   services: PushIterationServices
 141 | ): Promise<{
 142 |   shouldBreak: boolean;
 143 |   exitReason?: string;
 144 |   exitDetails?: string;
 145 |   updatedRapidFailureCount: number;
 146 |   updatedLastFailureTime: number;
 147 |   updatedConsecutiveFailures: number;
 148 |   updatedModelFailuresInCycle: number;
 149 |   updatedProgressThisCycle: number;
 150 |   updatedHeadSha?: string;
 151 |   /** True when this iteration created a commit (with ≥1 file).
 152 |    * WHY: Orchestrator counts consecutive iterations with no commit and exits after 3 to avoid infinite loop when fixer produces no real changes. */
 153 |   committedThisIteration?: boolean;
 154 | }> {
 155 |   // Destructure parameter objects for local use
 156 |   const { git, github, owner, repo, number, workdir } = gitCtx;
 157 |   let { rapidFailureCount, lastFailureTime, consecutiveFailures, modelFailuresInCycle, progressThisCycle } = iterState;
 158 |   const { pushIteration, maxPushIterations } = iterState;
 159 |   const { prInfo, stateContext, lessonsContext } = contexts;
 160 |   const { prInfoRef, finalUnresolvedIssuesRef, finalCommentsRef, expectedBotResponseTimeRef } = contexts;
 161 |   const {
 162 |     findUnresolvedIssues, resolveConflictsWithLLM, getCodeSnippet, printUnresolvedIssues,
 163 |     getCurrentModel, getRunner, parseNoChangesExplanation, trySingleIssueFix, tryRotation,
 164 |     tryDirectLLMFix, executeBailOut, checkForNewBotReviews, calculateExpectedBotResponseTime, waitForBotReviews,
 165 |   } = callbacks;
 166 |   const { llm, options, config, spinner } = services;
 167 | 
 168 |   if (options.autoPush && pushIteration > 1) {
 169 |     const iterLabel = maxPushIterations === Infinity ? `${pushIteration}` : `${pushIteration}/${maxPushIterations}`;
 170 |     console.log(chalk.blue(`\n--- Push iteration ${iterLabel} ---\n`));
 171 |   }
 172 | 
 173 |   // Process comments and prepare fix loop.
 174 |   // Pass prefetched comments from setup phase to avoid redundant API call on first iteration.
 175 |   const prefetched = contexts.prefetchedComments;
 176 |   // Clear after first use — subsequent push iterations must fetch fresh data
 177 |   contexts.prefetchedComments = undefined;
 178 |   
 179 |   const loopResult = await ResolverProc.processCommentsAndPrepareFixLoop(
 180 |     git, github, owner, repo, number, prInfo, stateContext, lessonsContext, llm, options, config, workdir, spinner,
 181 |     findUnresolvedIssues, resolveConflictsWithLLM, getCodeSnippet, printUnresolvedIssues, prefetched
 182 |   );
 183 |   
 184 |   const { comments, unresolvedIssues, duplicateMap } = loopResult;
 185 |   debug('Push iteration: comments processed', {
 186 |     pushIteration,
 187 |     commentCount: comments.length,
 188 |     unresolvedCount: unresolvedIssues.length,
 189 |     shouldBreak: loopResult.shouldBreak,
 190 |     exitReason: loopResult.exitReason,
 191 |     usedPrefetched: !!prefetched?.length,
 192 |   });
 193 | 
 194 |   if (loopResult.shouldBreak) {
 195 |     // Store final state for after action report (for dry-run); issue refs preserved for AAR
 196 |     if (options.dryRun) {
 197 |       finalUnresolvedIssuesRef.current = [...unresolvedIssues];
 198 |       finalCommentsRef.current = [...comments];
 199 |     }
 200 |     return {
 201 |       shouldBreak: true,
 202 |       exitReason: loopResult.exitReason,
 203 |       exitDetails: loopResult.exitDetails,
 204 |       updatedRapidFailureCount: rapidFailureCount,
 205 |       updatedLastFailureTime: lastFailureTime,
 206 |       updatedConsecutiveFailures: consecutiveFailures,
 207 |       updatedModelFailuresInCycle: modelFailuresInCycle,
 208 |       updatedProgressThisCycle: progressThisCycle,
 209 |       committedThisIteration: false,
 210 |     };
 211 |   }
 212 | 
 213 |   // Initialize fix loop
 214 |   // CLI convention: 0 = unlimited, undefined = use Infinity default
 215 |   // CLI convention: 0 = unlimited. Use || (not ??) since 0 should map to Infinity.
 216 |   // CRITICAL: ?? only triggers on null/undefined, NOT 0. Default is 0 = unlimited.
 217 |   const maxFixIterations = options.maxFixIterations != null ? options.maxFixIterations : Infinity;
 218 |   debug('Fix loop config', { pushIteration, maxFixIterations, unresolvedCount: unresolvedIssues.length });
 219 |   // Start verification timer here to keep paired with endTimer
 220 |   Timer.startTimer('Verify fixes');
 221 |   const loopState = ResolverProc.initializeFixLoop(comments.map(c => c.id));
 222 |   let { fixIteration, allFixed, verifiedThisSession, alreadyCommitted, existingCommentIds } = loopState;
 223 | 
 224 |   // Reset stalemate counter at the start of each push iteration's fix loop.
 225 |   // WHY: noProgressCycles persists in state across push iterations. Without this,
 226 |   // a bail-out in push iteration N leaves the counter at threshold, so push
 227 |   // iteration N+1 bails immediately on its first cycle (even if that cycle was
 228 |   // timeout-only and should not count as stalemate).
 229 |   Bailout.resetNoProgressCycles(stateContext);
 230 |   
 231 |   // Expose verifiedThisSession on stateContext so reporters can use the actual
 232 |   // session verification count instead of unreliable delta counting.
 233 |   stateContext.verifiedThisSession = verifiedThisSession;
 234 | 
 235 |   let exitReason = '';
 236 |   let exitDetails = '';
 237 |   let committedThisIteration = false;
 238 | 
 239 |   while (fixIteration < maxFixIterations && !allFixed) {
 240 |     fixIteration++;
 241 |     
 242 |     // Pre-iteration checks
 243 |     const preChecks = await ResolverProc.executePreIterationChecks(
 244 |       fixIteration, git, github, owner, repo, number, prInfo, comments, unresolvedIssues, existingCommentIds, verifiedThisSession, stateContext, getRunner(), options,
 245 |       checkForNewBotReviews, getCodeSnippet, getCurrentModel
 246 |     );
 247 |     
 248 |     if (preChecks.shouldBreak) {
 249 |       exitReason = preChecks.exitReason || '';
 250 |       exitDetails = preChecks.exitDetails || '';
 251 |       break;
 252 |     }
 253 |     if (preChecks.updatedHeadSha) {
 254 |       prInfoRef.current.headSha = preChecks.updatedHeadSha;
 255 |     }
 256 | 
 257 |     // 3.1(a): Re-fetch file content for issues where verifier said still exists
 258 |     const verifierRefreshCount = await ResolverProc.refreshSnippetsForVerifierContradiction(unresolvedIssues, getCodeSnippet);
 259 |     if (verifierRefreshCount > 0) {
 260 |       debug('Refreshed snippets for verifier-contradiction retry', { count: verifierRefreshCount });
 261 |     }
 262 | 
 263 |     // Execute fix iteration
 264 |     // WHY getRunner(): After tryRotation() updates this.runner via syncRotationContext,
 265 |     // a destructured `runner` variable would still hold the OLD runner reference.
 266 |     // getRunner() always returns the current runner from the PRResolver instance.
 267 |     const iterResult = await ResolverProc.executeFixIteration(
 268 |       unresolvedIssues, comments, git, workdir, getRunner(), stateContext, lessonsContext, llm, options, config.openaiApiKey, prInfo, verifiedThisSession,
 269 |       rapidFailureCount, lastFailureTime, consecutiveFailures, modelFailuresInCycle, progressThisCycle,
 270 |       getCurrentModel, parseNoChangesExplanation, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut,
 271 |       callbacks.onDisableRunner
 272 |     );
 273 |     
 274 |     // Update state
 275 |     rapidFailureCount = iterResult.updatedRapidFailureCount;
 276 |     lastFailureTime = iterResult.updatedLastFailureTime;
 277 |     consecutiveFailures = iterResult.updatedConsecutiveFailures;
 278 |     modelFailuresInCycle = iterResult.updatedModelFailuresInCycle;
 279 |     progressThisCycle = iterResult.updatedProgressThisCycle;
 280 |     unresolvedIssues.splice(0, unresolvedIssues.length, ...iterResult.updatedUnresolvedIssues);
 281 |     const lessonsBeforeFix = iterResult.lessonsBeforeFix;
 282 |     
 283 |     if (iterResult.shouldExit) return { shouldBreak: true, exitReason: iterResult.exitReason || 'bail_out', exitDetails: iterResult.exitDetails || 'Fix iteration requested early exit', updatedRapidFailureCount: rapidFailureCount, updatedLastFailureTime: lastFailureTime, updatedConsecutiveFailures: consecutiveFailures, updatedModelFailuresInCycle: modelFailuresInCycle, updatedProgressThisCycle: progressThisCycle, committedThisIteration: false };
 284 |     if (iterResult.shouldBreak) {
 285 |       exitReason = iterResult.exitReason || '';
 286 |       exitDetails = iterResult.exitDetails || '';
 287 |       break;
 288 |     }
 289 |     if (iterResult.allFixed) {
 290 |       allFixed = true;
 291 |       break;
 292 |     }
 293 |     if (iterResult.shouldContinue) {
 294 |       await State.saveState(stateContext);
 295 |       await LessonsAPI.Save.save(lessonsContext);
 296 |       continue;
 297 |     }
 298 | 
 299 |     // Verify fixes
 300 |     const { verifiedCount, failedCount, changedIssues, unchangedIssues, changedFiles } = await ResolverProc.verifyFixes(git, unresolvedIssues, stateContext, lessonsContext, llm, verifiedThisSession, options.noBatch, duplicateMap, workdir);
 301 |     const totalIssues = unresolvedIssues.length;
 302 |     const currentModel = getCurrentModel();
 303 | 
 304 |     // Invalidate "open" comment statuses for files that were modified by the fixer.
 305 |     // HISTORY: Comment statuses persist the LLM's "issue still exists" verdict
 306 |     // keyed by file content hash. After the fixer modifies a file, the hash is
 307 |     // stale — the issue may now be resolved. By invalidating here, the next
 308 |     // iteration's findUnresolvedIssues will re-analyze only these comments
 309 |     // instead of the entire set.
 310 |     if (changedFiles.length > 0) {
 311 |       const invalidated = CommentStatusAPI.invalidateForFiles(stateContext, changedFiles);
 312 |       if (invalidated > 0) {
 313 |         debug(`Invalidated ${invalidated} comment status(es) for ${changedFiles.length} changed file(s)`);
 314 |       }
 315 |       // Refresh in-memory code snippets for remaining issues in the modified files.
 316 |       // WHY: After the fixer edits a file, the cached snippet for other issues in
 317 |       // that file is stale — line numbers may have shifted and context changed.
 318 |       // The next fix iteration would send outdated code, causing duplicate patches
 319 |       // or wrong-location errors.
 320 |       const snippetRefreshCount = await ResolverProc.refreshSnippetsForChangedFiles(unresolvedIssues, changedFiles, getCodeSnippet);
 321 |       if (snippetRefreshCount > 0) {
 322 |         debug(`Refreshed ${snippetRefreshCount} snippet(s) for changed file(s)`, { changedFiles });
 323 |       }
 324 |     }
 325 | 
 326 |     // Report verification failures to runner for escalation tracking.
 327 |     // HISTORY: The runner only tracked search/replace matching failures.
 328 |     // Files with structural corruption got patched (S/R matched) but failed
 329 |     // verification, so they never escalated to full-file-rewrite. Now both
 330 |     // signal types count, so persistent failures trigger escalation.
 331 |     if (failedCount > 0 && changedIssues.length > 0) {
 332 |       const failedFiles = new Set<string>();
 333 |       for (const issue of changedIssues) {
 334 |         if (!Verification.isVerified(stateContext, issue.comment.id)) {
 335 |           failedFiles.add(issue.comment.path);
 336 |         }
 337 |       }
 338 |       if (failedFiles.size > 0) {
 339 |         const runner = getRunner();
 340 |         runner.reportVerificationFailures?.(Array.from(failedFiles));
 341 |       }
 342 |     }
 343 |     
 344 |     // Handle iteration cleanup
 345 |     const cleanupResult = await ResolverProc.handleIterationCleanup(verifiedCount, failedCount, totalIssues, changedIssues, unchangedIssues, getRunner(), currentModel,
 346 |       stateContext, lessonsContext, verifiedThisSession, alreadyCommitted, lessonsBeforeFix, fixIteration, git, prInfo.branch, config.githubToken, options, calculateExpectedBotResponseTime, progressThisCycle);
 347 |     
 348 |     progressThisCycle += cleanupResult.progressMade;
 349 |     if (cleanupResult.expectedBotResponseTime !== undefined) expectedBotResponseTimeRef.current = cleanupResult.expectedBotResponseTime;
 350 | 
 351 |     // Remove verified issues from the queue so "all fixed" and next iteration see the true remaining set.
 352 |     // WHY: allFixed was previously (failedCount === 0), which is true when no verification failures
 353 |     // occurred — so we broke out after fixing 2 of 17, thinking we were done. Now we only consider
 354 |     // the queue empty when there are no unresolved issues left.
 355 |     const stillUnresolved = unresolvedIssues.filter((i) => !Verification.isVerified(stateContext, i.comment.id));
 356 |     unresolvedIssues.splice(0, unresolvedIssues.length, ...stillUnresolved);
 357 | 
 358 |     // All fixed only when the queue is empty, not when this batch had no verification failures.
 359 |     allFixed = unresolvedIssues.length === 0;
 360 |     if (allFixed && !exitReason.startsWith('all')) {
 361 |       exitReason = 'all_fixed';
 362 |       exitDetails = 'All issues fixed and verified in fix loop';
 363 |       debug('Fix loop exit: all_fixed', { fixIteration });
 364 |     }
 365 | 
 366 |     if (!allFixed) {
 367 |       // Post-verification handling
 368 |       const postVerif = await ResolverProc.handlePostVerification(verifiedCount, allFixed, unresolvedIssues, comments, verifiedThisSession, git, consecutiveFailures, modelFailuresInCycle, progressThisCycle,
 369 |         stateContext, lessonsContext, options, getRunner().name, trySingleIssueFix, tryRotation, tryDirectLLMFix, executeBailOut);
 370 |       
 371 |       consecutiveFailures = postVerif.updatedConsecutiveFailures;
 372 |       modelFailuresInCycle = postVerif.updatedModelFailuresInCycle;
 373 |       progressThisCycle = postVerif.updatedProgressThisCycle;
 374 |       unresolvedIssues.splice(0, unresolvedIssues.length, ...postVerif.updatedUnresolvedIssues);
 375 |       
 376 |       // Phase 2: Refresh snippets for issues whose files were touched by fixer
 377 |       const getCodeSnippetFn = (path: string, line: number | null, body?: string) =>
 378 |         ResolverProc.getCodeSnippet(gitCtx.workdir, path, line, body);
 379 |       const refreshResult = await recheckSolvability(
 380 |         unresolvedIssues, 
 381 |         changedFiles, 
 382 |         gitCtx.workdir, 
 383 |         stateContext, 
 384 |         getCodeSnippetFn
 385 |       );
 386 |       if (refreshResult.dismissed > 0) {
 387 |         console.log(chalk.yellow(`  ${refreshResult.dismissed} issue(s) became stale (files deleted by fixer)`));
 388 |       }
 389 |       if (refreshResult.refreshed > 0) {
 390 |         console.log(chalk.gray(`  ${refreshResult.refreshed} issue(s) refreshed (snippets updated)`));
 391 |       }
 392 |       unresolvedIssues.splice(0, unresolvedIssues.length, ...refreshResult.updated);
 393 |       
 394 |       if (postVerif.shouldBreak) {
 395 |         exitReason = 'bail_out';
 396 |         exitDetails = `Stalemate detected: fix loop exhausted all strategies with ${formatNumber(unresolvedIssues.length)} issue(s) remaining`;
 397 |         debug('Fix loop exit: bail_out (stalemate)', { fixIteration, remaining: unresolvedIssues.length });
 398 |         break;
 399 |       }
 400 |     }
 401 |   }
 402 | 
 403 |   if (!allFixed && maxFixIterations !== Infinity) {
 404 |     debug('Fix loop exit: max_iterations', { fixIteration, maxFixIterations, remaining: unresolvedIssues.length });
 405 |     console.log(chalk.yellow(`\nMax fix iterations (${formatNumber(maxFixIterations)}) reached. ${formatNumber(unresolvedIssues.length)} issues remain.`));
 406 |     exitReason = 'max_iterations';
 407 |     exitDetails = `Hit max fix iterations (${formatNumber(maxFixIterations)}) with ${formatNumber(unresolvedIssues.length)} issue(s) remaining`;
 408 |     finalUnresolvedIssuesRef.current = [...unresolvedIssues]; // issue refs preserved for AAR (verifierContradiction etc.)
 409 |     finalCommentsRef.current = [...comments];
 410 |   }
 411 | 
 412 |   // Commit changes if we have any
 413 |   debugStep('COMMIT PHASE');
 414 |   if (await hasChanges(git)) {
 415 |     // After bail-out (or --no-wait-bot), skip the bot review wait so we continue
 416 |     // and pick up new bot comments when they land on the next run or iteration.
 417 |     const isBailOut = exitReason === 'bail_out';
 418 |     const skipBotWait = isBailOut || (options.noWaitBot ?? false);
 419 |     const commitResult = await ResolverProc.handleCommitAndPush(git, prInfo, owner, repo, number, comments, stateContext, lessonsContext, options, config.githubToken, github, workdir, spinner, services.llm, pushIteration, maxPushIterations,
 420 |       resolveConflictsWithLLM, waitForBotReviews, allFixed, skipBotWait);
 421 |     if (commitResult.shouldBreak) {
 422 |       // Ensure AAR has remaining issues when we exit (e.g. bail-out with no committable changes)
 423 |       if (unresolvedIssues.length > 0) {
 424 |         finalUnresolvedIssuesRef.current = [...unresolvedIssues];
 425 |         finalCommentsRef.current = [...comments];
 426 |       }
 427 |       return {
 428 |         shouldBreak: true,
 429 |         exitReason: commitResult.exitReason,
 430 |         exitDetails: commitResult.exitDetails,
 431 |         updatedRapidFailureCount: rapidFailureCount,
 432 |         updatedLastFailureTime: lastFailureTime,
 433 |         updatedConsecutiveFailures: consecutiveFailures,
 434 |         updatedModelFailuresInCycle: modelFailuresInCycle,
 435 |         updatedProgressThisCycle: progressThisCycle,
 436 |         committedThisIteration: false,
 437 |       };
 438 |     }
 439 |     // Committed and pushed this iteration
 440 |     committedThisIteration = true;
 441 |     // Invalidate analysis cache so next iteration re-analyzes with new head
 442 |     if (contexts.lastAnalysisCacheRef) contexts.lastAnalysisCacheRef.current = null;
 443 |   } else {
 444 |     console.log(chalk.yellow('\nNo changes to commit'));
 445 |     // Only treat as "still need attention" issues that are not yet verified.
 446 |     // WHY: After a push, the next iteration may re-analyze before state is fully
 447 |     // synced or duplicate comment IDs can leave the queue with issues that were
 448 |     // already verified in the previous iteration — counting them would show a
 449 |     // misleading "X issues still need attention" when they were just fixed.
 450 |     const actuallyUnresolved = unresolvedIssues.filter(
 451 |       (issue) => !Verification.isVerified(stateContext, issue.comment.id)
 452 |     );
 453 |     finalUnresolvedIssuesRef.current = [...actuallyUnresolved];
 454 |     finalCommentsRef.current = [...comments];
 455 | 
 456 |     // If intermediate pushes happened during this iteration's fix loop, optionally
 457 |     // wait for bot reviews. With --no-wait-bot we skip the wait and continue;
 458 |     // new bot comments (e.g. CodeRabbit) are picked up when they land on next run.
 459 |     if (alreadyCommitted.size > 0 && options.autoPush && pushIteration < maxPushIterations && !(options.noWaitBot ?? false)) {
 460 |       const headSha = await git.revparse(['HEAD']);
 461 |       await waitForBotReviews(owner, repo, number, headSha);
 462 |       // Don't break — let the outer loop re-fetch comments and process any new
 463 |       // bot feedback. If no new issues, the next iteration exits immediately
 464 |       // (alreadyCommitted will be empty since no fixes were made).
 465 |       return {
 466 |         shouldBreak: false,
 467 |         exitReason: exitReason || 'no_changes',
 468 |         exitDetails: exitDetails || 'No new changes (waiting for bot review cycle)',
 469 |         updatedRapidFailureCount: rapidFailureCount,
 470 |         updatedLastFailureTime: lastFailureTime,
 471 |         updatedConsecutiveFailures: consecutiveFailures,
 472 |         updatedModelFailuresInCycle: modelFailuresInCycle,
 473 |         updatedProgressThisCycle: progressThisCycle,
 474 |         committedThisIteration: false,
 475 |       };
 476 |     }
 477 | 
 478 |     // No intermediate pushes (or not in auto-push mode) — truly done.
 479 |     const preserveExitReason = exitReason === 'bail_out';
 480 |     const stillNeedAttention = actuallyUnresolved.length;
 481 |     const noChangesDetails =
 482 |       stillNeedAttention > 0
 483 |         ? `No changes to commit (fixer made no modifications); ${formatNumber(stillNeedAttention)} issue${stillNeedAttention === 1 ? '' : 's'} still ${stillNeedAttention === 1 ? 'needs' : 'need'} attention`
 484 |         : 'No changes to commit (fixer made no modifications)';
 485 |     return {
 486 |       shouldBreak: true,
 487 |       exitReason: preserveExitReason ? exitReason : 'no_changes',
 488 |       exitDetails: preserveExitReason ? exitDetails : noChangesDetails,
 489 |       updatedRapidFailureCount: rapidFailureCount,
 490 |       updatedLastFailureTime: lastFailureTime,
 491 |       updatedConsecutiveFailures: consecutiveFailures,
 492 |       updatedModelFailuresInCycle: modelFailuresInCycle,
 493 |       updatedProgressThisCycle: progressThisCycle,
 494 |       committedThisIteration: false,
 495 |     };
 496 |   }
 497 | 
 498 |   // After commit+push, if we broke out due to bail-out, DON'T immediately exit.
 499 |   // The pushed fixes may trigger bot reviews with NEW issues worth processing.
 500 |   // The outer loop will re-enter, re-fetch comments, and process new bot feedback.
 501 |   // Convergence: if no new issues, the next iteration's fix loop exits immediately
 502 |   // → no changes → alreadyCommitted empty → shouldBreak: true.
 503 |   const bailedOut = exitReason === 'bail_out';
 504 |   if (bailedOut) {
 505 |     // Same issue refs (with verifierContradiction when set) for AAR and handoff
 506 |     finalUnresolvedIssuesRef.current = [...unresolvedIssues];
 507 |     finalCommentsRef.current = [...comments];
 508 |   }
 509 | 
 510 |   return {
 511 |     shouldBreak: false,
 512 |     exitReason,
 513 |     exitDetails,
 514 |     updatedRapidFailureCount: rapidFailureCount,
 515 |     updatedLastFailureTime: lastFailureTime,
 516 |     updatedConsecutiveFailures: consecutiveFailures,
 517 |     updatedModelFailuresInCycle: modelFailuresInCycle,
 518 |     updatedProgressThisCycle: progressThisCycle,
 519 |     committedThisIteration,
 520 |   };
 521 | }
 522 | 
