/**
 * Fix verification workflow functions
 * Handles verification of fixes after fixer tool completes
 */

import type { UnresolvedIssue } from '../analyzer/types.js';
import type { SimpleGit } from 'simple-git';
import type { StateManager } from '../state/manager.js';
import type { LessonsManager } from '../state/lessons.js';
import type { LLMClient } from '../llm/client.js';

/**
 * Verify fixes after fixer completes
 * Separates changed/unchanged files, verifies changed files, records results
 */
export async function verifyFixes(
  git: SimpleGit,
  unresolvedIssues: UnresolvedIssue[],
  stateManager: StateManager,
  lessonsManager: LessonsManager,
  llm: LLMClient,
  verifiedThisSession: Set<string>,
  noBatch: boolean
): Promise<{
  verifiedCount: number;
  failedCount: number;
  changedIssues: UnresolvedIssue[];
  unchangedIssues: UnresolvedIssue[];
}> {
  const chalk = require('chalk');
  const { debug, debugStep } = require('../logger.js');
  const { startTimer, endTimer, setTokenPhase } = require('../ui/reporter.js');
  const { getChangedFiles, getDiffForFile } = require('../git/commit.js');
  const ora = require('ora');
  const spinner = ora();
  
  debugStep('VERIFYING FIXES');
  stateManager.setPhase('verifying');
  setTokenPhase('Verify fixes');
  startTimer('Verify fixes');
  spinner.start('Verifying fixes...');
  const changedFiles = await getChangedFiles(git);
  debug('Changed files', changedFiles);
  let verifiedCount = 0;
  let failedCount = 0;

  // Separate issues by whether their file was changed
  const unchangedIssues: typeof unresolvedIssues = [];
  const changedIssues: typeof unresolvedIssues = [];
  
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
    stateManager.addVerificationResult(issue.comment.id, {
      passed: false,
      reason: 'File was not modified',
    });
    stateManager.addDismissedIssue(
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

        stateManager.addVerificationResult(issue.comment.id, {
          passed: verification.fixed,
          reason: verification.explanation,
        });

        debug(`Verification for ${issue.comment.path}:${issue.comment.line}`, verification);
        
        if (verification.fixed) {
          verifiedCount++;
          stateManager.markCommentVerifiedFixed(issue.comment.id);
          stateManager.addCommentToIteration(issue.comment.id);
          verifiedThisSession.add(issue.comment.id);  // Track for session filtering
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
          lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - ${lesson}`);
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
          stateManager.addVerificationResult(issue.comment.id, {
            passed: verification.fixed,
            reason: verification.explanation,
          });

          if (verification.fixed) {
            verifiedCount++;
            stateManager.markCommentVerifiedFixed(issue.comment.id);
            stateManager.addCommentToIteration(issue.comment.id);
            verifiedThisSession.add(issue.comment.id);  // Track for session filtering
          } else {
            failedCount++;
            // In batch mode, we don't analyze failures individually (too expensive)
            // Just record the explanation as a lesson
            lessonsManager.addLesson(`Fix for ${issue.comment.path}:${issue.comment.line} - ${verification.explanation}`);
          }
        }
      }
    }
  }
  
  spinner.stop();
  const verifyTime = endTimer('Verify fixes');
  
  // Log verification results
  console.log(chalk.gray(`\n  Verified in ${require('../ui/reporter.js').formatDuration(verifyTime)}`));
  
  if (unchangedIssues.length > 0) {
    console.log(chalk.yellow(`  ${unchangedIssues.length} file(s) not modified - issues marked as failed`));
  }
  
  if (verifiedCount > 0) {
    console.log(chalk.green(`  ✓ ${verifiedCount} issue(s) verified as fixed`));
  }
  
  if (failedCount > 0) {
    console.log(chalk.yellow(`  ○ ${failedCount} issue(s) still need attention`));
  }
  
  return { verifiedCount, failedCount, changedIssues, unchangedIssues };
}
