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
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { StateContext } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug } from '../logger.js';

/**
 * Number of issues to spot-check before committing to full verification.
 * WHY: When the fixer claims "already fixed" but made zero changes, it's
 * unlikely ALL issues are actually fixed. Spot-checking a small sample first
 * avoids wasting tokens on a full batch verification of 80+ issues when the
 * claim is bogus (e.g., garbled output or model confusion).
 */
const SPOT_CHECK_SAMPLE_SIZE = 5;

/**
 * Minimum ratio of spot-check issues verified as fixed to proceed with full check.
 * If fewer than this fraction pass, we reject the claim without checking the rest.
 */
const SPOT_CHECK_PASS_THRESHOLD = 0.4; // At least 2 out of 5 must pass

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
    // WHY regex with word boundaries: Single words like 'has'/'exists' match too broadly
    // (e.g. "This has not been resolved", "The file no longer exists").
    // Regex \b boundaries + compound phrases prevent false positives.
    const lowerExplanation = noChangesExplanation.toLowerCase();
    const isAlreadyFixed = /\balready\s+fixed\b/.test(lowerExplanation) ||
                           /\bissue\s+already\b/.test(lowerExplanation) ||
                           /\bno\s+changes?\s+(required|needed|necessary)\b/.test(lowerExplanation) ||
                           /\bno\s+fix\s+needed\b/.test(lowerExplanation) ||
                           /\bnothing\s+to\s+(do|fix|change)\b/.test(lowerExplanation) ||
                           /\bnot\s+reproducible\b/.test(lowerExplanation) ||
                           /\balready\s+(exists?|implemented|addressed|resolved|correct|handled|present)\b/.test(lowerExplanation);

    if (isAlreadyFixed) {
      // Fixer claims issues are already fixed - VERIFY the claim
      console.log(chalk.gray(`  → Fixer believes issues are already addressed - verifying...`));
      
      // SPOT-CHECK: When there are many issues, verify a small sample first.
      // If the sample fails, skip the expensive full verification.
      const needsSpotCheck = unresolvedIssues.length > SPOT_CHECK_SAMPLE_SIZE * 2;
      
      if (needsSpotCheck) {
        debug('Spot-checking NO_CHANGES claim', { total: unresolvedIssues.length, sampleSize: SPOT_CHECK_SAMPLE_SIZE });
        const sample = unresolvedIssues.slice(0, SPOT_CHECK_SAMPLE_SIZE);
        const spotResults = await llm.batchCheckIssuesExist(
          sample.map((issue, idx) => ({
            id: `spot_${idx + 1}`,
            comment: issue.comment.body,
            filePath: issue.comment.path,
            line: issue.comment.line,
            codeSnippet: issue.codeSnippet,
          }))
        );
        
        let spotFixed = 0;
        for (let i = 0; i < sample.length; i++) {
          const result = spotResults.issues.get(`spot_${i + 1}`);
          if (result && !result.exists) spotFixed++;
        }
        
        const passRatio = spotFixed / SPOT_CHECK_SAMPLE_SIZE;
        debug('Spot-check results', { spotFixed, total: SPOT_CHECK_SAMPLE_SIZE, passRatio });
        
        if (passRatio < SPOT_CHECK_PASS_THRESHOLD) {
          console.log(chalk.yellow(`  → Spot-check rejected claim (${spotFixed}/${SPOT_CHECK_SAMPLE_SIZE} verified) - skipping full verification`));
          // Fall through to normal rotation logic
        } else {
          console.log(chalk.gray(`  → Spot-check passed (${spotFixed}/${SPOT_CHECK_SAMPLE_SIZE}) - running full verification...`));
          // Fall through to full verification below
        }
        
        // Only proceed to full verification if spot-check passed
        if (passRatio < SPOT_CHECK_PASS_THRESHOLD) {
          // Skip to rotation — don't waste tokens on the remaining issues
          // (falls through to the end of this block)
        } else {
          // Full verification (spot-check passed)
          const fullResult = await verifyAllIssues(unresolvedIssues, llm, stateContext, runnerName, currentModel, verifiedThisSession);
          if (fullResult) {
            return fullResult;
          }
          // If fullResult is null, no issues were verified — fall through to rotation
        }
      } else {
        // Small number of issues — verify all directly (no spot-check needed)
        const fullResult = await verifyAllIssues(unresolvedIssues, llm, stateContext, runnerName, currentModel, verifiedThisSession);
        if (fullResult) {
          return fullResult;
        }
        // If fullResult is null, no issues were verified — fall through
      }
      
      // Fixer's claim was wrong or spot-check rejected it
      console.log(chalk.yellow(`  → Fixer's claim not verified - issues still exist`));
      // Fall through to normal rotation logic (return with shouldContinue=false)
    } else {
      // Fixer couldn't fix for other reasons (unclear instructions, etc.) - document but don't dismiss
      console.log(chalk.gray(`  → This will be recorded for feedback loop`));
    }
  } else {
    // Fixer made zero changes WITHOUT a parseable explanation.
    // The raw output may still contain useful reasoning (e.g., "the code already
    // handles this" or "I couldn't find the referenced function").
    // Extract the tail of the output which typically has the model's final summary.
    console.log(chalk.yellow(`  Fixer didn't explain why no changes were made`));
    console.log(chalk.gray(`  → Will try different model/tool approach`));

    if (fixerOutput && fixerOutput.length > 100) {
      // Grab the last ~500 chars — models often put their summary at the end
      const tail = fixerOutput.slice(-500).trim();
      // Strip common noise patterns (tool call metadata, file listings)
      const cleaned = tail
        .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/g, '')
        .replace(/\[tool_result\][\s\S]*?\[\/tool_result\]/g, '')
        .trim();

      if (cleaned.length > 30) {
        const preview = cleaned.length > 200 ? cleaned.substring(cleaned.length - 200) : cleaned;
        debug('No-change output tail', { preview });
        LessonsAPI.Add.addGlobalLesson(
          lessonsContext,
          `Fixer made no changes. Output tail: ${preview.replace(/\n/g, ' ').substring(0, 150)}`
        );
      } else {
        LessonsAPI.Add.addGlobalLesson(lessonsContext, 'Fixer made no changes without explanation — trying different approach');
      }
    } else {
      LessonsAPI.Add.addGlobalLesson(lessonsContext, 'Fixer made no changes without explanation — trying different approach');
    }
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

