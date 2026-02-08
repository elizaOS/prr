/**
 * No-changes verification workflow
 * 
 * Handles the case when the fixer runs successfully but makes no changes.
 * Key scenarios:
 * 1. Fixer claims issues are already fixed - verify the claim
 * 2. Fixer couldn't fix for other reasons - document and rotate
 * 3. Fixer made no changes without explanation - rotate to different approach
 */

import chalk from 'chalk';
import type { SimpleGit } from 'simple-git';
import type { UnresolvedIssue } from '../analyzer/types.js';
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

/**
 * Handle no-changes scenario after fixer runs
 * 
 * WHY: When a fixer makes no changes, it could mean:
 * - Issues are already fixed (need to verify)
 * - Fixer couldn't understand the issue (need different approach)
 * - Fixer hit a limitation (need rotation)
 * 
 * WORKFLOW:
 * 1. Parse fixer's explanation for why no changes were made
 * 2. If fixer claims "already fixed", verify each issue with LLM
 * 3. Mark verified issues as fixed and remove from unresolved list
 * 4. Track no-changes for performance stats
 * 5. Return whether to continue, break, or proceed to rotation
 */
export async function handleNoChangesWithVerification(
  unresolvedIssues: UnresolvedIssue[],
  runnerName: string,
  currentModel: string | undefined,
  fixerOutput: string,
  llm: LLMClient,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  verifiedThisSession: Set<string>,
  parseNoChangesExplanation: (output: string) => string | null
): Promise<{
  shouldBreak: boolean;
  shouldContinue: boolean;
  verifiedCount: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
  progressMade: number;
}> {
  console.log(chalk.yellow(`\nNo changes made by ${runnerName}${currentModel ? ` (${currentModel})` : ''}`));

  // Parse fixer output for NO_CHANGES explanation
  const noChangesExplanation = parseNoChangesExplanation(fixerOutput);

  let verifiedCount = 0;
  let progressMade = 0;
  let shouldBreak = false;
  let shouldContinue = false;

  if (noChangesExplanation) {
    // Fixer provided an explanation for why it made no changes
    console.log(chalk.cyan(`  Fixer's explanation: ${noChangesExplanation}`));
    // Note: Don't include tool/model names - that's tracked separately in modelStats
    LessonsAPI.Add.addGlobalLesson(lessonsContext, `Fixer made no changes: ${noChangesExplanation}`);

    // Store this explanation with each issue (but don't necessarily dismiss - depends on the reason)
    const lowerExplanation = noChangesExplanation.toLowerCase();
    const isAlreadyFixed = lowerExplanation.includes('already') ||
                           lowerExplanation.includes('exists') ||
                           lowerExplanation.includes('has') ||
                           lowerExplanation.includes('implements');

    if (isAlreadyFixed) {
      // Fixer claims issues are already fixed - VERIFY the claim
      console.log(chalk.gray(`  → Fixer believes issues are already addressed - verifying...`));
      
      // Run verification on all unresolved issues to check fixer's claim
      const verifyResults = await llm.batchCheckIssuesExist(
        unresolvedIssues.map((issue, idx) => ({
          id: `issue_${idx + 1}`,
          comment: issue.comment.body,
          filePath: issue.comment.path,
          line: issue.comment.line,
          codeSnippet: issue.codeSnippet,
        }))
      );
      
      let verifiedAsFixed = 0;
      const stillUnresolved: typeof unresolvedIssues = [];
      
      for (let i = 0; i < unresolvedIssues.length; i++) {
        const issue = unresolvedIssues[i];
        const result = verifyResults.issues.get(`issue_${i + 1}`);
        
        if (result && !result.exists) {
          // Issue verified as fixed!
          verifiedAsFixed++;
          Verification.markVerified(stateContext, issue.comment.id);
          verifiedThisSession.add(issue.comment.id);
          console.log(chalk.green(`    ✓ Verified: ${issue.comment.path}:${issue.comment.line} - ${result.explanation}`));
        } else {
          // Issue still exists despite fixer's claim
          stillUnresolved.push(issue);
          if (result) {
            console.log(chalk.yellow(`    ○ Still exists: ${issue.comment.path}:${issue.comment.line} - ${result.explanation}`));
          }
        }
      }
      
      if (verifiedAsFixed > 0) {
        console.log(chalk.green(`  → Verified ${verifiedAsFixed}/${unresolvedIssues.length} issues as already fixed`));
        Performance.recordModelFix(stateContext, runnerName, currentModel, verifiedAsFixed);
        progressMade = verifiedAsFixed;
        verifiedCount = verifiedAsFixed;
        
        // Update unresolved list
        unresolvedIssues.splice(0, unresolvedIssues.length, ...stillUnresolved);
        
        if (unresolvedIssues.length === 0) {
          console.log(chalk.green('\n✓ All issues verified as already fixed'));
          shouldBreak = true;
          return {
            shouldBreak,
            shouldContinue: false,
            verifiedCount,
            updatedUnresolvedIssues: unresolvedIssues,
            progressMade,
          };
        }
        
        // Some verified, some remain - continue with remaining
        shouldContinue = true;
        return {
          shouldBreak: false,
          shouldContinue,
          verifiedCount,
          updatedUnresolvedIssues: unresolvedIssues,
          progressMade,
        };
      } else {
        // Fixer's claim was wrong - none actually fixed
        console.log(chalk.yellow(`  → Fixer's claim not verified - issues still exist`));
        // Fall through to normal rotation logic (return with shouldContinue=false)
      }
    } else {
      // Fixer couldn't fix for other reasons (unclear instructions, etc.) - document but don't dismiss
      console.log(chalk.gray(`  → This will be recorded for feedback loop`));
    }
  } else {
    // Fixer made zero changes WITHOUT explaining why
    console.log(chalk.yellow(`  Fixer didn't explain why no changes were made`));
    console.log(chalk.gray(`  → Will try different model/tool approach`));
    // Note: Don't include tool/model - tracked separately in modelStats
    LessonsAPI.Add.addGlobalLesson(lessonsContext, `Fixer made no changes without explanation - trying different approach`);
  }

  // Track no-changes for performance stats
  Performance.recordModelNoChanges(stateContext, runnerName, currentModel);
  
  return {
    shouldBreak: false,
    shouldContinue: false, // Will proceed to rotation strategy
    verifiedCount,
    updatedUnresolvedIssues: unresolvedIssues,
    progressMade,
  };
}
