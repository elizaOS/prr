/**
 * Fix verification: after the fixer runs, confirm which issues were actually fixed.
 *
 * WHY verify at all: Fixers can claim "fixed" but miss the issue or change the
 * wrong thing. We send the fixer output and code snippet to the LLM and ask
 * "does this code now address the concern?" — only then do we mark verified.
 * WHY batch verify: One LLM call can check many issues at once (e.g. 50) with
 * a structured prompt; we fall back to spot-check then full batch to avoid
 * trusting a single "all fixed" claim without sampling.
 */

import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'fs/promises';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateContext } from '../state/state-context.js';
import { setPhase, getState } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import { isInfrastructureFailure } from './helpers/recovery.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, debugStep, startTimer, endTimer, setTokenPhase, formatDuration, formatNumber } from '../logger.js';
import { getChangedFiles, getDiffForFile, detectFileCorruption } from '../git/git-clone-index.js';
import { basename, dirname, extname, join } from 'path';
import { VERIFIER_ESCALATION_THRESHOLD } from '../constants.js';
import { isModelProviderCompatible } from '../models/rotation.js';
import type { Runner } from '../runners/types.js';

/**
 * Find changed files that relate to an issue's target path.
 *
 * Returns the target itself (if changed) PLUS any test/spec files that correspond
 * to it. This solves the long-standing problem where "add tests for route.ts"
 * creates `route.test.ts` but verification only checks if `route.ts` was modified.
 *
 * Test file patterns matched:
 *   foo/bar.ts  →  foo/bar.test.ts, foo/bar.spec.ts
 *   foo/bar.ts  →  foo/__tests__/bar.ts, foo/__tests__/bar.test.ts, foo/__tests__/bar.spec.ts
 *   foo/bar.ts  →  __tests__/foo/bar.ts, __tests__/.../bar.test.ts  (any __tests__ ancestor)
 */
function findRelatedChangedFiles(targetPath: string, changedFiles: string[]): string[] {
  const related: string[] = [];

  const dir = dirname(targetPath);                     // app/api/auth/siwe/verify
  const ext = extname(targetPath);                     // .ts
  const base = basename(targetPath, ext);              // route
  const baseLower = base.toLowerCase();

  // For Next.js route handlers (route.ts, page.tsx, layout.tsx, etc.), the
  // meaningful name is the DIRECTORY, not the file. Tests for
  // app/api/auth/siwe/verify/route.ts are typically named verify.test.ts,
  // not route.test.ts.
  //
  // HISTORY: Originally only matched on basename ("route"), which missed
  // test files named after the directory ("verify.test.ts"). This caused
  // iteration 4 to create verify.test.ts and nonce.test.ts but verification
  // saw 0 matches → "0 issues fixed". Now we also match on the parent
  // directory name for these conventional filenames.
  const NEXTJS_CONVENTIONAL_NAMES = new Set(['route', 'page', 'layout', 'loading', 'error', 'not-found', 'template', 'default', 'middleware', 'index']);
  const dirName = basename(dir);                       // verify
  const dirNameLower = dirName.toLowerCase();
  const useDirectoryName = NEXTJS_CONVENTIONAL_NAMES.has(baseLower);

  // Extensions that are plausible test files for the target
  const testExts = new Set([ext, '.ts', '.tsx', '.js', '.jsx'].map(e => e.toLowerCase()));

  /** Check if a test file basename matches our target (by file name or directory name) */
  const matchesTarget = (fBaseLower: string): boolean => {
    // Match on the actual file basename: route.test, route.spec
    if (fBaseLower === `${baseLower}.test` || fBaseLower === `${baseLower}.spec`) return true;
    if (fBaseLower === baseLower) return true;
    // For Next.js conventional names, also match on directory name: verify.test, verify.spec
    if (useDirectoryName) {
      if (fBaseLower === `${dirNameLower}.test` || fBaseLower === `${dirNameLower}.spec`) return true;
      if (fBaseLower === dirNameLower) return true;
    }
    return false;
  };

  for (const file of changedFiles) {
    // Direct match: the target file itself
    if (file === targetPath) {
      related.push(file);
      continue;
    }

    const fDir = dirname(file);
    const fExt = extname(file);
    const fBase = basename(file, fExt);
    const fBaseLower = fBase.toLowerCase();

    if (!testExts.has(fExt.toLowerCase())) continue;

    // Pattern 1: sibling test file — foo/bar.test.ts, foo/bar.spec.ts
    if (fDir === dir && matchesTarget(fBaseLower)) {
      related.push(file);
      continue;
    }

    // Pattern 2: __tests__ subdirectory — foo/__tests__/bar.ts, foo/__tests__/bar.test.ts
    if (fDir === `${dir}/__tests__` && matchesTarget(fBaseLower)) {
      related.push(file);
      continue;
    }

    // Pattern 3: parent's __tests__ — foo/__tests__/verify.test.ts for foo/verify/route.ts
    if (useDirectoryName) {
      const parentDir = dirname(dir);  // app/api/auth/siwe
      if (fDir === `${parentDir}/__tests__` && matchesTarget(fBaseLower)) {
        related.push(file);
        continue;
      }
    }

    // Pattern 4: root-relative __tests__ — __tests__/foo/bar.ts, __tests__/.../bar.test.ts
    // Match any file under a __tests__ directory whose base name matches
    if ((file.includes('__tests__/') || file.includes('__test__/')) && matchesTarget(fBaseLower)) {
      related.push(file);
      continue;
    }
  }

  return related;
}