/**
 * Verify all unresolved issues and return result if any were verified.
 * Returns null if none were verified (caller should fall through to rotation).
 */
async function verifyAllIssues(
  unresolvedIssues: UnresolvedIssue[],
  llm: LLMClient,
  stateContext: StateContext,
  runnerName: string,
  currentModel: string | undefined,
  verifiedThisSession: Set<string>
): Promise<{
  shouldBreak: boolean;
  shouldContinue: boolean;
  verifiedCount: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
  progressMade: number;
} | null> {
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
      verifiedAsFixed++;
      Verification.markVerified(stateContext, issue.comment.id);
      verifiedThisSession.add(issue.comment.id);
      console.log(chalk.greenBright(`    ✓ RESOLVED: ${issue.comment.path}:${issue.comment.line} — ${result.explanation}`));
    } else {
      stillUnresolved.push(issue);
      if (result) {
        console.log(chalk.yellow(`    ○ Still exists: ${issue.comment.path}:${issue.comment.line} - ${result.explanation}`));
      }
    }
  }
  
  if (verifiedAsFixed > 0) {
    console.log(chalk.green(`  → Verified ${verifiedAsFixed}/${unresolvedIssues.length} issues as already fixed`));
    Performance.recordModelFix(stateContext, runnerName, currentModel, verifiedAsFixed);
    
    // Update unresolved list
    unresolvedIssues.splice(0, unresolvedIssues.length, ...stillUnresolved);
    
    if (unresolvedIssues.length === 0) {
      console.log(chalk.green('\n✓ All issues verified as already fixed'));
      return {
        shouldBreak: true,
        shouldContinue: false,
        verifiedCount: verifiedAsFixed,
        updatedUnresolvedIssues: unresolvedIssues,
        progressMade: verifiedAsFixed,
      };
    }
    
    // Some verified, some remain - continue with remaining
    return {
      shouldBreak: false,
      shouldContinue: true,
      verifiedCount: verifiedAsFixed,
      updatedUnresolvedIssues: unresolvedIssues,
      progressMade: verifiedAsFixed,
    };
  }
  
  // None verified — return null to signal caller should fall through
  return null;
}
