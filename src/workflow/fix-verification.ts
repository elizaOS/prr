/**
 * Fix verification workflow functions
 * Handles verification of fixes after fixer tool completes
 */

import chalk from 'chalk';
import ora from 'ora';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateContext } from '../state/state-context.js';
import { setPhase } from '../state/state-context.js';
import * as State from '../state/state-core.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import * as Iterations from '../state/state-iterations.js';
import * as Lessons from '../state/state-lessons.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, debugStep, startTimer, endTimer, setTokenPhase, formatDuration } from '../logger.js';
import { getChangedFiles, getDiffForFile } from '../git/git-clone-index.js';

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
  duplicateMap?: Map<string, string[]>
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

  try {
    spinner.start('Verifying fixes...');
    changedFiles = await getChangedFiles(git);
    debug('Changed files', changedFiles);
  
    for (const issue of unresolvedIssues) {
      if (!changedFiles.includes(issue.comment.path)) {
        unchangedIssues.push(issue);
      } else {
        changedIssues.push(issue);
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

      if (noBatch) {
        // Sequential mode - one LLM call per fix
        spinner.text = `Verifying ${changedIssues.length} fixes sequentially...`;
        
        for (let i = 0; i < changedIssues.length; i++) {
          const issue = changedIssues[i];
          spinner.text = `Verifying [${i + 1}/${changedIssues.length}] ${issue.comment.path}:${issue.comment.line || '?'}`;
          
          const diff = await getDiff(issue.comment.path);
          const verification = await llm.verifyFix(
            issue.comment.body,
            issue.comment.path,
            diff
          );

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
            // Analyze failure to generate actionable lesson
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
      } else {
        // Batch mode - one LLM call for all fixes
        const fixesToVerify: Array<{
          id: string;
          comment: string;
          filePath: string;
          diff: string;
        }> = [];

        for (const issue of changedIssues) {
          const diff = await getDiff(issue.comment.path);
          fixesToVerify.push({
            id: issue.comment.id,
            comment: issue.comment.body,
            filePath: issue.comment.path,
            diff,
          });
        }

        spinner.text = `Verifying ${fixesToVerify.length} fixes in batch...`;
        const result = await llm.batchVerifyFixes(fixesToVerify);
        
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
              // Use lesson from batch response (already parsed by batchVerifyFixes).
              // WHY not calling analyzeFailedFix here: batchVerifyFixes already asks
              // the LLM for a LESSON line alongside each NO verdict in the same call.
              // Calling analyzeFailedFix separately was making N extra LLM calls (one
              // per failure), turning a "batch" verify into 1+N sequential calls.
              // With 6 failures out of 12 fixes, that was 7 LLM calls instead of 1.
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
        }
      }
    }

  } finally {
    spinner.stop();
  }
  const verifyTime = endTimer('Verify fixes');
  
  // Log verification results
  console.log(chalk.gray(`\n  Verified in ${formatDuration(verifyTime)}`));
  
  if (unchangedIssues.length > 0) {
    console.log(chalk.yellow(`  ${unchangedIssues.length} file(s) not modified - issues marked as failed`));
  }
  
  if (verifiedCount > 0) {
    console.log(chalk.green(`  ✓ ${verifiedCount} issue(s) verified as fixed`));
  }
  
  if (autoVerifiedCount > 0) {
    console.log(chalk.gray(`  Auto-verified ${autoVerifiedCount} duplicate comment(s)`));
  }
  
  if (failedCount > 0) {
    console.log(chalk.yellow(`  ○ ${failedCount} issue(s) still need attention`));
  }
  
  return { verifiedCount, failedCount, changedIssues, unchangedIssues, changedFiles };
}