/**
 * Read the current code around an issue's specific line(s) AFTER the fixer has run.
 *
 * WHY: The batch verifier receives the full file diff, but when multiple issues
 * target the same file, they all get the same diff. The verifier can't reliably
 * determine which diff hunks address which issue — especially in large diffs.
 * Including the current code at the issue's location lets the verifier check
 * whether the problematic pattern described in the review comment still exists.
 */
async function getCurrentCodeAtLine(
  workdir: string,
  filePath: string,
  line: number | null
): Promise<string> {
  try {
    const fullPath = join(workdir, filePath);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    if (line === null) {
      // No specific line — return first 40 lines as context
      return lines.slice(0, 40).map((l, i) => `${i + 1}: ${l}`).join('\n');
    }

    const contextBefore = 10;
    const contextAfter = 15;
    const start = Math.max(0, line - contextBefore - 1);
    const end = Math.min(lines.length, line + contextAfter);

    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '(file not found or unreadable)';
  }
}

/**
 * Verify fixes after fixer completes
 * Separates changed/unchanged files, verifies changed files, records results
 */
export async function verifyFixes(
  git: SimpleGit,
  unresolvedIssues: UnresolvedIssue[],
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  verifiedThisSession: Set<string>,
  noBatch: boolean,
  duplicateMap?: Map<string, string[]>,
  workdir?: string,
  getCurrentModel?: () => string | undefined,
  getRunner?: () => Runner
): Promise<{
  verifiedCount: number;
  failedCount: number;
  changedIssues: UnresolvedIssue[];
  unchangedIssues: UnresolvedIssue[];
  changedFiles: string[];
}> {
  const spinner = ora();
  let verifiedCount = 0;
  let failedCount = 0;
  let autoVerifiedCount = 0;
  const unchangedIssues: typeof unresolvedIssues = [];
  const changedIssues: typeof unresolvedIssues = [];
  let changedFiles: string[] = [];

  debugStep('VERIFYING FIXES');
  setPhase(stateContext, 'verifying');
  setTokenPhase('Verify fixes');
  startTimer('Verify fixes');

  // Map from issue target path → all related changed files (target + test files).
  // WHY: When a reviewer says "add tests for route.ts", the fixer creates route.test.ts.
  // Without this mapping, verification sees "route.ts not modified" and rejects the fix.
  // With it, we send the test file's diff to the verifier so it can judge the test content.
  const relatedFilesMap = new Map<string, string[]>();

  try {
    spinner.start('Verifying fixes...');
    changedFiles = await getChangedFiles(git);
    debug('Changed files', changedFiles);
  
    for (const issue of unresolvedIssues) {
      // WHY skip: Recovery phases (trySingleIssueFix, tryDirectLLMFix) verify
      // their own fixes inline — if successful, they call markVerified(). Without
      // this check, those same issues would be re-verified here: each a separate
      // verifyFix LLM call (or batch slot) confirming what we already know. Skipping
      // saves one verification call per issue resolved during recovery.
      // Audit: When the fixer modified this issue's file this iteration, re-verify
      // even if previously verified — cache may be stale and we must not commit without re-check.
      if (Verification.isVerified(stateContext, issue.comment.id) && !changedFiles.includes(issue.comment.path)) {
        debug('Skipping already-verified issue in verifyFixes', { id: issue.comment.id });
        continue;
      }

      const related = findRelatedChangedFiles(issue.comment.path, changedFiles);
      if (related.length > 0) {
        relatedFilesMap.set(issue.comment.id, related);
        changedIssues.push(issue);
      } else {
        unchangedIssues.push(issue);
      }
    }

    // Mark unchanged files as failed immediately and document as dismissed
    // NOTE: No validation needed here - we're providing an explicit, meaningful reason
    for (const issue of unchangedIssues) {
      Iterations.addVerificationResult(stateContext, issue.comment.id, {
        passed: false,
        reason: 'File was not modified',
      });
      Dismissed.dismissIssue(stateContext, 
        issue.comment.id,
        'File was not modified by the fixer tool, so issue could not have been addressed',
        'file-unchanged',
        issue.comment.path,
        issue.comment.line,
        issue.comment.body
      );
      failedCount++;
    }

    // Verify changed files
    if (changedIssues.length > 0) {
      // Cache diffs by file to avoid fetching same diff multiple times
      const diffCache = new Map<string, string>();
      
      const getDiff = async (path: string): Promise<string> => {
        const cached = diffCache.get(path);
        if (cached) {
          return cached;
        }
        const diff = await getDiffForFile(git, path) || '';
        diffCache.set(path, diff);
        return diff;
      };

      // Get combined diff for an issue — includes target file AND any related test files.
      const getIssueDiff = async (issue: UnresolvedIssue): Promise<string> => {
        const related = relatedFilesMap.get(issue.comment.id) || [issue.comment.path];
        const diffs: string[] = [];
        for (const file of related) {
          const d = await getDiff(file);
          if (d) diffs.push(d);
        }
        return diffs.join('\n');
      };

      if (noBatch) {
        // Sequential mode - one LLM call per fix
        spinner.text = `Verifying ${formatNumber(changedIssues.length)} fixes sequentially...`;
        
        for (let i = 0; i < changedIssues.length; i++) {
          const issue = changedIssues[i];
          spinner.text = `Verifying [${formatNumber(i + 1)}/${formatNumber(changedIssues.length)}] ${issue.comment.path}:${issue.comment.line || '?'}`;
          
          try {
              const diff = await getIssueDiff(issue);
              
              // Check if this issue needs a stronger model due to previous rejections
              const state = getState(stateContext);
              const needsStrongerModel = getCurrentModel && (state.verifierRejectionCount?.[issue.comment.id] ?? 0) >= VERIFIER_ESCALATION_THRESHOLD;
              
              let verification;
              if (needsStrongerModel) {
                const rawStrongerModel = getCurrentModel?.();
                const runner = getRunner?.();
                const strongerModel = rawStrongerModel && runner && isModelProviderCompatible(runner, rawStrongerModel) 
                  ? rawStrongerModel 
                  : undefined;
                
                if (strongerModel && isModelProviderCompatible(strongerModel, llm.provider)) {
                  debug('Using stronger model for sequential verification (previous rejections)', { model: strongerModel, issue: issue.comment.id });
                  verification = await llm.verifyFix(
                    issue.comment.body,
                    issue.comment.path,
                    diff,
                    { model: strongerModel }
                  );
                } else {
                  verification = await llm.verifyFix(
                    issue.comment.body,
                    issue.comment.path,
                    diff
                  );
                }
              } else {
                verification = await llm.verifyFix(
                  issue.comment.body,
                  issue.comment.path,
                  diff
                );
              }

              Iterations.addVerificationResult(stateContext, issue.comment.id, {
                passed: verification.fixed,
                reason: verification.explanation,
              });

              debug(`Verification for ${issue.comment.path}:${issue.comment.line}`, verification);
            
            if (verification.fixed) {
              verifiedCount++;
              Verification.markVerified(stateContext, issue.comment.id);
              Iterations.addCommentToIteration(stateContext, issue.comment.id);
              verifiedThisSession.add(issue.comment.id);  // Track for session filtering
              
              // Clean up fix-attempt lessons now that the issue is resolved.
              // Keeps architectural constraints, removes "Fix for X - the diff..." debris.
              const cleaned = LessonsAPI.Cleanup.cleanupLessonsForFixedIssue(
                lessonsContext, issue.comment.path, issue.comment.line
              );
              if (cleaned > 0) {
                debug(`Cleaned up ${cleaned} fix-attempt lesson(s) for ${issue.comment.path}:${issue.comment.line}`);
              }
              
              // Auto-verify duplicates of this canonical issue
              if (duplicateMap) {
                const duplicates = duplicateMap.get(issue.comment.id) || [];
                for (const dupId of duplicates) {
                  if (!Verification.isVerified(stateContext, dupId)) {
                    Verification.markVerified(stateContext, dupId, issue.comment.id);
                    verifiedThisSession.add(dupId);
                    autoVerifiedCount++;
                    debug(`Auto-verified duplicate comment ${dupId} (canonical ${issue.comment.id} was fixed)`);
                  }
                }
              }
            } else {
              failedCount++;
              // Feed verifier's explanation back so next fix prompt shows VERIFIER DISAGREES.
              if (!isInfrastructureFailure(verification.explanation)) {
                issue.verifierContradiction = verification.explanation;
              }
              // Track rejection count to enable escalation to stronger model
              const state = getState(stateContext);
              if (!state.verifierRejectionCount) state.verifierRejectionCount = {};
              state.verifierRejectionCount[issue.comment.id] = (state.verifierRejectionCount[issue.comment.id] ?? 0) + 1;
              // Skip failure analysis for infrastructure errors (quota, timeout) to save tokens
              if (isInfrastructureFailure(verification.explanation)) {
                const shortReason = verification.explanation.substring(0, 120);
                LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - infra failure: ${shortReason}`);
              } else {
                const lesson = await llm.analyzeFailedFix(
                  {
                    comment: issue.comment.body,
                    filePath: issue.comment.path,
                    line: issue.comment.line,
                  },
                  diff,
                  verification.explanation
                );
                LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - ${lesson}`);
              }
            }
          } catch (err) {
            failedCount++;
            const msg = err instanceof Error ? err.message : String(err);
            debug('Verification failed for issue', { path: issue.comment.path, line: issue.comment.line, error: msg });
            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: false,
              reason: `Verification threw: ${msg}`,
            });
          }
        }
      } else {
        // Batch mode - one LLM call for all fixes
        // Fetch diffs and current code for all issues concurrently.
        // WHY parallel: Each read is independent (different file or line). With 12+
        // issues this turns ~1-2s of sequential I/O into a single ~100ms burst.
        const fixesToVerify = await Promise.all(
          changedIssues.map(async (issue) => {
            const [diff, currentCode] = await Promise.all([
              getIssueDiff(issue),
              workdir
                ? getCurrentCodeAtLine(workdir, issue.comment.path, issue.comment.line)
                : Promise.resolve(undefined),
            ]);
            return {
              id: issue.comment.id,
              comment: issue.comment.body,
              filePath: issue.comment.path,
              line: issue.comment.line,
              diff,
              currentCode,
            };
          })
        );

        spinner.text = `Verifying ${formatNumber(fixesToVerify.length)} fixes in batch...`;
        const state = getState(stateContext);
        // Split by escalation need so we only use the stronger model for issues that had previous rejections.
        // Create an ID set for O(1) lookup instead of O(n²) nested loops
        const needStrongerIdSet = new Set(
          getCurrentModel
            ? changedIssues
                .filter((_, i) => (state.verifierRejectionCount?.[fixesToVerify[i].id] ?? 0) >= VERIFIER_ESCALATION_THRESHOLD)
                .map((i) => i.comment.id)
            : []
        );
        // Use single pass with set lookup - O(n) instead of O(n²)
        const fixesDefault: typeof fixesToVerify = [];
        const fixesStronger: typeof fixesToVerify = [];
        for (const fix of fixesToVerify) {
          if (needStrongerIdSet.has(fix.id)) {
            fixesStronger.push(fix);
          } else {
            fixesDefault.push(fix);
          }
        }
        const rawStrongerModel = needStrongerIdSet.size > 0 && getCurrentModel ? getCurrentModel() : undefined;
        const runner = getRunner?.();
        const strongerModel =
          rawStrongerModel && runner && isModelProviderCompatible(runner, rawStrongerModel)
            ? rawStrongerModel
            : undefined;

        const result = new Map<string, { fixed: boolean; explanation: string; lesson?: string }>();
        if (fixesDefault.length > 0) {
          const defaultResult = await llm.batchVerifyFixes(fixesDefault);
          for (const [id, value] of defaultResult) result.set(id, value);
        }
        if (fixesStronger.length > 0) {
          if (strongerModel && isModelProviderCompatible(strongerModel, llm.provider)) {
            debug('Using stronger model for verification (previous rejections)', { model: strongerModel, count: fixesStronger.length });
            const strongerResult = await llm.batchVerifyFixes(fixesStronger, { model: strongerModel });
            for (const [id, value] of strongerResult) result.set(id, value);
          } else {
            const fallback = await llm.batchVerifyFixes(fixesStronger);
            for (const [id, value] of fallback) result.set(id, value);
          }
        }

        for (const issue of changedIssues) {
          const verification = result.get(issue.comment.id);
          if (verification) {
            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: verification.fixed,
              reason: verification.explanation,
            });

            if (verification.fixed) {
              verifiedCount++;
              Verification.markVerified(stateContext, issue.comment.id);
              Iterations.addCommentToIteration(stateContext, issue.comment.id);
              verifiedThisSession.add(issue.comment.id);
              
              // Clean up fix-attempt lessons now that the issue is resolved
              const cleaned = LessonsAPI.Cleanup.cleanupLessonsForFixedIssue(
                lessonsContext, issue.comment.path, issue.comment.line
              );
              if (cleaned > 0) {
                debug(`Cleaned up ${cleaned} fix-attempt lesson(s) for ${issue.comment.path}:${issue.comment.line}`);
              }
              
              // Auto-verify duplicates of this canonical issue
              if (duplicateMap) {
                const duplicates = duplicateMap.get(issue.comment.id) || [];
                for (const dupId of duplicates) {
                  if (!Verification.isVerified(stateContext, dupId)) {
                    Verification.markVerified(stateContext, dupId, issue.comment.id);
                    verifiedThisSession.add(dupId);
                    autoVerifiedCount++;
                    debug(`Auto-verified duplicate comment ${dupId} (canonical ${issue.comment.id} was fixed)`);
                  }
                }
              }
            } else {
              failedCount++;
              // Feed verifier's explanation back onto the issue so the NEXT fix prompt
              // shows "VERIFIER DISAGREES — ..." and the fixer targets the exact gap.
              // WHY: Fixer/verifier stalemate (fixer says ALREADY_FIXED, verifier says
              // still exists) persists when the fixer never sees what the verifier cited.
              const contradiction = verification.lesson && verification.lesson !== verification.explanation
                ? `${verification.explanation} Next time: ${verification.lesson}`
                : verification.explanation;
              issue.verifierContradiction = contradiction;
              // WHY track: After N rejections solvability Check 0e dismisses as "exhausted" to stop
              // fixer/verifier stalemates and avoid token waste (see VERIFIER_REJECTION_DISMISS_THRESHOLD).
              const state = getState(stateContext);
              if (!state.verifierRejectionCount) state.verifierRejectionCount = {};
              state.verifierRejectionCount[issue.comment.id] = (state.verifierRejectionCount[issue.comment.id] ?? 0) + 1;
              // Use lesson from batch response (already parsed by batchVerifyFixes).
              const lesson = verification.lesson
                || `Fix rejected: ${verification.explanation}`;
              LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - ${lesson}`);
            }
          } else {
            // No verification result returned for this issue - treat as failed
            // WHY no lesson: "No verification result returned" is a parsing/infra issue,
            // NOT actionable guidance for fixing code. These pollute the lessons list
            // and waste prompt tokens with zero value.
            failedCount++;
            Iterations.addVerificationResult(stateContext, issue.comment.id, {
              passed: false,
              reason: 'No verification result returned by LLM',
            });
          }
        // Review: handles cases with no verification result to ensure consistent error tracking.
        }
      }
    }

  } finally {
    spinner.stop();
  }
  const verifyTime = endTimer('Verify fixes');
  
  // Verification results — show what left (or stayed in) the queue.
  // WHY: This is the counterpart to the QUEUE log. Together they bracket
  // the fix attempt: QUEUE shows what went in, this shows what came out.
  console.log(chalk.gray(`\n  Verified in ${formatDuration(verifyTime)}`));
  
  if (unchangedIssues.length > 0) {
    console.log(chalk.yellow(`  ${formatNumber(unchangedIssues.length)} file(s) not modified - issues marked as failed`));
  }
  
  if (verifiedCount > 0 || autoVerifiedCount > 0 || failedCount > 0) {
    const totalResolved = verifiedCount + autoVerifiedCount;
    if (totalResolved > 0) {
      console.log(chalk.greenBright(`  ┌─ RESOLVED: ${formatNumber(totalResolved)} issue(s) leaving queue ─┐`));
      // Show each verified issue with its file
      for (const issue of changedIssues) {
        if (verifiedThisSession.has(issue.comment.id)) {
          const line = issue.comment.line ? `:${issue.comment.line}` : '';
          console.log(chalk.greenBright(`  │  - ${issue.comment.path}${line} ✓ fixed`));
        }
      }
      if (autoVerifiedCount > 0) {
        console.log(chalk.greenBright(`  │  + ${autoVerifiedCount} duplicate(s) auto-resolved`));
      }
      console.log(chalk.greenBright(`  └${'─'.repeat(40)}┘`));
    }
    
    if (failedCount > 0) {
      console.log(chalk.yellow(`  ○ ${formatNumber(failedCount)} issue(s) still in queue (not fixed)`));
    }
  }

  // Self-corruption detection: if ALL issues on a file failed verification,
  // check whether previous fixer attempts have structurally damaged the file.
  // If corrupted, restore from base branch to give the next iteration a clean slate.
  if (failedCount > 0 && verifiedCount === 0) {
    const failedByFile = new Map<string, number>();
    for (const issue of changedIssues) {
      const path = issue.comment.path;
      failedByFile.set(path, (failedByFile.get(path) || 0) + 1);
    }

    for (const [filePath, count] of failedByFile.entries()) {
      if (count < 2) continue; // Only check files with multiple failed issues
      try {
        const corruption = await detectFileCorruption(git, filePath, 'HEAD');
        if (corruption.corrupted && corruption.baseContent) {
          console.log(chalk.red(`  ⚠ Self-corruption detected in ${filePath}: ${corruption.reason}`));
          console.log(chalk.yellow(`    Restoring from base branch to give next iteration a clean slate...`));
          try {
            await git.checkout(['HEAD', '--', filePath]);
            debug(`Restored corrupted file from HEAD: ${filePath}`);
          } catch {
            debug(`Could not restore ${filePath} from HEAD`);
          }
        }
      } catch {
        // Corruption detection is best-effort
      }
    }
  }

  return { verifiedCount, failedCount, changedIssues, unchangedIssues, changedFiles };
}
